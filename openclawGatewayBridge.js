import { WebSocket } from 'ws';
import { logger } from './logger.js';
import { MachineRelaySession } from './machineRelaySession.js';
import {
  gatewayBridgeConnectState,
  gatewayBridgeErrorsTotal,
  gatewayBridgePhoneToGatewayTotal,
  gatewayBridgeGatewayToPhoneTotal,
} from './metrics.js';

function makeReqId() {
  return `ombot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      this._sendConnectHandshake();
    });

    this.gatewayWs.on('message', (data) => {
      this._onGatewayMessage(data);
    });

    this.gatewayWs.on('close', () => {
      this._connecting = false;
      this._gatewayConnected = false;
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

  _sendConnectHandshake() {
    if (!this.gatewayWs || this.gatewayWs.readyState !== 1) return;
    const id = makeReqId();
    const params = {
      minProtocol: Number(process.env.OPENCLAW_BRIDGE_MIN_PROTOCOL || 1),
      maxProtocol: Number(process.env.OPENCLAW_BRIDGE_MAX_PROTOCOL || 9),
      client: {
        id: 'ombot-gateway-bridge',
        name: 'ombot',
        version: process.env.npm_package_version || '1.0.0',
      },
      role: (process.env.OPENCLAW_BRIDGE_ROLE || 'operator').trim(),
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
        gatewayBridgeConnectState.set(1);
        logger.info('gateway_bridge_connected', { id });
        this._drainQueue();
      } else {
        gatewayBridgeErrorsTotal.inc();
        logger.error('gateway_bridge_connect_rejected', {
          id,
          error: msg?.error,
        });
        try {
          this.gatewayWs?.close();
        } catch {
          /* ignore */
        }
        this._scheduleGatewayReconnect();
      }
    });
    this.gatewayWs.send(JSON.stringify(frame));
    logger.info('gateway_bridge_connect_sent', { id, url: this.gatewayUrl });
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
    if (this._inFlight || !this._gatewayConnected || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
      return;
    }
    const text = this._queue.shift();
    if (text == null) return;
    this._inFlight = true;
    try {
      await this._sendAgentTurn(text);
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
      const frame = {
        type: 'req',
        id,
        method: this.agentMethod,
        params: { message: userText },
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
        const t = extractAssistantTextFromGateway(resMsg);
        if (t && this.session) {
          gatewayBridgeGatewayToPhoneTotal.inc();
          this.session.sendPlaintextToPhone(assistantTextToPhoneRes(t));
        }
        resolve();
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
