import crypto from 'crypto';
import nacl from 'tweetnacl';

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Generate Ed25519 key pair from seed string (SHA-256 of seed -> 32 bytes for nacl) */
export function generateKeyPairFromSeed(seedMessage) {
  const seed = crypto.createHash('sha256').update((seedMessage || 'default-seed').trim()).digest();
  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  return {
    publicKeyHex: bytesToHex(keyPair.publicKey),
    privateKeyHex: bytesToHex(keyPair.secretKey),
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  };
}

/** Sign message with secret key; returns signature as hex */
export function sign(secretKey, message) {
  const msgBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const sig = nacl.sign.detached(msgBytes, secretKey);
  return bytesToHex(sig);
}

/** Verify signature with public key */
export function verify(publicKey, message, signatureHex) {
  const msgBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const sig = hexToBytes(signatureHex);
  return nacl.sign.detached.verify(msgBytes, sig, publicKey);
}
