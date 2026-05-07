import { describe, expect, it } from 'vitest';
import { generateKeyPairFromSeed, sign } from '../ed25519.js';
import { reqSigningPayloadSha256Hex, reqSigningPayloadStable, validateReqSignature } from '../securityGuards.js';

/** Mirror pre-canonical server stringification (used to simulate older iOS clients). */
function legacySigningString(req) {
  return JSON.stringify({
    type: req.type || 'req',
    id: req.id || '',
    method: req.method || '',
    params: req.params || {},
    timestamp: Number(req.timestamp || 0),
    nonce: String(req.nonce || ''),
  });
}

describe('security guards', () => {
  it('validates signature and rejects replay', () => {
    const kp = generateKeyPairFromSeed('guard-seed');
    const now = Date.now();
    const req = {
      type: 'req',
      id: '1',
      method: 'agent',
      params: { message: 'hi' },
      timestamp: now,
      nonce: 'nonce-1',
    };
    req.signature = sign(kp.secretKey, reqSigningPayloadStable(req));
    const nonceMap = new Map();
    const first = validateReqSignature({
      reqJson: req,
      verifyPublicKey: kp.publicKey,
      nonceMap,
      requireSignature: true,
      signatureMaxAgeMs: 60_000,
      nonceTtlMs: 300_000,
      nowMs: now,
    });
    expect(first.ok).toBe(true);

    const replay = validateReqSignature({
      reqJson: req,
      verifyPublicKey: kp.publicKey,
      nonceMap,
      requireSignature: true,
      signatureMaxAgeMs: 60_000,
      nonceTtlMs: 300_000,
      nowMs: now + 10,
    });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replay');
  });

  it('rejects expired and invalid signature', () => {
    const kp = generateKeyPairFromSeed('guard-seed-2');
    const now = Date.now();
    const req = {
      type: 'req',
      id: '2',
      method: 'agent',
      params: { message: 'test' },
      timestamp: now - 120_000,
      nonce: 'nonce-expired',
      signature: '00',
    };
    const expired = validateReqSignature({
      reqJson: req,
      verifyPublicKey: kp.publicKey,
      nonceMap: new Map(),
      requireSignature: true,
      signatureMaxAgeMs: 60_000,
      nonceTtlMs: 300_000,
      nowMs: now,
    });
    expect(expired.ok).toBe(false);
    expect(expired.reason).toBe('signature_expired');

    const fresh = {
      ...req,
      timestamp: now,
      nonce: 'nonce-bad-sig',
      signature: 'abcd',
    };
    const invalid = validateReqSignature({
      reqJson: fresh,
      verifyPublicKey: kp.publicKey,
      nonceMap: new Map(),
      requireSignature: true,
      signatureMaxAgeMs: 60_000,
      nonceTtlMs: 300_000,
      nowMs: now,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe('signature_invalid');
  });

  it('accepts either canonical or legacy signing payload bytes', () => {
    const kp = generateKeyPairFromSeed('guard-seed-dual');
    const now = Date.now();
    const req = {
      type: 'req',
      id: '3',
      method: 'agent',
      params: { message: 'hi', clientMessageId: 'msg-1' },
      timestamp: now,
      nonce: 'nonce-dual',
    };
    req.signature = sign(kp.secretKey, legacySigningString(req));
    const nonceMap = new Map();
    const ok = validateReqSignature({
      reqJson: req,
      verifyPublicKey: kp.publicKey,
      nonceMap,
      requireSignature: true,
      signatureMaxAgeMs: 60_000,
      nonceTtlMs: 300_000,
      nowMs: now,
    });
    expect(ok.ok).toBe(true);
  });

  it('exposes sha256 digests for all signing variants', () => {
    const req = {
      type: 'req',
      id: 'req-1',
      method: 'agent',
      nonce: 'abc',
      timestamp: 1700000000000,
      params: { message: 'HI', clientMessageId: 'msg-0' },
    };
    const d = reqSigningPayloadSha256Hex(req);
    expect(d.stableSha256).toHaveLength(64);
    expect(d.canonicalSha256).toHaveLength(64);
    expect(d.legacySha256).toHaveLength(64);
    expect(d.stableSha256).not.toBe(d.legacySha256);
  });

  it('stable signing string matches chat fixture byte-for-byte', () => {
    const req = {
      type: 'req',
      id: 'req-1',
      method: 'agent',
      nonce: 'abc',
      timestamp: 1700000000000,
      params: { message: 'HI', clientMessageId: 'msg-0' },
    };
    expect(reqSigningPayloadStable(req)).toBe(
      '{"id":"req-1","method":"agent","nonce":"abc","params":{"clientMessageId":"msg-0","message":"HI"},"timestamp":1700000000000,"type":"req"}'
    );
  });
});
