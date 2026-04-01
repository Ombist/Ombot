import { WebSocket } from 'ws';
import { base64ToPublicKey, boxKeyPair, decrypt, encrypt, publicKeyToBase64 } from './boxCrypto.js';
import { writeAuditEvent } from './auditLog.js';
import { loadChatroomKeysSync, saveChatroomKeysSync } from './chatroomStorage.js';
import { hexToBytes } from './ed25519.js';
import { logger } from './logger.js';
import {
  capabilityRejectTotal,
  encryptedMessagesTotal,
  middlewareDisconnectsTotal,
  protocolMismatchTotal,
  relayErrorsTotal,
  replayRejectTotal,
  signatureVerifyFailTotal,
} from './metrics.js';
import { computeSessionKey, middlewareWsUrlForSession } from './sessionKey.js';
import { validateReqSignature } from './securityGuards.js';

/**
 * One Machine-side relay: optional local ClawChat client WebSocket + outbound middleware + NaCl box to Phone.
 * Bridge mode: no clientWs; middleware connects immediately after startBridgeSession(); plaintext to Gateway via callback.
 */
export class MachineRelaySession {
  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {import('ws').WebSocket | null} opts.clientWs
   * @param {{ publicKeyHex: string }} opts.keyPair server Ed25519 (register response)
   * @param {object} opts.config
   * @param {boolean} [opts.bridgeMode]
   * @param {(plainUtf8: string) => void} [opts.onDecryptedPlaintextToConsumer]
   * @param {() => void} [opts.onMiddlewareDisconnected]
   */
  constructor(opts) {
    this.clientId = opts.clientId;
    this.clientWs = opts.clientWs;
    this.keyPair = opts.keyPair;
    this.config = opts.config;
    this.bridgeMode = Boolean(opts.bridgeMode);
    this.onDecryptedPlaintextToConsumer = opts.onDecryptedPlaintextToConsumer || null;
    this.onMiddlewareDisconnected = opts.onMiddlewareDisconnected || null;

    this.middlewareWs = null;
    this.chatroomBoxKeys = null;
    this.middlewareSessionKey = null;
    this.reconnectAttempt = 0;
    this.authRetryWithQuery = false;
    this.participantId = 'default';
    this.traceId = 'unknown';
    this.clientVerifyPublicKey = null;
    this.clientProtocolVersion = 1;
    this.clientCapabilities = [];
    /** @type {Map<string, number>} */
    this.seenNonces = new Map();
    this._reconnectTimer = null;
    this._destroyed = false;
  }

  destroy() {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.middlewareWs && this.middlewareWs.readyState <= 1) {
      try {
        this.middlewareWs.close();
      } catch {
        /* ignore */
      }
    }
    this.middlewareWs = null;
    this.chatroomBoxKeys = null;
  }

  isClientConnected() {
    if (this.bridgeMode) return !this._destroyed;
    return Boolean(this.clientWs && this.clientWs.readyState === 1);
  }

  notifyClientJson(obj) {
    if (this.clientWs?.readyState === 1) {
      this.clientWs.send(JSON.stringify(obj));
    }
  }

  deliverPlaintextToConsumer(plain) {
    if (this.clientWs?.readyState === 1) {
      this.clientWs.send(plain);
    } else if (this.onDecryptedPlaintextToConsumer) {
      this.onDecryptedPlaintextToConsumer(plain);
    }
  }

  /**
   * Bridge-only: connect to middleware using sessionKey from (agentId, conversationId, participantId).
   */
  startBridgeSession({ agentId, conversationId, participantId }) {
    this.traceId = 'ombot-bridge';
    this.participantId = participantId || 'default';
    const aid = agentId == null || String(agentId).trim() === '' ? null : String(agentId).trim();
    const cid = String(conversationId || 'default').trim();
    this.middlewareSessionKey = computeSessionKey(aid, cid, this.participantId);
    logger.info('bridge_session_start', {
      clientId: this.clientId,
      traceId: this.traceId,
      participantId: this.participantId,
    });
    this.connectToMiddleware();
  }

  /**
   * After successful register_public_key from local client.
   * @param {object} json register body
   */
  completeRegisterAndConnectMiddleware(json) {
    const cid = json.conversationId || json.chatroomId;
    const hasRoom = cid != null && String(cid).trim() !== '';
    this.middlewareSessionKey = hasRoom
      ? computeSessionKey(json.agentId || json.appId || null, String(cid).trim(), this.participantId)
      : null;

    this.notifyClientJson({
      type: 'registered',
      serverPublicKey: this.keyPair.publicKeyHex,
      protocolVersion: this.config.SERVER_PROTOCOL_VERSION,
      capabilities: this.config.REQUIRED_CAPABILITIES,
    });
    writeAuditEvent('client_registered', {
      clientId: this.clientId,
      hasRoom,
      traceId: this.traceId,
      participantId: this.participantId,
    });
    logger.info('client_registered', {
      clientId: this.clientId,
      traceId: this.traceId,
      participantId: this.participantId,
      hasRoom,
    });
    this.connectToMiddleware();
  }

  /**
   * @param {object} json register_public_key payload
   * @returns {{ ok: true } | { ok: false, response: object }}
   */
  validateAndPrepareRegister(json) {
    this.traceId =
      (json.traceId == null ? '' : String(json.traceId).trim()) || `trace-${Date.now()}`;
    this.participantId =
      (json.participantId == null ? '' : String(json.participantId).trim()) || 'default';
    if (
      !Object.prototype.hasOwnProperty.call(json, 'protocolVersion') ||
      !Object.prototype.hasOwnProperty.call(json, 'capabilities')
    ) {
      protocolMismatchTotal.inc();
      writeAuditEvent('register_rejected', {
        clientId: this.clientId,
        reason: 'protocol_fields_missing',
        traceId: this.traceId,
        participantId: this.participantId,
      });
      return {
        ok: false,
        response: { type: 'error', message: 'protocol_fields_missing', traceId: this.traceId },
      };
    }
    this.clientProtocolVersion = Number(json.protocolVersion);
    this.clientCapabilities = MachineRelaySession.parseCapabilities(json.capabilities);
    this.clientVerifyPublicKey = MachineRelaySession.safeLoadClientPublicKey(json.publicKey);
    const compat = this.validateClientCompatibility(
      this.clientProtocolVersion,
      this.clientCapabilities
    );
    if (!compat.ok) {
      writeAuditEvent('register_rejected', {
        clientId: this.clientId,
        reason: compat.reason,
        traceId: this.traceId,
        participantId: this.participantId,
        clientProtocolVersion: this.clientProtocolVersion,
      });
      return { ok: false, response: { type: 'error', message: compat.reason, traceId: this.traceId } };
    }
    return { ok: true };
  }

  /**
   * Encrypt signed client req and send to middleware (local ClawChat client path).
   */
  relaySignedReqToMiddleware(raw, json) {
    if (
      json.type !== 'req' ||
      !this.middlewareWs ||
      this.middlewareWs.readyState !== 1 ||
      !this.chatroomBoxKeys?.peerPublicKey
    ) {
      return false;
    }
    const guardResult = validateReqSignature({
      reqJson: json,
      verifyPublicKey: this.clientVerifyPublicKey,
      nonceMap: this.seenNonces,
      requireSignature: this.config.REQUIRE_CLIENT_SIGNATURE,
      signatureMaxAgeMs: this.config.SIGNATURE_MAX_AGE_MS,
      nonceTtlMs: this.config.NONCE_TTL_MS,
    });
    if (!guardResult.ok) {
      relayErrorsTotal.inc();
      if (guardResult.reason === 'replay') replayRejectTotal.inc();
      else signatureVerifyFailTotal.inc();
      writeAuditEvent('req_rejected', {
        clientId: this.clientId,
        reason: guardResult.reason,
        traceId: this.traceId,
      });
      this.notifyClientJson({ type: 'error', message: guardResult.reason, traceId: this.traceId });
      return true;
    }
    const { nonce, payload } = encrypt(
      raw,
      this.chatroomBoxKeys.peerPublicKey,
      this.chatroomBoxKeys.secretKey
    );
    this.middlewareWs.send(JSON.stringify({ type: 'encrypted', nonce, payload }));
    encryptedMessagesTotal.inc();
    return true;
  }

  /**
   * Send plaintext JSON string to Phone (box encrypt). Used by OpenClaw bridge for assistant replies.
   */
  sendPlaintextToPhone(plainUtf8) {
    if (
      !this.middlewareWs ||
      this.middlewareWs.readyState !== 1 ||
      !this.chatroomBoxKeys?.peerPublicKey
    ) {
      return false;
    }
    const { nonce, payload } = encrypt(
      plainUtf8,
      this.chatroomBoxKeys.peerPublicKey,
      this.chatroomBoxKeys.secretKey
    );
    this.middlewareWs.send(JSON.stringify({ type: 'encrypted', nonce, payload }));
    encryptedMessagesTotal.inc();
    return true;
  }

  static safeLoadClientPublicKey(publicKeyHex) {
    try {
      const bytes = hexToBytes(String(publicKeyHex || '').trim());
      return bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }

  static parseCapabilities(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((v) => String(v || '').trim())
      .filter(Boolean);
  }

  validateClientCompatibility(protocolVersion, capabilities) {
    if (!Number.isFinite(protocolVersion) || protocolVersion < this.config.MIN_PROTOCOL_VERSION) {
      protocolMismatchTotal.inc();
      return { ok: false, reason: 'protocol_too_old' };
    }
    if (!this.config.ALLOW_LEGACY_PROTOCOL && protocolVersion < this.config.SERVER_PROTOCOL_VERSION) {
      protocolMismatchTotal.inc();
      return { ok: false, reason: 'protocol_legacy_disallowed' };
    }
    for (const needed of this.config.REQUIRED_CAPABILITIES) {
      if (!capabilities.includes(needed)) {
        capabilityRejectTotal.inc();
        return { ok: false, reason: `capability_missing:${needed}` };
      }
    }
    return { ok: true };
  }

  getOrCreateChatroomKeys(aid, roomId, pid = 'default') {
    const loaded = loadChatroomKeysSync(aid, roomId, pid);
    if (loaded) {
      return {
        publicKey: loaded.publicKey,
        secretKey: loaded.secretKey,
        peerPublicKey: loaded.peerPublicKeyBase64 ? base64ToPublicKey(loaded.peerPublicKeyBase64) : null,
        peerPublicKeys: loaded.peerPublicKeys || {},
      };
    }
    const newPair = boxKeyPair();
    saveChatroomKeysSync(
      aid,
      roomId,
      publicKeyToBase64(newPair.publicKey),
      Buffer.from(newPair.secretKey).toString('base64'),
      null,
      pid
    );
    writeAuditEvent('chatroom_key_created', { agentId: aid, roomId });
    return {
      publicKey: newPair.publicKey,
      secretKey: newPair.secretKey,
      peerPublicKey: null,
      peerPublicKeys: {},
    };
  }

  middlewareUrlWithOptionalQuery() {
    const url = middlewareWsUrlForSession(
      this.config.MIDDLEWARE_WS_URL,
      this.middlewareSessionKey
    );
    if (!this.authRetryWithQuery || !this.config.MIDDLEWARE_AUTH_TOKEN) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(this.config.MIDDLEWARE_AUTH_TOKEN)}`;
  }

  connectToMiddleware() {
    if (this._destroyed) return;
    if (this.middlewareWs || !this.isClientConnected()) return;
    const url = this.middlewareUrlWithOptionalQuery();
    const token = this.config.MIDDLEWARE_AUTH_TOKEN;
    const wsOpts =
      token && !this.authRetryWithQuery
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined;
    this.middlewareWs = wsOpts ? new WebSocket(url, wsOpts) : new WebSocket(url);

    this.middlewareWs.on('open', () => {
      this.reconnectAttempt = 0;
      logger.info('middleware_connected', {
        clientId: this.clientId,
        url,
        traceId: this.traceId,
        participantId: this.participantId,
      });
    });

    this.middlewareWs.on('message', (data) => {
      try {
        if (data.length > this.config.MAX_MESSAGE_BYTES) {
          relayErrorsTotal.inc();
          return;
        }
        const raw = data.toString();
        const json = JSON.parse(raw);

        if (json.type === 'register_public_key' && (json.boxPublicKey || json.publicKey)) {
          const aid = json.agentId || json.appId || 'default';
          const roomId = json.conversationId || json.chatroomId || 'default';
          const pid =
            (json.participantId == null ? '' : String(json.participantId).trim()) || 'default';
          this.chatroomBoxKeys = this.getOrCreateChatroomKeys(aid, roomId, pid);
          this.chatroomBoxKeys.peerPublicKey = base64ToPublicKey(json.boxPublicKey || json.publicKey);
          saveChatroomKeysSync(
            aid,
            roomId,
            publicKeyToBase64(this.chatroomBoxKeys.publicKey),
            Buffer.from(this.chatroomBoxKeys.secretKey).toString('base64'),
            json.boxPublicKey || json.publicKey,
            pid,
            this.chatroomBoxKeys.peerPublicKeys
          );
          writeAuditEvent('peer_key_updated', {
            agentId: aid,
            roomId,
            traceId: this.traceId,
            participantId: pid,
          });
          this.middlewareWs.send(
            JSON.stringify({
              type: 'peer_public_key',
              publicKey: publicKeyToBase64(this.chatroomBoxKeys.publicKey),
            })
          );
          return;
        }

        if (json.type === 'encrypted' && json.nonce && json.payload && this.chatroomBoxKeys?.peerPublicKey) {
          const plain = decrypt(
            json.nonce,
            json.payload,
            this.chatroomBoxKeys.peerPublicKey,
            this.chatroomBoxKeys.secretKey
          );
          if (plain) this.deliverPlaintextToConsumer(plain);
        }
      } catch (err) {
        relayErrorsTotal.inc();
        logger.error('relay_to_client_error', { clientId: this.clientId, err: err.message });
      }
    });

    this.middlewareWs.on('close', () => {
      middlewareDisconnectsTotal.inc();
      this.middlewareWs = null;
      this.chatroomBoxKeys = null;
      if (this.onMiddlewareDisconnected) {
        try {
          this.onMiddlewareDisconnected();
        } catch (e) {
          logger.error('onMiddlewareDisconnected_error', { err: e.message });
        }
      }
      if (!this.isClientConnected()) return;

      if (!this.authRetryWithQuery && this.config.MIDDLEWARE_AUTH_TOKEN) {
        this.authRetryWithQuery = true;
        this.connectToMiddleware();
        return;
      }
      const errMsg =
        this.authRetryWithQuery && this.config.MIDDLEWARE_AUTH_TOKEN
          ? 'auth_failed'
          : 'middleware_disconnected';
      this.notifyClientJson({ type: 'error', message: errMsg, traceId: this.traceId });
      this.reconnectAttempt++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connectToMiddleware();
      }, delay);
    });

    this.middlewareWs.on('error', (err) => {
      relayErrorsTotal.inc();
      logger.error('middleware_ws_error', {
        clientId: this.clientId,
        err: err.message,
        traceId: this.traceId,
        participantId: this.participantId,
      });
    });
  }
}
