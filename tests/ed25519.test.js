import { describe, expect, it } from 'vitest';
import { generateKeyPairFromSeed, sign, verify } from '../ed25519.js';

describe('ed25519', () => {
  it('generates deterministic key pair from seed', () => {
    const a = generateKeyPairFromSeed('seed-a');
    const b = generateKeyPairFromSeed('seed-a');
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });

  it('signs and verifies payload', () => {
    const kp = generateKeyPairFromSeed('seed-sign');
    const message = JSON.stringify({ ok: true });
    const signatureHex = sign(kp.secretKey, message);
    expect(verify(kp.publicKey, message, signatureHex)).toBe(true);
    expect(verify(kp.publicKey, 'tampered', signatureHex)).toBe(false);
  });
});
