import crypto from 'crypto';
import { verify } from './ed25519.js';

/**
 * Deep-sort object keys so JSON.stringify matches iOS JSONSerialization(.sortedKeys)
 * for the same logical payload (avoids cross-platform key-order signature breaks).
 */
function sortKeysDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  return Object.keys(value)
    .sort()
    .reduce((acc, k) => {
      acc[k] = sortKeysDeep(value[k]);
      return acc;
    }, {});
}

/** Legacy wire format (matches older iOS JSONSerialization without sortedKeys). */
function reqSigningPayloadLegacy(reqJson) {
  return JSON.stringify({
    type: reqJson.type || 'req',
    id: reqJson.id || '',
    method: reqJson.method || '',
    params: reqJson.params || {},
    timestamp: Number(reqJson.timestamp || 0),
    nonce: String(reqJson.nonce || ''),
  });
}

/**
 * Canonical signing string (deep-sorted keys). Matches iOS JSONSerialization(.sortedKeys).
 * Prefer this for new clients; server verification also accepts [reqSigningPayloadLegacy].
 */
export function reqSigningPayload(reqJson) {
  const body = {
    type: reqJson.type || 'req',
    id: reqJson.id || '',
    method: reqJson.method || '',
    params: reqJson.params || {},
    timestamp: Number(reqJson.timestamp || 0),
    nonce: String(reqJson.nonce || ''),
  };
  return JSON.stringify(sortKeysDeep(body));
}

/**
 * Byte-stable signing string (no platform JSON key-order quirks). Matches iOS
 * `ConnectionViewModel.stableReqSigningUTF8` — root keys id, method, nonce, params, timestamp, type;
 * params keys sorted lexicographically; values JSON.stringify'd per value.
 */
export function reqSigningPayloadStable(reqJson) {
  const id = String(reqJson.id ?? '');
  const method = String(reqJson.method ?? '');
  const nonce = String(reqJson.nonce ?? '');
  const type = String(reqJson.type || 'req');
  const ts = Number(reqJson.timestamp || 0);
  const tss = Number.isFinite(ts) ? String(Math.trunc(ts)) : '0';
  const raw =
    reqJson.params && typeof reqJson.params === 'object' && !Array.isArray(reqJson.params)
      ? reqJson.params
      : {};
  const keys = Object.keys(raw).sort();
  const inner = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(raw[k])}`).join(',');
  const paramsJson = `{${inner}}`;
  return `{"id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"nonce":${JSON.stringify(nonce)},"params":${paramsJson},"timestamp":${tss},"type":${JSON.stringify(type)}}`;
}

export function pruneSeenNonces(nonceMap, nowMs, nonceTtlMs) {
  for (const [k, ts] of nonceMap.entries()) {
    if (nowMs - ts > nonceTtlMs) nonceMap.delete(k);
  }
}

/** SHA-256 hex (UTF-8) of signing payload variants — for audit when verify fails. */
export function reqSigningPayloadSha256Hex(reqJson) {
  const stable = reqSigningPayloadStable(reqJson);
  const canonical = reqSigningPayload(reqJson);
  const legacy = reqSigningPayloadLegacy(reqJson);
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  return {
    stableSha256: h(stable),
    canonicalSha256: h(canonical),
    legacySha256: h(legacy),
  };
}

export function validateReqSignature({
  reqJson,
  verifyPublicKey,
  nonceMap,
  requireSignature,
  signatureMaxAgeMs,
  nonceTtlMs,
  nowMs = Date.now(),
}) {
  if (!requireSignature) return { ok: true };
  if (!verifyPublicKey) return { ok: false, reason: 'signature_key_missing' };
  const ts = Number(reqJson.timestamp || 0);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'signature_timestamp_invalid' };
  if (Math.abs(nowMs - ts) > signatureMaxAgeMs) return { ok: false, reason: 'signature_expired' };
  const nonce = String(reqJson.nonce || '').trim();
  if (!nonce) return { ok: false, reason: 'signature_nonce_missing' };
  pruneSeenNonces(nonceMap, nowMs, nonceTtlMs);
  if (nonceMap.has(nonce)) return { ok: false, reason: 'replay' };
  const signatureHex = String(reqJson.signature || '').trim();
  if (!signatureHex) return { ok: false, reason: 'signature_missing' };
  const stable = reqSigningPayloadStable(reqJson);
  const canonical = reqSigningPayload(reqJson);
  const legacy = reqSigningPayloadLegacy(reqJson);
  let verified = false;
  try {
    verified =
      verify(verifyPublicKey, stable, signatureHex) ||
      verify(verifyPublicKey, canonical, signatureHex) ||
      verify(verifyPublicKey, legacy, signatureHex);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'signature_invalid' };
  nonceMap.set(nonce, nowMs);
  return { ok: true };
}
