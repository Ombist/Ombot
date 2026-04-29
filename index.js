import http from 'http';
import { WebSocketServer } from 'ws';
import { writeAuditEvent } from './auditLog.js';
import { generateKeyPairFromSeed } from './ed25519.js';
import { logger } from './logger.js';
import {
  activeClientConnections,
  metricsText,
  relayErrorsTotal,
} from './metrics.js';
import { createMiddlewareHttpsAgent } from './middlewareTlsAgent.js';
import { MachineRelaySession } from './machineRelaySession.js';
import {
  shouldStartGatewayBridge,
  startOpenClawGatewayBridge,
  stopOpenClawGatewayBridge,
} from './openclawGatewayBridge.js';

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

const SINGLE_CLIENT_MODE = ['1', 'true', 'yes'].includes(
  String(process.env.OPENCLAW_SINGLE_CLIENT_MODE || '').trim().toLowerCase()
);

let middlewareProtocol = 'ws:';
try {
  middlewareProtocol = new URL(MIDDLEWARE_WS_URL).protocol;
} catch (err) {
  logger.error('invalid_middleware_ws_url', { err: err.message, url: MIDDLEWARE_WS_URL });
  process.exit(1);
}
if (!SINGLE_CLIENT_MODE && REQUIRE_MIDDLEWARE_TLS && middlewareProtocol !== 'wss:') {
  logger.error('middleware_tls_required', { url: MIDDLEWARE_WS_URL });
  process.exit(1);
}

const keyPair = generateKeyPairFromSeed(SEED);
logger.info('ombot_startup', { serverPublicKeyPrefix: keyPair.publicKeyHex.slice(0, 16) });
logger.info('security_posture', {
  singleClientMode: SINGLE_CLIENT_MODE,
  middlewareTlsRequired: REQUIRE_MIDDLEWARE_TLS,
  middlewareProtocol,
  signatureRequired: REQUIRE_CLIENT_SIGNATURE,
});

const middlewareHttpsAgent = createMiddlewareHttpsAgent();

const sessionConfig = {
  MIDDLEWARE_WS_URL,
  MIDDLEWARE_AUTH_TOKEN,
  MAX_MESSAGE_BYTES,
  REQUIRE_CLIENT_SIGNATURE,
  SIGNATURE_MAX_AGE_MS,
  NONCE_TTL_MS,
  SERVER_PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  ALLOW_LEGACY_PROTOCOL,
  REQUIRED_CAPABILITIES,
  middlewareHttpsAgent,
  SINGLE_CLIENT_MODE,
};

const WS_LISTEN_HOST = (process.env.OPENCLAW_WS_LISTEN_HOST || '0.0.0.0').trim();

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

const wss = new WebSocketServer({ host: WS_LISTEN_HOST, port: PORT, path: '/ws' });

wss.on('listening', () => {
  logger.info('ws_server_listening', { host: WS_LISTEN_HOST, port: PORT, path: '/ws' });
});

if (shouldStartGatewayBridge()) {
  startOpenClawGatewayBridge({ keyPair, config: sessionConfig });
  logger.info('openclaw_gateway_bridge_enabled', {});
}

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

  const session = new MachineRelaySession({
    clientId,
    clientWs,
    keyPair,
    bridgeMode: false,
    config: sessionConfig,
  });

  clientWs.on('message', (data) => {
    if (!allowMessage(clientId)) {
      relayErrorsTotal.inc();
      writeAuditEvent('client_rate_limited', { clientId });
      session.notifyClientJson({ type: 'error', message: 'rate_limited' });
      return;
    }

    const parsed = parseClientMessage(data, clientId);
    if (!parsed) return;
    const { raw, json } = parsed;

    if (json.type === 'register_public_key' && json.publicKey) {
      const prep = session.validateAndPrepareRegister(json);
      if (!prep.ok) {
        session.notifyClientJson(prep.response);
        return;
      }
      session.completeRegisterAndConnectMiddleware(json);
      return;
    }

    if (SINGLE_CLIENT_MODE && json.type === 'encrypted') {
      const dec = session.tryDecryptClientBox(raw, json);
      if (dec && dec.json.type === 'req') {
        session.relaySignedReqToMiddleware(dec.raw, dec.json);
      }
      return;
    }

    if (json.type === 'req') {
      session.relaySignedReqToMiddleware(raw, json);
    }
  });

  clientWs.on('close', (code, reason) => {
    activeClientConnections.dec();
    rateWindow.delete(clientId);
    session.destroy();
    const reasonStr = reason && reason.length ? reason.toString() : '';
    logger.info('client_ws_close', { clientId, code, reason: reasonStr });
    writeAuditEvent('client_disconnected', { clientId, code, reason: reasonStr });
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
  stopOpenClawGatewayBridge();
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
