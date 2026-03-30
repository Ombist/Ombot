import { verify } from './ed25519.js';

export function reqSigningPayload(reqJson) {
  return JSON.stringify({
    type: reqJson.type || 'req',
    id: reqJson.id || '',
    method: reqJson.method || '',
    params: reqJson.params || {},
    timestamp: Number(reqJson.timestamp || 0),
    nonce: String(reqJson.nonce || ''),
  });
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
  const payload = reqSigningPayload(reqJson);
  try {
    if (!verify(verifyPublicKey, payload, signatureHex)) return { ok: false, reason: 'signature_invalid' };
  } catch {
    return { ok: false, reason: 'signature_invalid' };
  }
  nonceMap.set(nonce, nowMs);
  return { ok: true };
}
