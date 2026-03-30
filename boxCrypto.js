/**
 * Per-connection encryption: 對方公鑰加密、己方私鑰解密。
 * 使用 NaCl box (X25519 + XSalsa20-Poly1305)，與 ED25519 同屬 NaCl 生態。
 */
import crypto from 'crypto';
import nacl from 'tweetnacl';

const NONCE_LENGTH = 24;

function b64Encode(u8) {
  return Buffer.from(u8).toString('base64');
}

function b64Decode(str) {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/** 從 seed 產生 box key pair（同一 process 可重現） */
export function boxKeyPairFromSeed(seed) {
  const secret = crypto.createHash('sha256').update((seed || 'default').trim()).digest();
  return nacl.box.keyPair.fromSecretKey(new Uint8Array(secret));
}

/** 隨機產生一組 box key pair（每條連線獨立） */
export function boxKeyPair() {
  return nacl.box.keyPair();
}

/**
 * 加密：用對方的 public key 加密，對方用其 private key 解密。
 * 回傳 { nonce: base64, payload: base64 }。
 */
export function encrypt(plaintext, otherPublicKey, mySecretKey) {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const msg = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const box = nacl.box(msg, nonce, otherPublicKey, mySecretKey);
  return { nonce: b64Encode(nonce), payload: b64Encode(box) };
}

/**
 * 解密：用己方 private key + 對方 public key 解密。
 */
export function decrypt(nonceB64, payloadB64, otherPublicKey, mySecretKey) {
  const nonce = b64Decode(nonceB64);
  const box = b64Decode(payloadB64);
  const out = nacl.box.open(box, nonce, otherPublicKey, mySecretKey);
  return out ? new TextDecoder().decode(out) : null;
}

export function publicKeyToBase64(pk) {
  return b64Encode(pk);
}

export function base64ToPublicKey(b64) {
  return b64Decode(b64);
}
