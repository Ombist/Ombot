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

export function pruneSeenNonces(nonceMap, nowMs, nonceTtlMs) {
  for (const [k, ts] of nonceMap.entries()) {
    if (nowMs - ts > nonceTtlMs) nonceMap.delete(k);
  }
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
  const canonical = reqSigningPayload(reqJson);
  const legacy = reqSigningPayloadLegacy(reqJson);
  let verified = false;
  try {
    verified =
      verify(verifyPublicKey, canonical, signatureHex) ||
      verify(verifyPublicKey, legacy, signatureHex);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'signature_invalid' };
  nonceMap.set(nonce, nowMs);
  return { ok: true };
}
