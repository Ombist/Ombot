import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectDeviceBlock,
  buildDeviceAuthPayloadV3,
  loadOrCreateDeviceIdentity,
  persistHelloOkDeviceAuth,
  resolveDeviceStatePath,
  signDevicePayload,
  loadStoredDeviceToken,
} from '../gatewayDeviceIdentity.js';

function verifyEd25519Signature(publicKeyPem, payloadUtf8, sigB64Url) {
  const pad =
    sigB64Url.length % 4 === 0 ? '' : '='.repeat(4 - (sigB64Url.length % 4));
  const b64 = (sigB64Url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const sig = Buffer.from(b64, 'base64');
  const key = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(null, Buffer.from(payloadUtf8, 'utf8'), key, sig);
}

describe('gatewayDeviceIdentity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('buildDeviceAuthPayloadV3 matches upstream field order', () => {
    const p = buildDeviceAuthPayloadV3({
      deviceId: 'dev1',
      clientId: 'openclaw',
      clientMode: 'service',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs: 1700000000000,
      token: 'tok',
      nonce: 'nonce-a',
      platform: 'darwin',
      deviceFamily: 'desktop',
    });
    expect(p).toBe(
      [
        'v3',
        'dev1',
        'openclaw',
        'service',
        'operator',
        'operator.read,operator.write',
        '1700000000000',
        'tok',
        'nonce-a',
        'darwin',
        'desktop',
      ].join('|')
    );
  });

  it('signDevicePayload produces verifiable Ed25519 signatures', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const payload = 'plain-text';
    const sig = signDevicePayload(privateKeyPem, payload);
    expect(verifyEd25519Signature(publicKeyPem, payload, sig)).toBe(true);
  });

  it('buildConnectDeviceBlock signs the v3 payload (deterministic signedAt)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-devid-'));
    const stateFile = path.join(dir, 'device.json');
    vi.stubEnv('OPENCLAW_GATEWAY_DEVICE_STATE_PATH', stateFile);

    const identity = loadOrCreateDeviceIdentity();
    vi.spyOn(Date, 'now').mockReturnValue(555000);

    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const block = buildConnectDeviceBlock({
      identity,
      nonce: 'gw-nonce',
      scopes,
      role: 'operator',
      clientId: 'openclaw',
      clientMode: 'service',
      platform: 'darwin',
      deviceFamily: 'test',
      signatureToken: 'session-tok',
    });

    expect(block.id).toBe(identity.deviceId);
    expect(block.nonce).toBe('gw-nonce');
    expect(typeof block.signature).toBe('string');
    expect(block.signedAt).toBe(555000);

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'openclaw',
      clientMode: 'service',
      role: 'operator',
      scopes,
      signedAtMs: 555000,
      token: 'session-tok',
      nonce: 'gw-nonce',
      platform: 'darwin',
      deviceFamily: 'test',
    });

    expect(verifyEd25519Signature(identity.publicKeyPem, payload, block.signature)).toBe(true);
  });

  it('persistHelloOkDeviceAuth stores deviceToken for loadStoredDeviceToken', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-devtok-'));
    const stateFile = path.join(dir, 'device.json');
    vi.stubEnv('OPENCLAW_GATEWAY_DEVICE_STATE_PATH', stateFile);

    loadOrCreateDeviceIdentity();

    persistHelloOkDeviceAuth({
      deviceToken: 'dt-secret',
      scopes: ['operator.read', 'operator.write'],
    });

    expect(resolveDeviceStatePath()).toBe(stateFile);
    expect(loadStoredDeviceToken()).toBe('dt-secret');
  });
});
