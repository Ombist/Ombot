import { logger } from './logger.js';
import { MachineRelaySession } from './machineRelaySession.js';
import {
  hermesBridgeConnectState,
  hermesBridgeErrorsTotal,
  hermesBridgeHermesToPhoneTotal,
  hermesBridgePhoneToHermesTotal,
} from './metrics.js';
import {
  assistantTextToPhoneRes,
  phonePayloadToUserText,
} from './openclawGatewayBridge.js';

/** @see https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server */
const HERMES_API_SERVER_DOC =
  'https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server';

function hermesApiBaseUrl() {
  const raw = (process.env.HERMES_API_SERVER_URL || 'http://127.0.0.1:8642/v1').trim();
  return raw.replace(/\/+$/, '');
}

function hermesApiOrigin() {
  const base = hermesApiBaseUrl();
  return base.replace(/\/v1$/i, '');
}

function hermesApiKey() {
  return (process.env.HERMES_API_SERVER_KEY || '').trim();
}

function hermesBridgeModel() {
  return (process.env.HERMES_BRIDGE_MODEL || 'hermes-agent').trim() || 'hermes-agent';
}

function hermesBridgeApiMode() {
  const raw = (process.env.HERMES_BRIDGE_API_MODE || 'responses').trim().toLowerCase();
  if (raw === 'chat_completions' || raw === 'chat' || raw === 'completions') {
    return 'chat_completions';
  }
  return 'responses';
}

/** Stable named conversation for POST /v1/responses (doc: "Named conversations"). */
function hermesConversationName(agentId, conversationId) {
  const prefix = (process.env.HERMES_BRIDGE_CONVERSATION_PREFIX || 'ombist').trim() || 'ombist';
  const aid = String(agentId || 'default').trim() || 'default';
  const cid = String(conversationId || 'default').trim() || 'default';
  const name = `${prefix}:${aid}:${cid}`;
  return name.length > 256 ? name.slice(0, 256) : name;
}

/** Transcript-scoped header (doc: X-Hermes-Session-Id). */
function hermesSessionIdHeader(agentId, conversationId, participantId) {
  const prefix = (process.env.HERMES_BRIDGE_SESSION_ID_PREFIX || 'ombist').trim() || 'ombist';
  const parts = [prefix, agentId, conversationId, participantId]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const id = parts.join(':') || 'ombist:default';
  return id.length > 256 ? id.slice(0, 256) : id;
}

/** Long-term memory scope (doc: X-Hermes-Session-Key, independent of Session-Id). */
function hermesSessionKeyHeader(agentId, conversationId) {
  const prefix = (process.env.HERMES_BRIDGE_SESSION_KEY_PREFIX || 'ombist').trim() || 'ombist';
  const key = `${prefix}:${String(agentId || 'default').trim()}:${String(conversationId || 'default').trim()}`;
  return key.length > 256 ? key.slice(0, 256) : key;
}

function hermesRequestHeaders(sessionId, sessionKey) {
  const key = hermesApiKey();
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Hermes-Session-Id': sessionId,
    'X-Hermes-Session-Key': sessionKey,
  };
  return headers;
}

function extractAssistantTextFromChatCompletion(body) {
  if (!body || typeof body !== 'object') return null;
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (content != null && String(content).trim()) return String(content);
  const text = choice?.text;
  if (text != null && String(text).trim()) return String(text);
  const err = body.error?.message || body.error;
  if (err) return `Hermes error: ${String(err)}`;
  return null;
}

function extractAssistantTextFromResponses(body) {
  if (!body || typeof body !== 'object') return null;
  const output = body.output;
  if (!Array.isArray(output)) {
    const err = body.error?.message || body.error;
    if (err) return `Hermes error: ${String(err)}`;
    return null;
  }
  const texts = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && item.role === 'assistant') {
      const content = item.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'output_text' && part.text != null) {
            texts.push(String(part.text));
          } else if (typeof part?.text === 'string') {
            texts.push(part.text);
          }
        }
      } else if (typeof content === 'string') {
        texts.push(content);
      }
    }
  }
  const joined = texts.join('\n').trim();
  if (joined) return joined;
  if (typeof body.output_text === 'string' && body.output_text.trim()) {
    return body.output_text.trim();
  }
  const err = body.error?.message || body.error;
  if (err) return `Hermes error: ${String(err)}`;
  return null;
}

export class HermesAgentBridge {
  /**
   * @param {{ keyPair: object, config: object, agentId: string, conversationId: string, participantId: string, clientId?: string }} opts
   */
  constructor(opts) {
    this.keyPair = opts.keyPair;
    this.config = opts.config;
    this.clientId = opts.clientId || 'hermes-bridge';
    this.agentId = opts.agentId;
    this.conversationId = opts.conversationId;
    this.participantId = opts.participantId;
    this.apiBase = hermesApiBaseUrl();
    this.apiOrigin = hermesApiOrigin();
    this.apiKey = hermesApiKey();
    this.model = hermesBridgeModel();
    this.apiMode = hermesBridgeApiMode();
    this.conversationName = hermesConversationName(opts.agentId, opts.conversationId);
    this.sessionIdHeader = hermesSessionIdHeader(
      opts.agentId,
      opts.conversationId,
      opts.participantId
    );
    this.sessionKeyHeader = hermesSessionKeyHeader(opts.agentId, opts.conversationId);
    /** @type {{ role: string, content: string }[]} */
    this._chatMessages = [];

    /** @type {MachineRelaySession | null} */
    this.session = null;
    this._apiConnected = false;
    this._destroyed = false;
    this._inFlight = false;
    this._queue = [];
    this._healthTimer = null;
  }

  start() {
    logger.info('hermes_bridge_start', {
      apiMode: this.apiMode,
      conversation: this.conversationName,
      doc: HERMES_API_SERVER_DOC,
    });
    this.session = new MachineRelaySession({
      clientId: this.clientId,
      clientWs: null,
      keyPair: this.keyPair,
      bridgeMode: true,
      config: this.config,
      onDecryptedPlaintextToConsumer: (plain) => this._onPhonePlaintext(plain),
      onMiddlewareDisconnected: () => {
        logger.warn('hermes_bridge_middleware_disconnected', { clientId: this.clientId });
      },
      getBridgeConnected: () => this._apiConnected,
    });
    this.session.startBridgeSession({
      agentId: this.agentId,
      conversationId: this.conversationId,
      participantId: this.participantId,
    });
    void this._probeApiHealth();
    const intervalMs = Number(process.env.HERMES_BRIDGE_HEALTH_INTERVAL_MS || 15_000);
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      this._healthTimer = setInterval(() => {
        if (!this._destroyed) void this._probeApiHealth();
      }, intervalMs);
      this._healthTimer.unref?.();
    }
  }

  stop() {
    this._destroyed = true;
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    this._apiConnected = false;
    hermesBridgeConnectState.set(0);
  }

  async _probeApiHealth() {
    const key = this.apiKey;
    if (!key) {
      this._setApiConnected(false);
      return false;
    }
    const timeoutMs = Number(process.env.HERMES_BRIDGE_HEALTH_TIMEOUT_MS || 5000);
    const signal = AbortSignal.timeout(timeoutMs);
    const urls = [
      `${this.apiOrigin}/v1/health`,
      `${this.apiOrigin}/health`,
      `${this.apiBase}/models`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
        if (res.ok) {
          this._setApiConnected(true);
          return true;
        }
      } catch {
        /* try next health URL */
      }
    }
    hermesBridgeErrorsTotal.inc();
    logger.warn('hermes_bridge_health_probe_failed', { doc: HERMES_API_SERVER_DOC });
    this._setApiConnected(false);
    return false;
  }

  _setApiConnected(ok) {
    this._apiConnected = ok;
    hermesBridgeConnectState.set(ok ? 1 : 0);
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
    if (j.type === 'ping') {
      this.session?.handleApplicationPing(j, this._apiConnected);
      return;
    }
    const userText = phonePayloadToUserText(j);
    if (userText == null) return;
    hermesBridgePhoneToHermesTotal.inc();
    this._enqueueUserMessage(userText);
  }

  _enqueueUserMessage(text) {
    this._queue.push(text);
    void this._drainQueue();
  }

  async _drainQueue() {
    if (this._inFlight) return;
    const text = this._queue.shift();
    if (text == null) return;
    this._inFlight = true;
    try {
      if (this.apiMode === 'chat_completions') {
        await this._sendChatCompletion(text);
      } else {
        await this._sendResponsesTurn(text);
      }
    } finally {
      this._inFlight = false;
      if (this._queue.length > 0) void this._drainQueue();
    }
  }

  /**
   * POST /v1/responses — server-side conversation chain (doc: Named conversations).
   * @param {string} userText
   */
  async _sendResponsesTurn(userText) {
    const key = this.apiKey;
    if (!key) {
      logger.error('hermes_bridge_missing_api_key');
      hermesBridgeErrorsTotal.inc();
      return;
    }
    const url = `${this.apiBase}/responses`;
    const body = {
      model: this.model,
      input: userText,
      conversation: this.conversationName,
      store: true,
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: hermesRequestHeaders(this.sessionIdHeader, this.sessionKeyHeader),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.HERMES_BRIDGE_REQ_TIMEOUT_MS || 120_000)),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        hermesBridgeErrorsTotal.inc();
        logger.error('hermes_bridge_responses_http_error', {
          status: res.status,
          err: json?.error?.message || res.statusText,
        });
        this._setApiConnected(false);
        return;
      }
      this._setApiConnected(true);
      const assistant = extractAssistantTextFromResponses(json);
      if (assistant && this.session) {
        hermesBridgeHermesToPhoneTotal.inc();
        this.session.sendPlaintextToPhone(assistantTextToPhoneRes(assistant));
      }
    } catch (err) {
      hermesBridgeErrorsTotal.inc();
      logger.error('hermes_bridge_responses_failed', { err: err?.message || String(err) });
      this._setApiConnected(false);
    }
  }

  /**
   * POST /v1/chat/completions — stateless; bridge accumulates messages[] locally (doc).
   * @param {string} userText
   */
  async _sendChatCompletion(userText) {
    const key = this.apiKey;
    if (!key) {
      logger.error('hermes_bridge_missing_api_key');
      hermesBridgeErrorsTotal.inc();
      return;
    }
    this._chatMessages.push({ role: 'user', content: userText });
    const url = `${this.apiBase}/chat/completions`;
    const body = {
      model: this.model,
      messages: [...this._chatMessages],
      stream: false,
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: hermesRequestHeaders(this.sessionIdHeader, this.sessionKeyHeader),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.HERMES_BRIDGE_REQ_TIMEOUT_MS || 120_000)),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        hermesBridgeErrorsTotal.inc();
        logger.error('hermes_bridge_chat_http_error', {
          status: res.status,
          err: json?.error?.message || res.statusText,
        });
        this._chatMessages.pop();
        this._setApiConnected(false);
        return;
      }
      this._setApiConnected(true);
      const assistant = extractAssistantTextFromChatCompletion(json);
      if (assistant) {
        this._chatMessages.push({ role: 'assistant', content: assistant });
        if (this.session) {
          hermesBridgeHermesToPhoneTotal.inc();
          this.session.sendPlaintextToPhone(assistantTextToPhoneRes(assistant));
        }
      }
    } catch (err) {
      this._chatMessages.pop();
      hermesBridgeErrorsTotal.inc();
      logger.error('hermes_bridge_chat_failed', { err: err?.message || String(err) });
      this._setApiConnected(false);
    }
  }
}

/** @type {HermesAgentBridge | null} */
let activeBridge = null;

export function shouldStartHermesAgentBridge() {
  const v = (process.env.HERMES_AGENT_BRIDGE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function getHermesBridgeConnected() {
  if (!activeBridge) return false;
  return Boolean(activeBridge._apiConnected);
}

/**
 * @param {object} opts
 * @param {object} opts.keyPair
 * @param {object} opts.config MachineRelaySession config
 */
export function startHermesAgentBridge(opts) {
  if (activeBridge) {
    logger.warn('hermes_bridge_already_running');
    return activeBridge;
  }
  const agentId = (process.env.HERMES_BRIDGE_AGENT_ID || 'default').trim() || 'default';
  const conversationId = (process.env.HERMES_BRIDGE_CONVERSATION_ID || 'default').trim();
  const participantId = (process.env.HERMES_BRIDGE_PARTICIPANT_ID || 'default').trim();
  activeBridge = new HermesAgentBridge({
    keyPair: opts.keyPair,
    config: opts.config,
    agentId,
    conversationId,
    participantId,
  });
  activeBridge.start();
  return activeBridge;
}

export function stopHermesAgentBridge() {
  if (activeBridge) {
    activeBridge.stop();
    activeBridge = null;
  }
}

export {
  extractAssistantTextFromChatCompletion,
  extractAssistantTextFromResponses,
  hermesBridgeApiMode,
  hermesConversationName,
  hermesSessionIdHeader,
  hermesSessionKeyHeader,
};
