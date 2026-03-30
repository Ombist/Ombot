/**
 * Ombot：每個 Agent 為獨立「App」身份，底下各有自己的 Chatroom。
 * 儲存：data/agents/<agentId>/chatrooms/<conversationId>.json
 * 同一 BOT 不同 Agent 金鑰與對話完全隔離。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function getDataDir() {
  return process.env.OPENCLAW_DATA_DIR || path.join(process.cwd(), 'data');
}

function loadEncryptionKeys() {
  const raw = (process.env.OPENCLAW_KEY_ENCRYPTION_KEYS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, idx) => ({
      id: `k${idx + 1}`,
      key: Buffer.from(s, 'base64'),
    }))
    .filter((k) => k.key.length === 32);
}

function encryptPayload(data) {
  const keys = loadEncryptionKeys();
  if (keys.length === 0) return { ...data, version: 1 };
  const primary = keys[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primary.key, iv);
  const plain = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 2,
    encrypted: {
      keyId: primary.id,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    },
  };
}

function decryptPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.version || data.version === 1) return data;
  if (data.version !== 2 || !data.encrypted) return null;

  const keys = loadEncryptionKeys();
  if (keys.length === 0) return null;
  const iv = Buffer.from(data.encrypted.iv, 'base64');
  const tag = Buffer.from(data.encrypted.tag, 'base64');
  const encrypted = Buffer.from(data.encrypted.data, 'base64');

  for (const k of keys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', k.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      // Try next key candidate for rotation support.
    }
  }
  return null;
}

function safeFilename(id) {
  if (!id || typeof id !== 'string') return 'default';
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'default';
}

function agentChatroomPath(agentId, conversationId) {
  const agentDir = path.join(getDataDir(), 'agents', safeFilename(agentId));
  const chatroomsDir = path.join(agentDir, 'chatrooms');
  return path.join(chatroomsDir, safeFilename(conversationId) + '.json');
}

function legacyChatroomPath(conversationId) {
  return path.join(getDataDir(), 'chatrooms', safeFilename(conversationId) + '.json');
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function b64ToU8(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function u8ToB64(u8) {
  return Buffer.from(u8).toString('base64');
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = decryptPayload(JSON.parse(raw));
    if (!data || !data.publicKeyBase64 || !data.secretKeyBase64) return null;
    const participants = normalizeParticipants(data);
    return {
      publicKey: b64ToU8(data.publicKeyBase64),
      secretKey: b64ToU8(data.secretKeyBase64),
      peerPublicKeyBase64: data.peerPublicKeyBase64 ?? participants.default ?? null,
      peerPublicKeys: participants,
    };
  } catch {
    return null;
  }
}

function normalizeParticipants(data) {
  if (data && typeof data.participants === 'object' && data.participants !== null) {
    const entries = Object.entries(data.participants)
      .filter(([k, v]) => typeof k === 'string' && k && typeof v === 'string' && v);
    return Object.fromEntries(entries);
  }
  if (data?.peerPublicKeyBase64) {
    return { default: data.peerPublicKeyBase64 };
  }
  return {};
}

/**
 * 讀取指定 Agent 下、指定 Chatroom 的金鑰（同步）。
 * agentId 未傳或 'default' 時會先嘗試舊路徑 data/chatrooms/<conversationId>.json 以相容既有資料。
 */
export function loadChatroomKeysSync(agentId, conversationId, participantId = 'default') {
  const aid = agentId || 'default';
  const cid = conversationId || 'default';
  const pid = participantId || 'default';
  const newPath = agentChatroomPath(aid, cid);
  ensureDirFor(newPath);
  let data = readJsonFile(newPath);
  if (!data && aid === 'default') data = readJsonFile(legacyChatroomPath(cid));
  if (!data) return null;
  return {
    ...data,
    peerPublicKeyBase64: data.peerPublicKeys[pid] ?? data.peerPublicKeys.default ?? data.peerPublicKeyBase64 ?? null,
  };
}

/**
 * 儲存指定 Agent 下、指定 Chatroom 的金鑰。
 */
export function saveChatroomKeysSync(
  agentId,
  conversationId,
  publicKeyBase64,
  secretKeyBase64,
  peerPublicKeyBase64 = null,
  participantId = 'default',
  peerPublicKeys = null
) {
  const aid = agentId || 'default';
  const cid = conversationId || 'default';
  const pid = participantId || 'default';
  const filePath = agentChatroomPath(aid, cid);
  ensureDirFor(filePath);
  const mergedParticipants = peerPublicKeys
    ? { ...peerPublicKeys }
    : { ...(readJsonFile(filePath)?.peerPublicKeys || {}) };
  if (peerPublicKeyBase64 != null) {
    mergedParticipants[pid] = peerPublicKeyBase64;
  }
  const legacyPeer = mergedParticipants.default ?? peerPublicKeyBase64 ?? null;
  const payload = encryptPayload({
    publicKeyBase64,
    secretKeyBase64,
    ...(legacyPeer != null && { peerPublicKeyBase64: legacyPeer }),
    participants: mergedParticipants,
  });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 0), 'utf8');
}

/** 僅更新該 Agent 下該 Chatroom 的對方公鑰 */
export function saveChatroomPeerKeySync(agentId, conversationId, peerPublicKeyBase64, participantId = 'default') {
  const keys = loadChatroomKeysSync(agentId, conversationId, participantId);
  if (!keys) return;
  saveChatroomKeysSync(
    agentId,
    conversationId,
    u8ToB64(keys.publicKey),
    u8ToB64(keys.secretKey),
    peerPublicKeyBase64,
    participantId,
    keys.peerPublicKeys
  );
}

export function rotateChatroomKeysEncryptionSync() {
  const keys = loadEncryptionKeys();
  if (keys.length === 0) return { rotated: 0, skipped: 0 };
  let rotated = 0;
  let skipped = 0;
  const base = path.join(getDataDir(), 'agents');
  if (!fs.existsSync(base)) return { rotated, skipped };

  const agents = fs.readdirSync(base);
  for (const aid of agents) {
    const chatroomsDir = path.join(base, aid, 'chatrooms');
    if (!fs.existsSync(chatroomsDir)) continue;
    for (const file of fs.readdirSync(chatroomsDir)) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(chatroomsDir, file);
      const loaded = readJsonFile(fp);
      if (!loaded) {
        skipped++;
        continue;
      }
      saveChatroomKeysSync(
        aid,
        file.replace(/\.json$/, ''),
        u8ToB64(loaded.publicKey),
        u8ToB64(loaded.secretKey),
        loaded.peerPublicKeyBase64,
        'default',
        loaded.peerPublicKeys
      );
      rotated++;
    }
  }
  return { rotated, skipped };
}
