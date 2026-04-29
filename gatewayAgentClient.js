import { WebSocket } from 'ws';
import { logger } from './logger.js';

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
  const raw = (process.env.OPENCLAW_BRIDGE_OPERATOR_SCOPES || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
    } catch {
      /* fall through */
    }
  }
  return ['operator.read', 'operator.write'];
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
        id: 'ombot-single-client',
        name: 'ombot',
        version: process.env.npm_package_version || '1.0.0',
      },
      role: (process.env.OPENCLAW_BRIDGE_ROLE || 'operator').trim(),
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
      if (msg && msg.ok === true) {
        this._gatewayConnected = true;
        logger.info('single_client_gateway_connected', { id });
        this._drainQueue();
      } else {
        logger.error('single_client_gateway_connect_rejected', { id, error: msg?.error });
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
    if (this._inFlight || !this._gatewayConnected || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
      return;
    }
    const item = this._queue.shift();
    if (!item) return;
    this._inFlight = true;
    try {
      await this._sendAgentTurn(item.text, item.agentId);
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
        const t = extractAssistantTextFromGateway(resMsg);
        if (t) this.onAssistantText(t);
        resolve();
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
