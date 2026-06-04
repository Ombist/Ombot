import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLIENT_HEARTBEAT_IGNORE_TYPES,
  CLIENT_HEARTBEAT_INNER_TYPES,
  MachineRelaySession,
} from '../machineRelaySession.js';
import { generateKeyPairFromSeed } from '../ed25519.js';
import { boxKeyPair, decrypt, encrypt, publicKeyToBase64 } from '../boxCrypto.js';

function baseConfig(overrides = {}) {
  return {
    MIDDLEWARE_WS_URL: 'wss://127.0.0.1:9/ws',
    MIDDLEWARE_AUTH_TOKEN: '',
    MAX_MESSAGE_BYTES: 64 * 1024,
    REQUIRE_CLIENT_SIGNATURE: false,
    SIGNATURE_MAX_AGE_MS: 5 * 60 * 1000,
    NONCE_TTL_MS: 10 * 60 * 1000,
    SERVER_PROTOCOL_VERSION: 2,
    MIN_PROTOCOL_VERSION: 2,
    ALLOW_LEGACY_PROTOCOL: false,
    REQUIRED_CAPABILITIES: ['signature', 'replay_guard'],
    middlewareHttpsAgent: undefined,
    SINGLE_CLIENT_MODE: true,
    ...overrides,
  };
}

describe('MachineRelaySession application ping', () => {
  const keyPair = generateKeyPairFromSeed('ping-test-seed');
  let clientBox;
  let serverBox;
  let sent;

  beforeEach(() => {
    clientBox = boxKeyPair();
    serverBox = boxKeyPair();
    sent = [];
  });

  function makeSession(bridgeConnected = false) {
    const fakeWs = {
      readyState: 1,
      send(payload) {
        sent.push(JSON.parse(payload));
      },
    };
    const session = new MachineRelaySession({
      clientId: 'test-client',
      clientWs: fakeWs,
      keyPair,
      bridgeMode: false,
      config: baseConfig(),
      getBridgeConnected: () => bridgeConnected,
    });
    session.chatroomBoxKeys = {
      publicKey: serverBox.publicKey,
      secretKey: serverBox.secretKey,
      peerPublicKey: clientBox.publicKey,
      peerPublicKeys: {},
    };
    return session;
  }

  it('responds to ping with encrypted pong', () => {
    const session = makeSession(true);
    session.handleApplicationPing({ type: 'ping', id: 'ping-123', ts: 123 }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('encrypted');
    const plain = decrypt(
      sent[0].nonce,
      sent[0].payload,
      serverBox.publicKey,
      clientBox.secretKey
    );
    expect(plain).toBeTruthy();
    const pong = JSON.parse(plain);
    expect(pong.type).toBe('pong');
    expect(pong.id).toBe('ping-123');
    expect(pong.bridgeConnected).toBe(true);
  });

  it('uses getBridgeConnected when replying via middleware path parse', () => {
    const session = makeSession(false);
    session.getBridgeConnected = () => true;
    const pingJson = JSON.stringify({ type: 'ping', id: 'ping-456', ts: 456 });
    const enc = encrypt(pingJson, clientBox.publicKey, serverBox.secretKey);
    const plain = decrypt(enc.nonce, enc.payload, clientBox.publicKey, serverBox.secretKey);
    expect(plain).toBe(pingJson);
    session.handleApplicationPing(JSON.parse(plain), session.getBridgeConnected());
    expect(sent).toHaveLength(1);
    const reply = JSON.parse(
      decrypt(sent[0].nonce, sent[0].payload, serverBox.publicKey, clientBox.secretKey)
    );
    expect(reply.bridgeConnected).toBe(true);
  });

  it('exports heartbeat type sets', () => {
    expect(CLIENT_HEARTBEAT_INNER_TYPES.has('ping')).toBe(true);
    expect(CLIENT_HEARTBEAT_INNER_TYPES.has('heartbeat')).toBe(true);
    expect(CLIENT_HEARTBEAT_IGNORE_TYPES.has('pong')).toBe(true);
  });

  it('handleSingleClientEncryptedFrame answers heartbeat aliases with encrypted pong', () => {
    const session = makeSession(true);
    for (const innerType of ['heartbeat', 'keepalive']) {
      sent.length = 0;
      const inner = JSON.stringify({ type: innerType, id: `hb-${innerType}`, ts: 1 });
      const { nonce, payload } = encrypt(inner, serverBox.publicKey, clientBox.secretKey);
      const outer = { type: 'encrypted', nonce, payload };
      const frame = session.handleSingleClientEncryptedFrame(
        JSON.stringify(outer),
        outer,
        () => true
      );
      expect(frame.action).toBe('heartbeat');
      expect(sent).toHaveLength(1);
      const pong = JSON.parse(
        decrypt(sent[0].nonce, sent[0].payload, serverBox.publicKey, clientBox.secretKey)
      );
      expect(pong.type).toBe('pong');
      expect(pong.id).toBe(`hb-${innerType}`);
    }
  });

  it('handleSingleClientEncryptedFrame ignores pong without closing', () => {
    const session = makeSession();
    const inner = JSON.stringify({ type: 'pong', id: 'p1' });
    const { nonce, payload } = encrypt(inner, serverBox.publicKey, clientBox.secretKey);
    const outer = { type: 'encrypted', nonce, payload };
    const frame = session.handleSingleClientEncryptedFrame(
      JSON.stringify(outer),
      outer,
      () => false
    );
    expect(frame.action).toBe('ignore');
    expect(sent).toHaveLength(0);
  });

  it('handleSingleClientEncryptedFrame warns and ignores unknown inner type', () => {
    const session = makeSession();
    const inner = JSON.stringify({ type: 'telemetry', foo: 1 });
    const { nonce, payload } = encrypt(inner, serverBox.publicKey, clientBox.secretKey);
    const outer = { type: 'encrypted', nonce, payload };
    const frame = session.handleSingleClientEncryptedFrame(
      JSON.stringify(outer),
      outer,
      () => false
    );
    expect(frame.action).toBe('ignore');
    expect(sent).toHaveLength(0);
  });

  it('handleSingleClientEncryptedFrame returns close when decrypt fails', () => {
    const session = makeSession();
    const frame = session.handleSingleClientEncryptedFrame(
      JSON.stringify({ type: 'encrypted', nonce: 'bad', payload: 'bad' }),
      { type: 'encrypted', nonce: 'bad', payload: 'bad' },
      () => false
    );
    expect(frame.action).toBe('close');
  });

  it('handleSingleClientEncryptedFrame skips pong reply when OPENCLAW_ENCRYPTED_HEARTBEAT_REPLY=0', () => {
    vi.stubEnv('OPENCLAW_ENCRYPTED_HEARTBEAT_REPLY', '0');
    const session = makeSession(true);
    const inner = JSON.stringify({ type: 'ping', id: 'ping-silent', ts: 1 });
    const { nonce, payload } = encrypt(inner, serverBox.publicKey, clientBox.secretKey);
    const outer = { type: 'encrypted', nonce, payload };
    const frame = session.handleSingleClientEncryptedFrame(
      JSON.stringify(outer),
      outer,
      () => true
    );
    expect(frame.action).toBe('heartbeat');
    expect(sent).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it('handlePlaintextApplicationPing sends JSON pong on client WS', () => {
    const session = makeSession(false);
    session.handlePlaintextApplicationPing({ type: 'ping', id: 'plain-1', ts: 9 }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('pong');
    expect(sent[0].id).toBe('plain-1');
    expect(sent[0].bridgeConnected).toBe(true);
  });
});
