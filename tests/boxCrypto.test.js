import { describe, expect, it } from 'vitest';
import { base64ToPublicKey, boxKeyPair, decrypt, encrypt, publicKeyToBase64 } from '../boxCrypto.js';

describe('boxCrypto', () => {
  it('roundtrips encrypted payload', () => {
    const alice = boxKeyPair();
    const bob = boxKeyPair();
    const plain = JSON.stringify({ hello: 'ombot' });

    const { nonce, payload } = encrypt(plain, bob.publicKey, alice.secretKey);
    const out = decrypt(nonce, payload, alice.publicKey, bob.secretKey);
    expect(out).toBe(plain);
  });

  it('converts base64 public keys correctly', () => {
    const pair = boxKeyPair();
    const b64 = publicKeyToBase64(pair.publicKey);
    const restored = base64ToPublicKey(b64);
    expect(Buffer.from(restored).toString('hex')).toBe(Buffer.from(pair.publicKey).toString('hex'));
  });
});
