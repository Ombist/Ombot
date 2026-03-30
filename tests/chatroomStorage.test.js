import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadChatroomKeysSync, rotateChatroomKeysEncryptionSync, saveChatroomKeysSync, saveChatroomPeerKeySync } from '../chatroomStorage.js';

describe('chatroomStorage', () => {
  it('saves and loads chatroom key pairs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;

    saveChatroomKeysSync('support', 'room-a', 'cHViLWI2NA==', 'c2VjLWI2NA==', 'peer-b64');
    const loaded = loadChatroomKeysSync('support', 'room-a');

    expect(Buffer.from(loaded.publicKey).toString('base64')).toBe('cHViLWI2NA==');
    expect(Buffer.from(loaded.secretKey).toString('base64')).toBe('c2VjLWI2NA==');
    expect(loaded.peerPublicKeyBase64).toBe('peer-b64');
  });

  it('supports legacy default agent path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;
    const legacyDir = path.join(dir, 'chatrooms');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'default.json'),
      JSON.stringify({
        publicKeyBase64: 'YQ==',
        secretKeyBase64: 'Yg==',
        peerPublicKeyBase64: 'peer-x',
      })
    );

    const loaded = loadChatroomKeysSync('default', 'default');
    expect(Buffer.from(loaded.publicKey).toString('base64')).toBe('YQ==');
    expect(Buffer.from(loaded.secretKey).toString('base64')).toBe('Yg==');
    expect(loaded.peerPublicKeyBase64).toBe('peer-x');
  });

  it('updates peer key without changing local keypair', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;
    saveChatroomKeysSync('a1', 'r1', 'YQ==', 'Yg==', 'old-peer');
    saveChatroomPeerKeySync('a1', 'r1', 'new-peer');
    const loaded = loadChatroomKeysSync('a1', 'r1');
    expect(Buffer.from(loaded.publicKey).toString('base64')).toBe('YQ==');
    expect(loaded.peerPublicKeyBase64).toBe('new-peer');
  });

  it('stores separate peer keys per participant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;
    saveChatroomKeysSync('a2', 'room-p', 'YQ==', 'Yg==', 'peer-ios-a', 'ios-a');
    saveChatroomPeerKeySync('a2', 'room-p', 'peer-ios-b', 'ios-b');

    const a = loadChatroomKeysSync('a2', 'room-p', 'ios-a');
    const b = loadChatroomKeysSync('a2', 'room-p', 'ios-b');
    expect(a.peerPublicKeyBase64).toBe('peer-ios-a');
    expect(b.peerPublicKeyBase64).toBe('peer-ios-b');
  });

  it('encrypts on disk when OPENCLAW_KEY_ENCRYPTION_KEYS is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;
    process.env.OPENCLAW_KEY_ENCRYPTION_KEYS = Buffer.alloc(32, 7).toString('base64');

    saveChatroomKeysSync('secure-agent', 'secure-room', 'YQ==', 'Yg==', 'peer-s');
    const filePath = path.join(dir, 'agents', 'secure-agent', 'chatrooms', 'secure-room.json');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.encrypted).toBeTruthy();

    const loaded = loadChatroomKeysSync('secure-agent', 'secure-room');
    expect(Buffer.from(loaded.publicKey).toString('base64')).toBe('YQ==');
    expect(loaded.peerPublicKeyBase64).toBe('peer-s');
  });

  it('rotates encrypted records with new key order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-test-'));
    process.env.OPENCLAW_DATA_DIR = dir;
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const newKey = Buffer.alloc(32, 2).toString('base64');
    process.env.OPENCLAW_KEY_ENCRYPTION_KEYS = `${oldKey}`;
    saveChatroomKeysSync('agent-r', 'room-r', 'YQ==', 'Yg==', 'peer-r');

    process.env.OPENCLAW_KEY_ENCRYPTION_KEYS = `${newKey},${oldKey}`;
    const result = rotateChatroomKeysEncryptionSync();
    expect(result.rotated).toBe(1);
    expect(result.skipped).toBe(0);

    const loaded = loadChatroomKeysSync('agent-r', 'room-r');
    expect(loaded.peerPublicKeyBase64).toBe('peer-r');
  });
});
