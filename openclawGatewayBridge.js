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
import { MachineRelaySession } from './machineRelaySession.js';
import {
  gatewayBridgeConnectState,
  gatewayBridgeErrorsTotal,
  gatewayBridgeFallbackTotal,
  gatewayBridgeGateState,
  gatewayBridgePhoneToGatewayTotal,
  gatewayBridgeRejectTotal,
  gatewayBridgeGatewayToPhoneTotal,
} from './metrics.js';
import { classifyGatewayError } from './gatewayErrorClassifier.js';
import { ProviderFallbackClient } from './providerFallbackClient.js';

function makeReqId() {
  return `ombot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Default enforced scopes for gateway compatibility across OpenClaw builds. */
function defaultGatewayBridgeScopes() {
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
  // See OpenClaw `src/gateway/protocol/client-info.ts` — `client.mode` is not `connect.params.role`.
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
  const min = Number(process.env.OPENCLAW_BRIDGE_MIN_PROTOCOL ?? 3);
  const max = Number(process.env.OPENCLAW_BRIDGE_MAX_PROTOCOL ?? 9);
  return {
    minProtocol: Number.isFinite(min) ? min : 3,
    maxProtocol: Number.isFinite(max) ? max : 9,
  };
}

/** See `gatewayAgentClient.js` — strict Gateways reject `scopes` on `agent` params unless opted in. */
function bridgeAgentParamsIncludeScopes() {
  const v = String(process.env.OPENCLAW_BRIDGE_AGENT_INCLUDE_SCOPES || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function connectChallengeTimeoutMs() {
  const raw = Number(process.env.OPENCLAW_GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

/**
 * Extract user text from Phone-side decrypted ClawChat JSON.
 * @param {object} j
 */
export function phonePayloadToUserText(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.type !== 'req') return null;
  const method = (process.env.OPENCLAW_BRIDGE_PHONE_METHOD || 'agent').trim();
  if (String(j.method) !== method) return null;
  const p = j.params;
  if (!p || typeof p !== 'object') return null;
  if (p.message != null) return String(p.message);
  if (p.text != null) return String(p.text);
  return null;
}

/**
 * Build plaintext JSON to send to Phone (ClawChat shape).
 * @param {string} text
 */
export function assistantTextToPhoneRes(text) {
  return JSON.stringify({
    type: 'res',
    payload: { text },
  });
}

/**
 * Parse assistant text from Gateway res/event (best-effort for OpenClaw versions).
 * @param {object} msg
 */
export function extractAssistantTextFromGateway(msg) {
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

export class OpenClawGatewayBridge {
  /**
   * @param {{ keyPair: object, config: object, agentId: string, conversationId: string, participantId: string, clientId?: string }} opts
   */
  constructor(opts) {
    this.keyPair = opts.keyPair;
    this.config = opts.config;
    this.clientId = opts.clientId || 'openclaw-bridge';
    this.agentId = opts.agentId;
    this.conversationId = opts.conversationId;
    this.participantId = opts.participantId;
    this.gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789').trim();
    this.gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
    this.agentMethod = (process.env.OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD || 'agent').trim();
    this.defaultGatewayAgentId = (
      process.env.OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID ||
      process.env.OPENCLAW_BRIDGE_AGENT_ID ||
      'default'
    ).trim();

    /** @type {WebSocket | null} */
    this.gatewayWs = null;
    /** @type {MachineRelaySession | null} */
    this.session = null;
    this._gatewayConnected = false;
    this._connecting = false;
    this._destroyed = false;
    this._reconnectTimer = null;
    this._pending = new Map();
    this._inFlight = false;
    this._queue = [];
    this._gateStatus = {
      pairing: 'unknown',
      scope: 'unknown',
      provider: 'unknown',
    };
    this._strictPairingProfile = process.env.OPENCLAW_STRICT_PAIRING_PROFILE !== '0';
    this._autoFallbackEnabled = ['1', 'true', 'yes'].includes(
      String(process.env.OPENCLAW_BRIDGE_AUTO_FALLBACK || '')
        .trim()
        .toLowerCase()
    ) && !this._strictPairingProfile;
    this._fallbackClient = this._autoFallbackEnabled ? new ProviderFallbackClient() : null;
    this._degradedReason = '';
    this._connectNonce = null;
    this._connectSent = false;
    this._connectChallengeTimer = null;
    this._gatewayIdentity = null;
    this._initGateStatus();
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
      logger.error('gateway_bridge_challenge_timeout', { elapsedMs, limitMs });
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
      logger.error('gateway_bridge_challenge_missing_nonce');
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
    return defaultGatewayBridgeScopes();
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
      this._recordGatewayReject('connect', { code: 'SCOPE_DENIED', message: 'operator.write not granted' });
      this._setGate('scope', 'fail', 'scope_denied');
      try {
        this.gatewayWs?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this._persistHelloOk(msg);
    this._gatewayConnected = true;
    gatewayBridgeConnectState.set(1);
    this._setGate('pairing', 'pass', 'connect_ok');
    this._setGate('scope', 'pass', 'connect_ok');
    logger.info('gateway_bridge_connected');
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
      this._recordGatewayReject('connect', msg?.error ?? msg);
      logger.error('gateway_bridge_connect_rejected', { id, error: msg?.error });
      try {
        this.gatewayWs?.close();
      } catch {
        /* ignore */
      }
      this._scheduleGatewayReconnect();
    });
    try {
      this.gatewayWs.send(JSON.stringify(frame));
      logger.info('gateway_bridge_connect_sent', { id, url: this.gatewayUrl });
    } catch (err) {
      this._connectSent = false;
      logger.error('gateway_bridge_connect_send_failed', { err: err.message });
    }
  }

  _initGateStatus() {
    this._setGate('pairing', 'unknown', 'startup');
    const scopes = defaultGatewayBridgeScopes();
    const hasRequiredScope = scopes.includes('operator.read') && scopes.includes('operator.write');
    this._setGate(
      'scope',
      hasRequiredScope ? 'pass' : 'fail',
      hasRequiredScope ? 'static' : 'missing_scope'
    );
    const hasProviderEnv = Boolean(
      String(process.env.OPENAI_API_KEY || '').trim() ||
        String(process.env.ANTHROPIC_API_KEY || '').trim() ||
        String(process.env.GOOGLE_API_KEY || '').trim()
    );
    this._setGate(
      'provider',
      hasProviderEnv ? 'pass' : 'unknown',
      hasProviderEnv ? 'env_present' : 'env_missing'
    );
  }

  _gateValue(status) {
    if (status === 'pass') return 1;
    if (status === 'fail') return 0;
    return -1;
  }

  _setGate(gate, status, detail) {
    const prev = this._gateStatus[gate];
    this._gateStatus[gate] = status;
    gatewayBridgeGateState.labels(gate).set(this._gateValue(status));
    if (prev !== status) {
      logger.info('gateway_bridge_gate_changed', { gate, status, detail });
    }
  }

  _recordGatewayReject(phase, errorLike) {
    const classified = classifyGatewayError(errorLike);
    gatewayBridgeRejectTotal.labels(phase, classified.category, classified.reason).inc();
    if (classified.category === 'pairing') this._setGate('pairing', 'fail', classified.reason);
    if (classified.category === 'scope') this._setGate('scope', 'fail', classified.reason);
    if (classified.category === 'provider') this._setGate('provider', 'fail', classified.reason);
    this._degradedReason = `${phase}:${classified.reason}`;
    return classified;
  }

  async _tryFallback(userText, reason) {
    if (!this._fallbackClient || !this._fallbackClient.isConfigured()) return false;
    try {
      const text = await this._fallbackClient.completeUserTurn(userText);
      if (text && this.session) {
        gatewayBridgeFallbackTotal.labels('provider', reason || 'unknown').inc();
        gatewayBridgeGatewayToPhoneTotal.inc();
        this.session.sendPlaintextToPhone(assistantTextToPhoneRes(text));
        this._setGate('provider', 'pass', 'fallback_ok');
        return true;
      }
    } catch (err) {
      const classified = classifyGatewayError(err?.message || String(err));
      if (classified.category === 'provider') this._setGate('provider', 'fail', classified.reason);
      gatewayBridgeErrorsTotal.inc();
      logger.error('gateway_bridge_fallback_failed', {
        err: err?.message || String(err),
        reason,
      });
    }
    return false;
  }

  start() {
    this.session = new MachineRelaySession({
      clientId: this.clientId,
      clientWs: null,
      keyPair: this.keyPair,
      bridgeMode: true,
      config: this.config,
      onDecryptedPlaintextToConsumer: (plain) => this._onPhonePlaintext(plain),
      onMiddlewareDisconnected: () => {
        logger.warn('gateway_bridge_middleware_disconnected', {
          clientId: this.clientId,
        });
      },
    });
    this.session.startBridgeSession({
      agentId: this.agentId,
      conversationId: this.conversationId,
      participantId: this.participantId,
    });
    this._connectGateway();
  }

  stop() {
    this._destroyed = true;
    this._clearConnectChallengeTimer();
    this._connectNonce = null;
    this._connectSent = false;
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
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    this._gatewayConnected = false;
    gatewayBridgeConnectState.set(0);
  }

  _connectGateway() {
    if (this._destroyed || this._connecting) return;
    this._connecting = true;
    try {
      this.gatewayWs = new WebSocket(this.gatewayUrl);
    } catch (err) {
      this._connecting = false;
      gatewayBridgeErrorsTotal.inc();
      logger.error('gateway_bridge_ws_create_failed', { err: err.message });
      this._scheduleGatewayReconnect();
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
      this._gatewayConnected = false;
      this._clearConnectChallengeTimer();
      this._connectNonce = null;
      this._connectSent = false;
      gatewayBridgeConnectState.set(0);
      this.gatewayWs = null;
      if (!this._destroyed) this._scheduleGatewayReconnect();
    });

    this.gatewayWs.on('error', (err) => {
      gatewayBridgeErrorsTotal.inc();
      logger.error('gateway_bridge_ws_error', { err: err.message });
    });
  }

  _scheduleGatewayReconnect() {
    if (this._destroyed) return;
    if (this._reconnectTimer) return;
    const delay = Math.min(30_000, 2000 + Math.random() * 1000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._destroyed && !this.gatewayWs) this._connectGateway();
    }, delay);
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
      if (msg.type === 'event') {
        const text = extractAssistantTextFromGateway({ type: 'res', ok: true, payload: msg.payload });
        const t = text ?? extractAssistantTextFromGateway(msg);
        if (t && this.session) {
          gatewayBridgeGatewayToPhoneTotal.inc();
          this.session.sendPlaintextToPhone(assistantTextToPhoneRes(t));
        }
        return;
      }
      if (msg.type === 'res') {
        const t = extractAssistantTextFromGateway(msg);
        if (t && this.session) {
          gatewayBridgeGatewayToPhoneTotal.inc();
          this.session.sendPlaintextToPhone(assistantTextToPhoneRes(t));
        }
      }
    } catch (err) {
      gatewayBridgeErrorsTotal.inc();
      logger.error('gateway_bridge_parse_error', { err: err.message });
    }
  }

  /**
   * @param {string} plain
   */
  _onPhonePlaintext(plain) {
    let j;
    try {
      j = JSON.parse(plain);
    } catch {
      return;
    }
    const userText = phonePayloadToUserText(j);
    if (userText == null) return;
    gatewayBridgePhoneToGatewayTotal.inc();
    this._enqueueUserMessage(userText);
  }

  _enqueueUserMessage(text) {
    this._queue.push(text);
    this._drainQueue();
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
    const text = this._queue.shift();
    if (text == null) return;
    this._inFlight = true;
    try {
      if (canSendGateway) {
        await this._sendAgentTurn(text);
      } else if (this._autoFallbackEnabled) {
        const usedFallback = await this._tryFallback(
          text,
          this._degradedReason || 'gateway_not_connected'
        );
        if (!usedFallback) {
          logger.warn('gateway_bridge_no_path_available', {
            reason: this._degradedReason || 'gateway_not_connected',
          });
        }
      }
    } finally {
      this._inFlight = false;
      if (this._queue.length > 0) this._drainQueue();
    }
  }

  /**
   * @param {string} userText
   */
  _sendAgentTurn(userText) {
    return new Promise((resolve) => {
      if (!this.gatewayWs || this.gatewayWs.readyState !== 1) {
        resolve();
        return;
      }
      const id = makeReqId();
      const params = {
        message: userText,
        idempotencyKey: id,
        agentId: this.defaultGatewayAgentId,
      };
      if (bridgeAgentParamsIncludeScopes()) {
        params.scopes = defaultGatewayBridgeScopes();
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
          gatewayBridgeErrorsTotal.inc();
          logger.warn('gateway_bridge_req_timeout', { id });
        }
        resolve();
      }, Number(process.env.OPENCLAW_BRIDGE_REQ_TIMEOUT_MS || 120000));

      this._pending.set(id, (resMsg) => {
        clearTimeout(timeout);
        const handle = async () => {
          if (resMsg && resMsg.ok === false) {
            const classified = this._recordGatewayReject('agent', resMsg?.error ?? resMsg);
            const usedFallback = await this._tryFallback(userText, `agent_${classified.reason}`);
            if (usedFallback) {
              resolve();
              return;
            }
          } else {
            this._setGate('provider', 'pass', 'agent_ok');
          }
          const t = extractAssistantTextFromGateway(resMsg);
          if (t && this.session) {
            gatewayBridgeGatewayToPhoneTotal.inc();
            this.session.sendPlaintextToPhone(assistantTextToPhoneRes(t));
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
        gatewayBridgeErrorsTotal.inc();
        logger.error('gateway_bridge_send_failed', { err: err.message });
        resolve();
      }
    });
  }
}

/** @type {OpenClawGatewayBridge | null} */
let activeBridge = null;

/** Enable when OPENCLAW_GATEWAY_BRIDGE=1 */
export function shouldStartGatewayBridge() {
  const v = (process.env.OPENCLAW_GATEWAY_BRIDGE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {object} opts
 * @param {object} opts.keyPair
 * @param {object} opts.config MachineRelaySession config
 */
export function startOpenClawGatewayBridge(opts) {
  if (activeBridge) {
    logger.warn('gateway_bridge_already_running');
    return activeBridge;
  }
  const agentId = (process.env.OPENCLAW_BRIDGE_AGENT_ID || 'default').trim();
  const conversationId = (process.env.OPENCLAW_BRIDGE_CONVERSATION_ID || 'default').trim();
  const participantId = (process.env.OPENCLAW_BRIDGE_PARTICIPANT_ID || 'default').trim();
  activeBridge = new OpenClawGatewayBridge({
    keyPair: opts.keyPair,
    config: opts.config,
    agentId,
    conversationId,
    participantId,
  });
  activeBridge.start();
  return activeBridge;
}

export function stopOpenClawGatewayBridge() {
  if (activeBridge) {
    activeBridge.stop();
    activeBridge = null;
  }
}
