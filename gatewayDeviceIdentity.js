/**
 * OpenClaw Gateway device identity + v3 auth payloads.
 * Signing + deviceId derivation match upstream (use the **same OpenClaw / Gateway
 * release** you deploy; when upstream changes payload layout, update this file in lockstep):
 * - `openclaw/src/gateway/device-auth.ts` — `buildDeviceAuthPayloadV3`
 * - `openclaw/src/infra/device-identity.ts` — device fingerprint, Ed25519 sign/verify
 *
 * Protocol reference: https://openclaw.cc/gateway/protocol
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = /** @type {Buffer} */ (key.export({ type: 'spki', format: 'der' }));
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function normalizeDeviceMetadataForAuth(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function buildDeviceAuthPayloadV3(params) {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join('|');
}

export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function defaultStatePath() {
  const dataDir = (process.env.OPENCLAW_DATA_DIR || './data').trim() || './data';
  const override = (process.env.OPENCLAW_GATEWAY_DEVICE_STATE_PATH || '').trim();
  if (override) return override;
  return path.join(dataDir, 'ombot-gateway-device.json');
}

/**
 * @typedef {object} OmbotGatewayDeviceState
 * @property {1} version
 * @property {string} deviceId
 * @property {string} publicKeyPem
 * @property {string} privateKeyPem
 * @property {string} [deviceToken]
 * @property {string[]} [storedScopes]
 * @property {number} [createdAtMs]
 */

/**
 * @returns {string}
 */
export function resolveDeviceStatePath() {
  return defaultStatePath();
}

/**
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }}
 */
export function loadOrCreateDeviceIdentity() {
  const filePath = defaultStatePath();
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derived = fingerprintPublicKey(parsed.publicKeyPem);
        if (derived && derived !== parsed.deviceId) {
          const fixed = { ...parsed, deviceId: derived };
          fs.writeFileSync(filePath, `${JSON.stringify(fixed, null, 2)}\n`, { mode: 0o600 });
          return {
            deviceId: derived,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    /* regenerate */
  }

  const identity = generateIdentity();
  /** @type {OmbotGatewayDeviceState} */
  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

/**
 * @param {{ deviceToken?: string | null, scopes?: string[] }} auth
 */
export function persistHelloOkDeviceAuth(auth) {
  if (!auth?.deviceToken || typeof auth.deviceToken !== 'string') return;
  const filePath = defaultStatePath();
  let body = {};
  try {
    if (fs.existsSync(filePath)) {
      body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    body = {};
  }
  body.version = 1;
  body.deviceToken = auth.deviceToken;
  if (Array.isArray(auth.scopes)) {
    body.storedScopes = auth.scopes.map((s) => String(s));
  }
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

export function loadStoredDeviceToken() {
  try {
    const filePath = defaultStatePath();
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const t = parsed?.deviceToken;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {
    /* ignore */
  }
  return null;
}

export function loadStoredScopes() {
  try {
    const filePath = defaultStatePath();
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const s = parsed?.storedScopes;
    if (Array.isArray(s) && s.every((x) => typeof x === 'string')) return s;
  } catch {
    /* ignore */
  }
  return null;
}

export function deviceAuthInsecureSkip() {
  return ['1', 'true', 'yes'].includes(
    String(process.env.OPENCLAW_GATEWAY_DEVICE_INSECURE_SKIP || '')
      .trim()
      .toLowerCase()
  );
}

export function gatewayLegacyBlindConnect() {
  return ['1', 'true', 'yes'].includes(
    String(process.env.OPENCLAW_GATEWAY_LEGACY_BLIND_CONNECT || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * Build `connect.params.device` for OpenClaw Gateway (post-challenge).
 * @param {object} opts
 * @param {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }} opts.identity
 * @param {string} opts.nonce
 * @param {string[]} opts.scopes
 * @param {string} opts.role
 * @param {string} opts.clientId
 * @param {string} opts.clientMode
 * @param {string} [opts.platform]
 * @param {string} [opts.deviceFamily]
 * @param {string | null} [opts.signatureToken]
 */
export function buildConnectDeviceBlock(opts) {
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: opts.identity.deviceId,
    clientId: opts.clientId,
    clientMode: opts.clientMode,
    role: opts.role,
    scopes: opts.scopes,
    signedAtMs,
    token: opts.signatureToken ?? '',
    nonce: opts.nonce,
    platform: opts.platform ?? null,
    deviceFamily: opts.deviceFamily ?? null,
  });
  const signature = signDevicePayload(opts.identity.privateKeyPem, payload);
  return {
    id: opts.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(opts.identity.publicKeyPem),
    signature,
    signedAt: signedAtMs,
    nonce: opts.nonce,
  };
}
