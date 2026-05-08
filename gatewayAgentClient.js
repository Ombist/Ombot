import { WebSocket } from 'ws';
import { logger } from './logger.js';
import {
  gatewayBridgeErrorsTotal,
  gatewayBridgeFallbackTotal,
  gatewayBridgeGateState,
  gatewayBridgeRejectTotal,
} from './metrics.js';
import { classifyGatewayError } from './gatewayErrorClassifier.js';
import { ProviderFallbackClient } from './providerFallbackClient.js';

/** Duplicated from openclawGatewayBridge.js to avoid circular imports. */
function extractAssistantTextFromGateway(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'res' && msg.ok === false) {
    const err = msg.error && typeof msg.error === 'object' ? msg.error.message || msg.error.code : msg.error;
    return err != null ? `[error] ${String(err)}` : '[error]';
  }
  const p = msg.payload;
  if (p && typeof p === 'object') {
    if (p.text != null) return String(p.text);
    if (p.message != null) return String(p.message);
    if (p.content != null) return String(p.content);
  }
  if (typeof p === 'string') return p;
  if (msg.text != null) return String(msg.text);
  return null;
}

function makeReqId() {
  return `ombot-sc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultGatewayScopes() {
  const REQUIRED = ['operator.read', 'operator.write'];
  const parseScopes = (raw) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
    } catch {
      /* fall through */
    }
    // Tolerate EnvironmentFile values like: [operator.read,operator.write]
    const t = raw.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      const items = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    return null;
  };
  const normalize = (scopes) => {
    const out = [];
    const seen = new Set();
    for (const s of scopes) {
      if (typeof s !== 'string') continue;
      const scope = s.trim();
      if (!scope) continue;
      const canonical = scope.replace(/^operater\./, 'operator.');
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }

    // Always enforce minimal scopes required by agent requests.
    for (const required of REQUIRED) {
      if (!seen.has(required)) {
        seen.add(required);
        out.push(required);
      }
    }
    return out;
  };

  const raw = (process.env.OPENCLAW_BRIDGE_OPERATOR_SCOPES || '').trim();
  if (raw) {
    const parsed = parseScopes(raw);
    if (parsed) {
      return normalize(parsed);
    }
  }
  return normalize(['operator.read', 'operator.write', 'operator.admin']);
}

function defaultBridgeClientPlatform() {
  const raw = (process.env.OPENCLAW_BRIDGE_CLIENT_PLATFORM || '').trim().toLowerCase();
  if (raw) return raw;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function defaultBridgeClientMode() {
  const raw = (process.env.OPENCLAW_BRIDGE_CLIENT_MODE || '').trim().toLowerCase();
  return raw || 'service';
}

function defaultBridgeClientId() {
  const raw = (process.env.OPENCLAW_BRIDGE_CLIENT_ID || '').trim();
  return raw || 'openclaw';
}

function defaultGatewayRole() {
  const raw = (process.env.OPENCLAW_BRIDGE_ROLE || '').trim().toLowerCase();
  // Keep role strict for gateways that only accept "operator".
  if (!raw || raw === 'admin') return 'operator';
  return raw;
}

/**
 * Outbound OpenClaw gateway WebSocket for single-client mode (no Ombers).
 * Mirrors the connect / agent handshake shape from openclawGatewayBridge.js.
 */
export class GatewayAgentClient {
  /**
   * @param {object} opts
   * @param {string} opts.gatewayUrl
   * @param {string} opts.gatewayToken
   * @param {string} [opts.agentMethod]
   * @param {(text: string) => void} opts.onAssistantText
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.gatewayUrl = opts.gatewayUrl;
    this.gatewayToken = opts.gatewayToken || '';
    this.agentMethod = (opts.agentMethod || 'agent').trim();
    this.onAssistantText = opts.onAssistantText;
    this.onError = opts.onError || (() => {});

    /** @type {WebSocket | null} */
    this.gatewayWs = null;
    this._connecting = false;
    this._destroyed = false;
    this._gatewayConnected = false;
    this._reconnectTimer = null;
    /** @type {Map<string, (msg: object) => void>} */
    this._pending = new Map();
    this._inFlight = false;
    /** @type {Array<{ text: string, agentId: string }>} */
    this._queue = [];
    this._strictPairingProfile = process.env.OPENCLAW_STRICT_PAIRING_PROFILE !== '0';
    this._autoFallbackEnabled = ['1', 'true', 'yes'].includes(
      String(process.env.OPENCLAW_BRIDGE_AUTO_FALLBACK || '')
        .trim()
        .toLowerCase()
    ) && !this._strictPairingProfile;
    this._fallbackClient = this._autoFallbackEnabled ? new ProviderFallbackClient() : null;
    this._degradedReason = '';
    gatewayBridgeGateState.labels('pairing').set(-1);
    gatewayBridgeGateState.labels('scope').set(-1);
    gatewayBridgeGateState.labels('provider').set(
      this._fallbackClient && this._fallbackClient.isConfigured() ? 1 : -1
    );
  }

  destroy() {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.gatewayWs && this.gatewayWs.readyState <= 1) {
      try {
        this.gatewayWs.close();
      } catch {
        /* ignore */
      }
    }
    this.gatewayWs = null;
    this._gatewayConnected = false;
    this._pending.clear();
    this._queue.length = 0;
  }

  isReady() {
    return Boolean(this.gatewayWs && this.gatewayWs.readyState === 1 && this._gatewayConnected);
  }

  enqueueAgentTurn(userText, agentId) {
    const aid = (agentId == null || String(agentId).trim() === '' ? 'default' : String(agentId).trim());
    this._queue.push({ text: userText, agentId: aid });
    this._drainQueue();
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    const delay = Math.min(30_000, 2000 + Math.random() * 1000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._destroyed && !this.gatewayWs) this._connect();
    }, delay);
  }

  _recordReject(phase, errorLike) {
    const classified = classifyGatewayError(errorLike);
    gatewayBridgeRejectTotal.labels(phase, classified.category, classified.reason).inc();
    this._degradedReason = `${phase}:${classified.reason}`;
    if (classified.category === 'pairing') gatewayBridgeGateState.labels('pairing').set(0);
    if (classified.category === 'scope') gatewayBridgeGateState.labels('scope').set(0);
    if (classified.category === 'provider') gatewayBridgeGateState.labels('provider').set(0);
    return classified;
  }

  _extractConnectChallenge(msg) {
    const fromPayload = msg?.payload?.challenge;
    if (fromPayload && typeof fromPayload === 'object' && String(fromPayload.nonce || '').trim()) {
      return fromPayload;
    }
    const fromError = msg?.error?.details?.challenge;
    if (fromError && typeof fromError === 'object' && String(fromError.nonce || '').trim()) {
      return fromError;
    }
    return null;
  }

  _isScopeGrantedOnConnect(msg) {
    const granted = Array.isArray(msg?.payload?.grantedScopes) ? msg.payload.grantedScopes : [];
    if (granted.length === 0) return true;
    const normalized = granted
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim().toLowerCase());
    return normalized.includes('operator.write');
  }

  _sendConnectChallengeResponse(challenge) {
    if (!this.gatewayWs || this.gatewayWs.readyState !== 1) return;
    const id = makeReqId();
    const frame = {
      type: 'req',
      id,
      method: 'connect.challenge',
      params: {
        nonce: String(challenge?.nonce || '').trim(),
        timestamp: Date.now(),
        response: {
          mode: 'service',
          clientId: defaultBridgeClientId(),
          platform: defaultBridgeClientPlatform(),
          tokenPresent: Boolean(this.gatewayToken),
        },
      },
    };
    this._pending.set(id, (msg) => {
      if (msg && msg.ok === true) {
        if (!this._isScopeGrantedOnConnect(msg)) {
          gatewayBridgeErrorsTotal.inc();
          this._recordReject('connect', { code: 'SCOPE_DENIED', message: 'operator.write not granted' });
          try {
            this.gatewayWs?.close();
          } catch {
            /* ignore */
          }
          return;
        }
        this._gatewayConnected = true;
        gatewayBridgeGateState.labels('pairing').set(1);
        gatewayBridgeGateState.labels('scope').set(1);
        logger.info('single_client_gateway_connected_after_challenge', { id });
        this._drainQueue();
      } else {
        gatewayBridgeErrorsTotal.inc();
        this._recordReject('connect_challenge', msg?.error ?? msg);
        logger.error('single_client_gateway_connect_challenge_rejected', {
          id,
          error: msg?.error,
        });
        try {
          this.gatewayWs?.close();
        } catch {
          /* ignore */
        }
      }
    });
    this.gatewayWs.send(JSON.stringify(frame));
  }

  async _tryFallback(text, reason) {
    if (!this._fallbackClient || !this._fallbackClient.isConfigured()) return false;
    try {
      const out = await this._fallbackClient.completeUserTurn(text);
      if (!out) return false;
      gatewayBridgeFallbackTotal.labels('provider', reason || 'unknown').inc();
      gatewayBridgeGateState.labels('provider').set(1);
      this.onAssistantText(out);
      return true;
    } catch (err) {
      const c = classifyGatewayError(err?.message || String(err));
      if (c.category === 'provider') gatewayBridgeGateState.labels('provider').set(0);
      gatewayBridgeErrorsTotal.inc();
      logger.error('single_client_gateway_fallback_failed', {
        err: err?.message || String(err),
        reason,
      });
      return false;
    }
  }

  _connect() {
    if (this._destroyed || this._connecting || this.gatewayWs) return;
    this._connecting = true;
    try {
      this.gatewayWs = new WebSocket(this.gatewayUrl);
    } catch (err) {
      this._connecting = false;
      logger.error('single_client_gateway_ws_create_failed', { err: err.message });
      this._scheduleReconnect();
      return;
    }

    this.gatewayWs.on('open', () => {
      this._connecting = false;
      this._sendConnectHandshake();
    });

    this.gatewayWs.on('message', (data) => {
      this._onGatewayMessage(data);
    });

    this.gatewayWs.on('close', () => {
      this._connecting = false;
      this._gatewayConnected = false;
      this.gatewayWs = null;
      if (!this._destroyed) this._scheduleReconnect();
    });

    this.gatewayWs.on('error', (err) => {
      gatewayBridgeErrorsTotal.inc();
      logger.error('single_client_gateway_ws_error', { err: err.message });
      try {
        this.onError(err);
      } catch {
        /* ignore */
      }
    });
  }

  ensureConnected() {
    if (this._destroyed) return;
    if (!this.gatewayWs || this.gatewayWs.readyState === 3) this._connect();
  }

  _sendConnectHandshake() {
    if (!this.gatewayWs || this.gatewayWs.readyState !== 1) return;
    const id = makeReqId();
    const params = {
      minProtocol: Number(process.env.OPENCLAW_BRIDGE_MIN_PROTOCOL || 1),
      maxProtocol: Number(process.env.OPENCLAW_BRIDGE_MAX_PROTOCOL || 9),
      client: {
        id: defaultBridgeClientId(),
        version: process.env.npm_package_version || '1.0.0',
        platform: defaultBridgeClientPlatform(),
        mode: defaultBridgeClientMode(),
      },
      role: defaultGatewayRole(),
      scopes: defaultGatewayScopes(),
    };
    if (this.gatewayToken) {
      params.auth = { token: this.gatewayToken };
    }
    const frame = {
      type: 'req',
      id,
      method: 'connect',
      params,
    };
    this._pending.set(id, (msg) => {
      const challenge = this._extractConnectChallenge(msg);
      if (challenge) {
        this._sendConnectChallengeResponse(challenge);
        return;
      }
      if (msg && msg.ok === true) {
        if (!this._isScopeGrantedOnConnect(msg)) {
          gatewayBridgeErrorsTotal.inc();
          this._recordReject('connect', {
            code: 'SCOPE_DENIED',
            message: 'operator.write not granted',
          });
          try {
            this.gatewayWs?.close();
          } catch {
            /* ignore */
          }
          return;
        }
        this._gatewayConnected = true;
        gatewayBridgeGateState.labels('pairing').set(1);
        gatewayBridgeGateState.labels('scope').set(1);
        logger.info('single_client_gateway_connected', { id });
        this._drainQueue();
      } else {
        gatewayBridgeErrorsTotal.inc();
        this._recordReject('connect', msg?.error ?? msg);
        logger.error('single_client_gateway_connect_rejected', { id, error: msg?.error });
        try {
          this.onError(new Error(`gateway_connect_rejected:${JSON.stringify(msg?.error ?? msg)}`));
        } catch {
          /* ignore */
        }
        try {
          this.gatewayWs?.close();
        } catch {
          /* ignore */
        }
      }
    });
    this.gatewayWs.send(JSON.stringify(frame));
  }

  /**
   * @param {import('ws').RawData} data
   */
  _onGatewayMessage(data) {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);
      if (msg.type === 'res' && msg.id) {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending(msg);
          return;
        }
      }
      if (msg.type === 'event') {
        const t =
          extractAssistantTextFromGateway({ type: 'res', ok: true, payload: msg.payload }) ??
          extractAssistantTextFromGateway(msg);
        if (t) this.onAssistantText(t);
        return;
      }
      if (msg.type === 'res') {
        const t = extractAssistantTextFromGateway(msg);
        if (t) this.onAssistantText(t);
      }
    } catch (err) {
      logger.error('single_client_gateway_parse_error', { err: err.message });
    }
  }

  async _drainQueue() {
    if (this._inFlight) {
      return;
    }
    const canSendGateway =
      this._gatewayConnected && this.gatewayWs && this.gatewayWs.readyState === 1;
    if (!canSendGateway && !this._autoFallbackEnabled) {
      return;
    }
    const item = this._queue.shift();
    if (!item) return;
    this._inFlight = true;
    try {
      if (canSendGateway) {
        await this._sendAgentTurn(item.text, item.agentId);
      } else if (this._autoFallbackEnabled) {
        await this._tryFallback(item.text, this._degradedReason || 'gateway_not_connected');
      }
    } finally {
      this._inFlight = false;
      if (this._queue.length > 0) this._drainQueue();
    }
  }

  /**
   * @param {string} userText
   * @param {string} agentId
   */
  _sendAgentTurn(userText, agentId) {
    return new Promise((resolve) => {
      if (!this.gatewayWs || this.gatewayWs.readyState !== 1) {
        resolve();
        return;
      }
      const id = makeReqId();
      const frame = {
        type: 'req',
        id,
        method: this.agentMethod,
        params: {
          message: userText,
          idempotencyKey: id,
          agentId,
          // Some gateway builds validate scopes again on each agent request.
          scopes: defaultGatewayScopes(),
        },
      };
      const timeout = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          logger.warn('single_client_gateway_req_timeout', { id });
        }
        resolve();
      }, Number(process.env.OPENCLAW_BRIDGE_REQ_TIMEOUT_MS || 120000));

      this._pending.set(id, (resMsg) => {
        clearTimeout(timeout);
        const handle = async () => {
          if (resMsg && resMsg.ok === false) {
            const c = this._recordReject('agent', resMsg?.error ?? resMsg);
            const usedFallback = await this._tryFallback(
              userText,
              `agent_${c.reason}`
            );
            if (usedFallback) {
              resolve();
              return;
            }
          } else {
            gatewayBridgeGateState.labels('provider').set(1);
          }
          const t = extractAssistantTextFromGateway(resMsg);
          if (t) {
            this.onAssistantText(t);
          } else {
            logger.warn('single_client_gateway_res_no_text', {
              id,
              ok: resMsg?.ok,
              type: resMsg?.type,
              snippet: (() => {
                try {
                  return JSON.stringify(resMsg).slice(0, 400);
                } catch {
                  return '';
                }
              })(),
            });
          }
          resolve();
        };
        handle();
      });

      try {
        this.gatewayWs.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timeout);
        this._pending.delete(id);
        logger.error('single_client_gateway_send_failed', { err: err.message });
        resolve();
      }
    });
  }
}
