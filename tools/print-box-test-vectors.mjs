#!/usr/bin/env node
/**
 * Prints NaCl box test vectors matching docs/e2e-box-test-vectors.json
 * Run from repo root: node Ombot/tools/print-box-test-vectors.mjs
 * Or: cd Ombot && node tools/print-box-test-vectors.mjs
 */
import nacl from 'tweetnacl';
import crypto from 'crypto';

function seedPair(label) {
  const seed = crypto.createHash('sha256').update('e2e-vector-' + label).digest();
  return nacl.box.keyPair.fromSecretKey(seed);
}

const alice = seedPair('alice');
const bob = seedPair('bob');
const plain = new TextEncoder().encode(
  JSON.stringify({ type: 'req', id: 't1', method: 'agent', params: { message: 'hi' } })
);
const nonce = Buffer.alloc(24);
for (let i = 0; i < 24; i++) nonce[i] = i + 1;
const payload = nacl.box(plain, nonce, bob.publicKey, alice.secretKey);

const out = {
  description:
    'NaCl box vectors aligned with Ombot/boxCrypto.js (tweetnacl). Nonce is 24 bytes; payload is ciphertext only.',
  plainTextUtf8: new TextDecoder().decode(plain),
  alicePublicB64: Buffer.from(alice.publicKey).toString('base64'),
  aliceSecretB64: Buffer.from(alice.secretKey).toString('base64'),
  bobPublicB64: Buffer.from(bob.publicKey).toString('base64'),
  bobSecretB64: Buffer.from(bob.secretKey).toString('base64'),
  nonceB64: nonce.toString('base64'),
  payloadB64: Buffer.from(payload).toString('base64'),
};

console.log(JSON.stringify(out, null, 2));
const opened = nacl.box.open(payload, nonce, alice.publicKey, bob.secretKey);
const ok = opened && new TextDecoder().decode(opened) === out.plainTextUtf8;
console.error('roundtrip_ok', ok);
