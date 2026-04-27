import fs from 'fs';
import https from 'https';
import { logger } from './logger.js';

/**
 * Optional HTTPS agent for outbound middleware WebSocket (wss://) when client
 * certificates are required by ingress (Nginx mTLS).
 *
 * Env (all optional; if cert or key missing, no agent is created):
 * - MIDDLEWARE_TLS_CLIENT_CERT_PATH — PEM client certificate
 * - MIDDLEWARE_TLS_CLIENT_KEY_PATH — PEM client private key
 * - MIDDLEWARE_TLS_CA_PATH — optional extra CA bundle to trust server (e.g. private CA)
 */
export function createMiddlewareHttpsAgent() {
  const certPath = String(process.env.MIDDLEWARE_TLS_CLIENT_CERT_PATH || '').trim();
  const keyPath = String(process.env.MIDDLEWARE_TLS_CLIENT_KEY_PATH || '').trim();
  const caPath = String(process.env.MIDDLEWARE_TLS_CA_PATH || '').trim();
  if (!certPath && !keyPath) {
    return null;
  }
  if (!certPath || !keyPath) {
    logger.error('middleware_tls_client_incomplete', {
      msg: 'MIDDLEWARE_TLS_CLIENT_CERT_PATH and MIDDLEWARE_TLS_CLIENT_KEY_PATH must both be set, or both unset',
      certPath: Boolean(certPath),
      keyPath: Boolean(keyPath),
    });
    process.exit(1);
  }
  try {
    const options = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    if (caPath) {
      options.ca = fs.readFileSync(caPath);
    }
    const agent = new https.Agent(options);
    logger.info('middleware_tls_client_agent_enabled', {
      certPath,
      keyPath,
      caPath: caPath || null,
    });
    return agent;
  } catch (err) {
    logger.error('middleware_tls_client_agent_failed', { err: err.message, certPath, keyPath, caPath });
    process.exit(1);
  }
}
