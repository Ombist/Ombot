/**
 * Process-wide OpenClaw Gateway WebSocket for OPENCLAW_SINGLE_CLIENT_MODE.
 * Survives iOS disconnect/reconnect so in-flight model replies can still reach the phone.
 */
import { logger } from './logger.js';
import { GatewayAgentClient } from './gatewayAgentClient.js';

function assistantTextToPhoneRes(text) {
  return JSON.stringify({
    type: 'res',
    payload: { text },
  });
}

function isSingleClientModeEnabled() {
  return ['1', 'true', 'yes'].includes(
    String(process.env.OPENCLAW_SINGLE_CLIENT_MODE || '').trim().toLowerCase()
  );
}

/** @type {GatewayAgentClient | null} */
let sharedClient = null;
/** @type {import('./machineRelaySession.js').MachineRelaySession | null} */
let activeSession = null;
let started = false;

/**
 * @param {import('./machineRelaySession.js').MachineRelaySession} session
 */
export function registerSingleClientActiveSession(session) {
  activeSession = session;
}

/**
 * @param {import('./machineRelaySession.js').MachineRelaySession} session
 */
export function unregisterSingleClientActiveSession(session) {
  if (activeSession === session) {
    activeSession = null;
  }
}

function deliverAssistantTextToActiveSession(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return;

  const session = activeSession;
  if (!session || session._destroyed) {
    logger.warn('single_client_reply_dropped', {
      reason: 'no_active_session',
      textLen: trimmed.length,
    });
    return;
  }
  if (!session.isClientConnected()) {
    logger.warn('single_client_reply_dropped', {
      reason: 'client_not_connected',
      traceId: session.traceId,
      textLen: trimmed.length,
    });
    return;
  }

  const frame = assistantTextToPhoneRes(trimmed);
  if (!session.sendEncryptedToClientWs(frame)) {
    logger.warn('single_client_reply_send_failed', {
      traceId: session.traceId,
      textLen: trimmed.length,
    });
  }
}

function ensureSharedClient() {
  if (sharedClient) return sharedClient;
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789').trim();
  const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  sharedClient = new GatewayAgentClient({
    gatewayUrl,
    gatewayToken,
    agentMethod: (process.env.OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD || 'agent').trim(),
    onAssistantText: deliverAssistantTextToActiveSession,
    onError: (err) => {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      logger.warn('single_client_gateway_shared_error', { message: msg });
      const session = activeSession;
      if (!session || session._destroyed) return;
      session.notifyClientJson({
        type: 'error',
        message: msg.startsWith('gateway_') ? msg : `gateway_error:${msg}`,
        traceId: session.traceId,
      });
    },
  });
  return sharedClient;
}

/** Start shared Gateway WS at ombot boot (single-client mode). */
export function startSingleClientGateway() {
  if (!isSingleClientModeEnabled()) return;
  if (started) {
    ensureSharedClient().ensureConnected();
    return;
  }
  started = true;
  const client = ensureSharedClient();
  client.ensureConnected();
  logger.info('single_client_gateway_shared_started');
}

export function stopSingleClientGateway() {
  if (sharedClient) {
    sharedClient.destroy();
    sharedClient = null;
  }
  activeSession = null;
  started = false;
}

export function getSharedGatewayReady() {
  return Boolean(sharedClient?.isReady());
}

export function getSharedGatewayClient() {
  if (!isSingleClientModeEnabled()) return null;
  return ensureSharedClient();
}

/**
 * @param {import('./machineRelaySession.js').MachineRelaySession | null | undefined} session
 */
export function getSingleClientActiveSessionForTests(session) {
  if (session !== undefined) activeSession = session;
  return activeSession;
}
