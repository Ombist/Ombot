import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { base64ToPublicKey, boxKeyPair, decrypt, encrypt, publicKeyToBase64 } from './boxCrypto.js';
import { writeAuditEvent } from './auditLog.js';
import { loadChatroomKeysSync, saveChatroomKeysSync } from './chatroomStorage.js';
import { generateKeyPairFromSeed, hexToBytes } from './ed25519.js';
import { logger } from './logger.js';
import {
  activeClientConnections,
  capabilityRejectTotal,
  encryptedMessagesTotal,
  metricsText,
  middlewareDisconnectsTotal,
  protocolMismatchTotal,
  relayErrorsTotal,
  replayRejectTotal,
  signatureVerifyFailTotal,
} from './metrics.js';
import { computeSessionKey, middlewareWsUrlForSession } from './sessionKey.js';
import { validateReqSignature } from './securityGuards.js';

const PORT = Number(process.env.PORT) || 8080;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || process.env.PORT || 8080) + 1;
const MIDDLEWARE_WS_URL = process.env.MIDDLEWARE_WS_URL || 'wss://127.0.0.1:8081/ws';
const MIDDLEWARE_AUTH_TOKEN = (process.env.MIDDLEWARE_AUTH_TOKEN || process.env.OMBERS_AUTH_TOKEN || '').trim();
const SEED = process.env.OPENCLAW_MACHINE_SEED || 'ombot-seed';
const MAX_MESSAGE_BYTES = Number(process.env.OPENCLAW_MAX_MESSAGE_BYTES) || 16 * 1024;
const MAX_MSGS_PER_MINUTE = Number(process.env.OPENCLAW_MAX_MSGS_PER_MINUTE) || 120;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.OPENCLAW_SHUTDOWN_TIMEOUT_MS) || 15000;
const REQUIRE_CLIENT_SIGNATURE = process.env.OPENCLAW_REQUIRE_SIGNATURE !== '0';
const SIGNATURE_MAX_AGE_MS = Number(process.env.OPENCLAW_SIGNATURE_MAX_AGE_MS) || 5 * 60 * 1000;
const NONCE_TTL_MS = Number(process.env.OPENCLAW_NONCE_TTL_MS) || 10 * 60 * 1000;
const REQUIRE_MIDDLEWARE_TLS = process.env.OPENCLAW_REQUIRE_MIDDLEWARE_TLS !== '0';
const SERVER_PROTOCOL_VERSION = Number(process.env.OPENCLAW_PROTOCOL_VERSION) || 2;
const MIN_PROTOCOL_VERSION = Number(process.env.OPENCLAW_MIN_PROTOCOL_VERSION) || 2;
const ALLOW_LEGACY_PROTOCOL = process.env.OPENCLAW_ALLOW_LEGACY_PROTOCOL === '1';
const REQUIRED_CAPABILITIES = (process.env.OPENCLAW_REQUIRED_CAPABILITIES || 'signature,replay_guard')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

let middlewareProtocol = 'ws:';
try {
  middlewareProtocol = new URL(MIDDLEWARE_WS_URL).protocol;
} catch (err) {
  logger.error('invalid_middleware_ws_url', { err: err.message, url: MIDDLEWARE_WS_URL });
  process.exit(1);
}
if (REQUIRE_MIDDLEWARE_TLS && middlewareProtocol !== 'wss:') {
  logger.error('middleware_tls_required', { url: MIDDLEWARE_WS_URL });
  process.exit(1);
}

const keyPair = generateKeyPairFromSeed(SEED);
logger.info('ombot_startup', { serverPublicKeyPrefix: keyPair.publicKeyHex.slice(0, 16) });
logger.info('security_posture', {
  middlewareTlsRequired: REQUIRE_MIDDLEWARE_TLS,
  middlewareProtocol,
  signatureRequired: REQUIRE_CLIENT_SIGNATURE,
});

let acceptingNewConnections = true;
const rateWindow = new Map();

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/readyz') {
    const ready = acceptingNewConnections;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready }));
    return;
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(await metricsText());
    return;
  }
  res.writeHead(404);
  res.end('not_found');
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  logger.info('health_server_listening', { healthPort: HEALTH_PORT });
});

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT, path: '/ws' });

wss.on('listening', () => {
  logger.info('ws_server_listening', { port: PORT, path: '/ws' });
});

function allowMessage(clientId) {
  const now = Date.now();
  const current = rateWindow.get(clientId) || [];
  const fresh = current.filter((t) => now - t < 60_000);
  if (fresh.length >= MAX_MSGS_PER_MINUTE) return false;
  fresh.push(now);
  rateWindow.set(clientId, fresh);
  return true;
}

function parseClientMessage(data, clientId) {
  if (data.length > MAX_MESSAGE_BYTES) {
    relayErrorsTotal.inc();
    writeAuditEvent('client_payload_too_large', { clientId, bytes: data.length });
    return null;
  }
  try {
    const raw = data.toString();
    return { raw, json: JSON.parse(raw) };
  } catch (err) {
    relayErrorsTotal.inc();
    logger.warn('client_json_parse_error', { clientId, err: err.message });
    return null;
  }
}

wss.on('connection', (clientWs, req) => {
  if (!acceptingNewConnections) {
    clientWs.close(1013, 'server_draining');
    return;
  }

  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  activeClientConnections.inc();
  writeAuditEvent('client_connected', { clientId });
  let middlewareWs = null;
  let chatroomBoxKeys = null;
  let middlewareSessionKey = null;
  let reconnectAttempt = 0;
  let authRetryWithQuery = false;
  let participantId = 'default';
  let traceId = 'unknown';
  let clientVerifyPublicKey = null;
  let clientProtocolVersion = 1;
  let clientCapabilities = [];
  const seenNonces = new Map();

  clientWs.on('message', (data) => {
    if (!allowMessage(clientId)) {
      relayErrorsTotal.inc();
      writeAuditEvent('client_rate_limited', { clientId });
      clientWs.send(JSON.stringify({ type: 'error', message: 'rate_limited' }));
      return;
    }

    const parsed = parseClientMessage(data, clientId);
    if (!parsed) return;
    const { raw, json } = parsed;

    if (json.type === 'register_public_key' && json.publicKey) {
      const cid = json.conversationId || json.chatroomId;
      traceId = (json.traceId == null ? '' : String(json.traceId).trim()) || `trace-${Date.now()}`;
      participantId = (json.participantId == null ? '' : String(json.participantId).trim()) || 'default';
      if (!Object.prototype.hasOwnProperty.call(json, 'protocolVersion') ||
          !Object.prototype.hasOwnProperty.call(json, 'capabilities')) {
        protocolMismatchTotal.inc();
        writeAuditEvent('register_rejected', { clientId, reason: 'protocol_fields_missing', traceId, participantId });
        clientWs.send(JSON.stringify({ type: 'error', message: 'protocol_fields_missing', traceId }));
        return;
      }
      clientProtocolVersion = Number(json.protocolVersion);
      clientCapabilities = parseCapabilities(json.capabilities);
      clientVerifyPublicKey = safeLoadClientPublicKey(json.publicKey);
      const compat = validateClientCompatibility(clientProtocolVersion, clientCapabilities);
      if (!compat.ok) {
        writeAuditEvent('register_rejected', { clientId, reason: compat.reason, traceId, participantId, clientProtocolVersion });
        clientWs.send(JSON.stringify({ type: 'error', message: compat.reason, traceId }));
        return;
      }
      const hasRoom = cid != null && String(cid).trim() !== '';
      middlewareSessionKey = hasRoom
        ? computeSessionKey(json.agentId || json.appId || null, String(cid).trim(), participantId)
        : null;

      clientWs.send(
        JSON.stringify({
          type: 'registered',
          serverPublicKey: keyPair.publicKeyHex,
          protocolVersion: SERVER_PROTOCOL_VERSION,
          capabilities: REQUIRED_CAPABILITIES,
        })
      );
      writeAuditEvent('client_registered', { clientId, hasRoom, traceId, participantId });
      logger.info('client_registered', { clientId, traceId, participantId, hasRoom });
      connectToMiddleware();
      return;
    }

    if (json.type === 'req' && middlewareWs && middlewareWs.readyState === 1 && chatroomBoxKeys?.peerPublicKey) {
      const guardResult = validateReqSignature({
        reqJson: json,
        verifyPublicKey: clientVerifyPublicKey,
        nonceMap: seenNonces,
        requireSignature: REQUIRE_CLIENT_SIGNATURE,
        signatureMaxAgeMs: SIGNATURE_MAX_AGE_MS,
        nonceTtlMs: NONCE_TTL_MS,
      });
      if (!guardResult.ok) {
        relayErrorsTotal.inc();
        if (guardResult.reason === 'replay') replayRejectTotal.inc();
        else signatureVerifyFailTotal.inc();
        writeAuditEvent('req_rejected', { clientId, reason: guardResult.reason, traceId });
        clientWs.send(JSON.stringify({ type: 'error', message: guardResult.reason, traceId }));
        return;
      }
      const { nonce, payload } = encrypt(raw, chatroomBoxKeys.peerPublicKey, chatroomBoxKeys.secretKey);
      middlewareWs.send(JSON.stringify({ type: 'encrypted', nonce, payload }));
      encryptedMessagesTotal.inc();
    }
  });

  function safeLoadClientPublicKey(publicKeyHex) {
    try {
      const bytes = hexToBytes(String(publicKeyHex || '').trim());
      return bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }

  function parseCapabilities(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((v) => String(v || '').trim())
      .filter(Boolean);
  }

  function validateClientCompatibility(protocolVersion, capabilities) {
    if (!Number.isFinite(protocolVersion) || protocolVersion < MIN_PROTOCOL_VERSION) {
      protocolMismatchTotal.inc();
      return { ok: false, reason: 'protocol_too_old' };
    }
    if (!ALLOW_LEGACY_PROTOCOL && protocolVersion < SERVER_PROTOCOL_VERSION) {
      protocolMismatchTotal.inc();
      return { ok: false, reason: 'protocol_legacy_disallowed' };
    }
    for (const needed of REQUIRED_CAPABILITIES) {
      if (!capabilities.includes(needed)) {
        capabilityRejectTotal.inc();
        return { ok: false, reason: `capability_missing:${needed}` };
      }
    }
    return { ok: true };
  }

  function getOrCreateChatroomKeys(aid, roomId, pid = 'default') {
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
    return { publicKey: newPair.publicKey, secretKey: newPair.secretKey, peerPublicKey: null, peerPublicKeys: {} };
  }

  function middlewareUrlWithOptionalQuery(baseUrl) {
    const url = middlewareWsUrlForSession(MIDDLEWARE_WS_URL, middlewareSessionKey);
    if (!authRetryWithQuery || !MIDDLEWARE_AUTH_TOKEN) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(MIDDLEWARE_AUTH_TOKEN)}`;
  }

  function connectToMiddleware() {
    if (middlewareWs || clientWs.readyState !== 1) return;
    const url = middlewareUrlWithOptionalQuery(MIDDLEWARE_WS_URL);
    const wsOpts = MIDDLEWARE_AUTH_TOKEN && !authRetryWithQuery
      ? { headers: { Authorization: `Bearer ${MIDDLEWARE_AUTH_TOKEN}` } }
      : undefined;
    middlewareWs = wsOpts ? new WebSocket(url, wsOpts) : new WebSocket(url);

    middlewareWs.on('open', () => {
      reconnectAttempt = 0;
      logger.info('middleware_connected', { clientId, url, traceId, participantId });
    });

    middlewareWs.on('message', (data) => {
      try {
        if (data.length > MAX_MESSAGE_BYTES) {
          relayErrorsTotal.inc();
          return;
        }
        const raw = data.toString();
        const json = JSON.parse(raw);

        if (json.type === 'register_public_key' && (json.boxPublicKey || json.publicKey)) {
          const aid = json.agentId || json.appId || 'default';
          const roomId = json.conversationId || json.chatroomId || 'default';
          const pid = (json.participantId == null ? '' : String(json.participantId).trim()) || 'default';
          chatroomBoxKeys = getOrCreateChatroomKeys(aid, roomId, pid);
          chatroomBoxKeys.peerPublicKey = base64ToPublicKey(json.boxPublicKey || json.publicKey);
          saveChatroomKeysSync(
            aid,
            roomId,
            publicKeyToBase64(chatroomBoxKeys.publicKey),
            Buffer.from(chatroomBoxKeys.secretKey).toString('base64'),
            json.boxPublicKey || json.publicKey,
            pid,
            chatroomBoxKeys.peerPublicKeys
          );
          writeAuditEvent('peer_key_updated', { agentId: aid, roomId, traceId, participantId: pid });
          middlewareWs.send(JSON.stringify({ type: 'peer_public_key', publicKey: publicKeyToBase64(chatroomBoxKeys.publicKey) }));
          return;
        }

        if (json.type === 'encrypted' && json.nonce && json.payload && chatroomBoxKeys?.peerPublicKey) {
          const plain = decrypt(json.nonce, json.payload, chatroomBoxKeys.peerPublicKey, chatroomBoxKeys.secretKey);
          if (plain && clientWs.readyState === 1) clientWs.send(plain);
        }
      } catch (err) {
        relayErrorsTotal.inc();
        logger.error('relay_to_client_error', { clientId, err: err.message });
      }
    });

    middlewareWs.on('close', () => {
      middlewareDisconnectsTotal.inc();
      middlewareWs = null;
      chatroomBoxKeys = null;
      if (clientWs.readyState === 1) {
        if (!authRetryWithQuery && MIDDLEWARE_AUTH_TOKEN) {
          authRetryWithQuery = true;
          connectToMiddleware();
          return;
        }
        const errMsg = authRetryWithQuery && MIDDLEWARE_AUTH_TOKEN
          ? 'auth_failed'
          : 'middleware_disconnected';
        clientWs.send(JSON.stringify({ type: 'error', message: errMsg, traceId }));
        reconnectAttempt++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
        setTimeout(connectToMiddleware, delay);
      }
    });

    middlewareWs.on('error', (err) => {
      relayErrorsTotal.inc();
      logger.error('middleware_ws_error', { clientId, err: err.message, traceId, participantId });
    });
  }

  clientWs.on('close', () => {
    activeClientConnections.dec();
    rateWindow.delete(clientId);
    if (middlewareWs && middlewareWs.readyState <= 1) middlewareWs.close();
    writeAuditEvent('client_disconnected', { clientId });
  });

  clientWs.on('error', (err) => {
    relayErrorsTotal.inc();
    logger.error('client_ws_error', { clientId, err: err.message });
  });
});

wss.on('error', (err) => {
  relayErrorsTotal.inc();
  logger.error('ws_server_error', { err: err.message });
});

function gracefulShutdown(signal) {
  logger.warn('shutdown_start', { signal });
  acceptingNewConnections = false;
  for (const ws of wss.clients) {
    ws.close(1001, 'server_shutdown');
  }

  const timeout = setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  healthServer.close(() => {
    wss.close(() => {
      logger.info('shutdown_complete');
      clearTimeout(timeout);
      process.exit(0);
    });
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => gracefulShutdown(sig));
}
