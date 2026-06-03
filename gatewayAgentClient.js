import { WebSocket } from 'ws';
import { logger } from './logger.js';
import {
  buildConnectDeviceBlock,
  deviceAuthInsecureSkip,
  gatewayLegacyBlindConnect,
  loadOrCreateDeviceIdentity,
  loadStoredDeviceToken,
  loadStoredScopes,
  persistHelloOkDeviceAuth,
} from './gatewayDeviceIdentity.js';
import {
  gatewayBridgeErrorsTotal,
  gatewayBridgeFallbackTotal,
  gatewayBridgeGateState,
  gatewayBridgeRejectTotal,
} from './metrics.js';
import { classifyGatewayError } from './gatewayErrorClassifier.js';
import {
  gatewayConnectWaitMs,
  scheduleOpenClawSelfHealOnGatewayTransportError,
  scheduleOpenClawSelfHealOnGatewayUnavailable,
  waitForGatewayLoopback,
} from './openclawConfigSelfHeal.js';
import { ProviderFallbackClient } from './providerFallbackClient.js';
import { resolveGatewayTurnAgentId } from './gatewayTurnAgentId.js';
import { assistantTextForConsumer, GatewayReplyDeduper } from './gatewayAssistantDispatch.js';
import { isGatewayAcceptedAck } from './gatewayResponseText.js';

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
  // OpenClaw `GatewayClientModeSchema` allows only:
  // webchat | cli | ui | backend | node | probe | test — not role names like `operator` or legacy `service`.
  return raw || 'cli';
}

function defaultBridgeClientId() {
  const raw = (process.env.OPENCLAW_BRIDGE_CLIENT_ID || '').trim();
  return raw || 'cli';
}

function defaultGatewayRole() {
  const raw = (process.env.OPENCLAW_BRIDGE_ROLE || '').trim().toLowerCase();
  // Keep role strict for gateways that only accept "operator".
  if (!raw || raw === 'admin') return 'operator';
  return raw;
}

function gatewayProtocolVersions() {
  // Default min 3 so `connect` overlaps Gateway builds that negotiate protocol 3 (min 4 alone causes
  // INVALID_REQUEST protocol mismatch / expectedProtocol 3).
  const min = Number(process.env.OPENCLAW_BRIDGE_MIN_PROTOCOL ?? 3);
  const max = Number(process.env.OPENCLAW_BRIDGE_MAX_PROTOCOL ?? 9);
  return {
    minProtocol: Number.isFinite(min) ? min : 3,
    maxProtocol: Number.isFinite(max) ? max : 9,
  };
}

/** Newer OpenClaw Gateways reject `agent.params.scopes` (strict schema); set `OPENCLAW_BRIDGE_AGENT_INCLUDE_SCOPES=1` for legacy builds that re-validate scopes per turn. */
function bridgeAgentParamsIncludeScopes() {
  const v = String(process.env.OPENCLAW_BRIDGE_AGENT_INCLUDE_SCOPES || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function connectChallengeTimeoutMs() {
  const raw = Number(process.env.OPENCLAW_GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
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
    /** OpenClaw Gateway `connect.challenge` handshake (see gateway/protocol.md). */
    this._connectNonce = null;
    this._connectSent = false;
    this._connectChallengeTimer = null;
    this._gatewayIdentity = null;
    this._replyDeduper = new GatewayReplyDeduper();
    gatewayBridgeGateState.labels('pairing').set(-1);
    gatewayBridgeGateState.labels('scope').set(-1);
    gatewayBridgeGateState.labels('provider').set(
      this._fallbackClient && this._fallbackClient.isConfigured() ? 1 : -1
    );
  }

  destroy() {
    this._destroyed = true;
    this._clearConnectChallengeTimer();
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
    const aid = resolveGatewayTurnAgentId(agentId);
    this._queue.push({ text: userText, agentId: aid });
    this._drainQueue();
  }

  _scheduleReconnect(opts = {}) {
    if (this._destroyed || this._reconnectTimer) return;
    const base = opts.portDown ? 5000 : 2000;
    const delay = Math.min(30_000, base + Math.random() * 1000);
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

  _clearConnectChallengeTimer() {
    if (this._connectChallengeTimer) {
      clearTimeout(this._connectChallengeTimer);
      this._connectChallengeTimer = null;
    }
  }

  _armConnectChallengeTimer() {
    if (this._destroyed || this._connectSent) return;
    this._clearConnectChallengeTimer();
    const limitMs = connectChallengeTimeoutMs();
    const started = Date.now();
    this._connectChallengeTimer = setTimeout(() => {
      if (this._destroyed || this._connectSent || !this.gatewayWs) return;
      if (gatewayLegacyBlindConnect()) {
        this._sendLegacyBlindConnect();
        return;
      }
      gatewayBridgeErrorsTotal.inc();
      const elapsedMs = Date.now() - started;
      logger.error('single_client_gateway_challenge_timeout', { elapsedMs, limitMs });
      try {
        this.onError(new Error(`gateway_connect_challenge_timeout:${elapsedMs}ms`));
      } catch {
        /* ignore */
      }
      try {
        this.gatewayWs?.close(1008, 'connect challenge timeout');
      } catch {
        /* ignore */
      }
    }, limitMs);
  }

  _beginHandshakeAfterOpen() {
    this._connectNonce = null;
    this._connectSent = false;
    if (deviceAuthInsecureSkip()) {
      this._clearConnectChallengeTimer();
      this._sendConnectHandshake({ omitDevice: true, nonce: '' });
      return;
    }
    if (gatewayLegacyBlindConnect()) {
      this._sendLegacyBlindConnect();
      return;
    }
    this._armConnectChallengeTimer();
  }

  /**
   * Legacy gateway that responds to an initial device-less `connect` with CHALLENGE_REQUIRED.
   */
  _sendLegacyBlindConnect() {
    if (!this.gatewayWs || this.gatewayWs.readyState !== 1) return;
    this._clearConnectChallengeTimer();
    this._sendConnectHandshake({ omitDevice: true, nonce: '' });
  }

  _handleConnectChallengeEvent(msg) {
    const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {};
    const nonce = typeof payload.nonce === 'string' ? payload.nonce.trim() : '';
    if (!nonce) {
      gatewayBridgeErrorsTotal.inc();
      logger.error('single_client_gateway_challenge_missing_nonce');
      try {
        this.onError(new Error('gateway_connect_challenge_missing_nonce'));
      } catch {
        /* ignore */
      }
      try {
        this.gatewayWs?.close(1008, 'connect challenge missing nonce');
      } catch {
        /* ignore */
      }
      return;
    }
    this._clearConnectChallengeTimer();
    this._connectNonce = nonce;
    if (!this._connectSent) {
      this._sendConnectHandshake({ omitDevice: deviceAuthInsecureSkip(), nonce });
    }
  }

  _resolveSignatureToken() {
    const explicit = (this.gatewayToken || '').trim();
    const stored = loadStoredDeviceToken();
    return explicit || stored || '';
  }

  _resolveScopesForConnect() {
    const explicit = (this.gatewayToken || '').trim();
    const storedTok = loadStoredDeviceToken();
    const storedScopes = loadStoredScopes();
    const usingStoredOnly = !explicit && storedTok && Array.isArray(storedScopes) && storedScopes.length > 0;
    if (usingStoredOnly) {
      const REQUIRED = ['operator.read', 'operator.write'];
      const out = [...storedScopes.map((s) => String(s).trim()).filter(Boolean)];
      const seen = new Set(out.map((x) => x.toLowerCase()));
      for (const r of REQUIRED) {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
        }
      }
      return out;
    }
    return defaultGatewayScopes();
  }

  _composeConnectParams({ omitDevice, nonce }) {
    const { minProtocol, maxProtocol } = gatewayProtocolVersions();
    const role = defaultGatewayRole();
    const scopes = this._resolveScopesForConnect();
    const clientId = defaultBridgeClientId();
    const clientMode = defaultBridgeClientMode();
    const platform = defaultBridgeClientPlatform();
    const deviceFamily = (process.env.OPENCLAW_BRIDGE_DEVICE_FAMILY || '').trim();
    const explicitTok = (this.gatewayToken || '').trim();
    const storedTok = loadStoredDeviceToken();
    const authToken = explicitTok || storedTok;

    const params = {
      minProtocol,
      maxProtocol,
      client: {
        id: clientId,
        version: process.env.npm_package_version || '1.0.0',
        platform,
        mode: clientMode,
      },
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
    };
    if (authToken) {
      params.auth = { token: authToken };
    }

    if (!omitDevice && nonce) {
      if (!this._gatewayIdentity) {
        this._gatewayIdentity = loadOrCreateDeviceIdentity();
      }
      const signatureToken = this._resolveSignatureToken();
      params.device = buildConnectDeviceBlock({
        identity: this._gatewayIdentity,
        nonce,
        scopes,
        role,
        clientId,
        clientMode,
        platform,
        deviceFamily: deviceFamily || undefined,
        signatureToken,
      });
    }
    return params;
  }

  _isHelloOkAuthorized(msg) {
    const granted =
      (Array.isArray(msg?.payload?.grantedScopes) ? msg.payload.grantedScopes : null) ||
      (Array.isArray(msg?.payload?.auth?.scopes) ? msg.payload.auth.scopes : null);
    if (!granted || granted.length === 0) return true;
    const normalized = granted
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim().toLowerCase());
    return normalized.includes('operator.write');
  }

  _persistHelloOk(msg) {
    const auth = msg?.payload?.auth;
    if (auth && typeof auth === 'object' && auth.deviceToken) {
      persistHelloOkDeviceAuth({
        deviceToken: auth.deviceToken,
        scopes: Array.isArray(auth.scopes) ? auth.scopes : undefined,
      });
    }
  }

  _finishConnectSuccess(msg) {
    if (!this._isHelloOkAuthorized(msg)) {
      gatewayBridgeErrorsTotal.inc();
      this._recordReject('connect', { code: 'SCOPE_DENIED', message: 'operator.write not granted' });
      try {
        this.gatewayWs?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this._persistHelloOk(msg);
    this._gatewayConnected = true;
    gatewayBridgeGateState.labels('pairing').set(1);
    gatewayBridgeGateState.labels('scope').set(1);
    logger.info('single_client_gateway_connected');
    this._drainQueue();
  }

  /**
   * @param {{ omitDevice?: boolean, nonce?: string }} opts
   */
  _sendConnectHandshake(opts = {}) {
    if (!this.gatewayWs || this.gatewayWs.readyState !== 1) return;
    const omitDevice = Boolean(opts.omitDevice);
    const nonce = typeof opts.nonce === 'string' ? opts.nonce : '';
    const id = makeReqId();
    const params = this._composeConnectParams({ omitDevice, nonce });
    const frame = {
      type: 'req',
      id,
      method: 'connect',
      params,
    };
    this._connectSent = true;
    this._pending.set(id, (msg) => {
      if (msg && msg.ok === true) {
        this._finishConnectSuccess(msg);
        return;
      }
      const challengeLegacy = this._extractConnectChallenge(msg);
      if (challengeLegacy && omitDevice) {
        const n = String(challengeLegacy.nonce || '').trim();
        if (n) {
          this._connectNonce = n;
          this._connectSent = false;
          this._sendConnectHandshake({ omitDevice: deviceAuthInsecureSkip(), nonce: n });
          return;
        }
      }
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
    });
    try {
      this.gatewayWs.send(JSON.stringify(frame));
    } catch (err) {
      this._connectSent = false;
      logger.error('single_client_gateway_connect_send_failed', { err: err.message });
    }
  }

  _connect() {
    if (this._destroyed || this._connecting || this.gatewayWs) return;
    void this._connectWithWait();
  }

  async _connectWithWait() {
    if (this._destroyed || this._connecting || this.gatewayWs) return;
    this._connecting = true;
    const waitMs = gatewayConnectWaitMs();
    if (waitMs > 0) {
      const wait = await waitForGatewayLoopback({ maxWaitMs: waitMs });
      if (!wait.ok) {
        this._connecting = false;
        if (!this._destroyed) {
          scheduleOpenClawSelfHealOnGatewayTransportError(
            new Error(wait.probe?.error || 'gateway_port_unavailable'),
            'single_client_connect_wait'
          );
          this._scheduleReconnect({ portDown: true });
        }
        return;
      }
    }
    if (this._destroyed) {
      this._connecting = false;
      return;
    }
    this._openGatewayWebSocket();
  }

  _openGatewayWebSocket() {
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
      this._beginHandshakeAfterOpen();
    });

    this.gatewayWs.on('message', (data) => {
      this._onGatewayMessage(data);
    });

    this.gatewayWs.on('close', () => {
      this._connecting = false;
      const wasConnected = this._gatewayConnected;
      this._gatewayConnected = false;
      this._clearConnectChallengeTimer();
      this._connectNonce = null;
      this._connectSent = false;
      this.gatewayWs = null;
      if (!this._destroyed && !wasConnected) {
        scheduleOpenClawSelfHealOnGatewayUnavailable('gateway_closed_before_connect');
      }
      if (!this._destroyed) this._scheduleReconnect();
    });

    this.gatewayWs.on('error', (err) => {
      gatewayBridgeErrorsTotal.inc();
      logger.error('single_client_gateway_ws_error', { err: err.message });
      scheduleOpenClawSelfHealOnGatewayTransportError(err, 'single_client_gateway_ws_error');
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

  /**
   * @param {import('ws').RawData} data
   */
  _onGatewayMessage(data) {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        this._handleConnectChallengeEvent(msg);
        return;
      }
      if (msg.type === 'res' && msg.id) {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending(msg);
          return;
        }
      }
      const t = assistantTextForConsumer(msg, this._replyDeduper);
      if (t) this.onAssistantText(t);
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
      this._replyDeduper.reset();
      const id = makeReqId();
      const params = {
        message: userText,
        idempotencyKey: id,
        agentId,
      };
      if (bridgeAgentParamsIncludeScopes()) {
        params.scopes = defaultGatewayScopes();
      }
      const frame = {
        type: 'req',
        id,
        method: this.agentMethod,
        params,
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
          const t = assistantTextForConsumer(resMsg, this._replyDeduper);
          if (t) {
            this.onAssistantText(t);
          } else if (!isGatewayAcceptedAck(resMsg)) {
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
