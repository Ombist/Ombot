import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { MachineRelaySession } from '../machineRelaySession.js';
import { startSingleClientGateway, stopSingleClientGateway } from '../singleClientGateway.js';
import { generateKeyPairFromSeed, hexToBytes, sign } from '../ed25519.js';
import { boxKeyPair, decrypt, encrypt, publicKeyToBase64 } from '../boxCrypto.js';
import {
  registerChallengeClientDataHashBase64,
  registerChallengeSigningPayload,
} from '../securityGuards.js';
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

describe('MachineRelaySession single-client mode', () => {
  const keyPair = generateKeyPairFromSeed('test-single-client-seed');
  let clientPk;
  let clientSk;
  let clientBox;
  let serverBox;

  beforeEach(() => {
    const kp = generateKeyPairFromSeed('client-ed25519-seed');
    clientPk = kp.publicKeyHex;
    clientSk = kp.privateKeyHex;
    clientBox = boxKeyPair();
    serverBox = boxKeyPair();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stopSingleClientGateway();
  });

  function completeStrictRegister(session, sent) {
    const challenge = sent.find((x) => x.type === 'challenge');
    expect(challenge).toBeTruthy();
    const timestamp = challenge.issuedAt + 1;
    const body = `${registerChallengeSigningPayload({
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      traceId: challenge.traceId,
      participantId: challenge.participantId,
      conversationId: challenge.conversationId,
      publicKey: challenge.publicKey,
      protocolVersion: challenge.protocolVersion,
    })}|${timestamp}`;
    const sigHex = sign(hexToBytes(clientSk), body);
    const res = session.handleRegisterChallengeResponse({
      type: 'register_challenge_response',
      nonce: challenge.nonce,
      timestamp,
      signature: sigHex,
      attestation: {
        provider: 'apple_app_attest',
        keyId: 'k1',
        assertion: 'a1',
        clientDataHash: registerChallengeClientDataHashBase64({
          nonce: challenge.nonce,
          issuedAt: challenge.issuedAt,
          expiresAt: challenge.expiresAt,
          traceId: challenge.traceId,
          participantId: challenge.participantId,
          conversationId: challenge.conversationId,
          publicKey: challenge.publicKey,
          protocolVersion: challenge.protocolVersion,
        }),
        verdict: 'ok',
      },
    });
    expect(res.ok).toBe(true);
  }

  it('strict register challenge then peer_public_key', () => {
    const sent = [];
    const clientWs = {
      readyState: 1,
      send(s) {
        sent.push(JSON.parse(s));
      },
    };
    const session = new MachineRelaySession({
      clientId: 't1',
      clientWs,
      keyPair,
      bridgeMode: false,
      config: baseConfig(),
    });
    const registerPayload = {
      type: 'register_public_key',
      publicKey: clientPk,
      boxPublicKey: publicKeyToBase64(clientBox.publicKey),
      conversationId: 'c1',
      participantId: 'p1',
      traceId: 'tr',
      protocolVersion: 2,
      capabilities: ['signature', 'replay_guard'],
      agentId: 'agent-a',
      appAttestationEnabled: true,
    };
    const prep = session.validateAndPrepareRegister(registerPayload);
    expect(prep.ok).toBe(false);
    expect(prep.response.requireAttestation).toBe(true);
    session.notifyClientJson(prep.response);
    completeStrictRegister(session, sent);
    expect(sent.some((x) => x.type === 'registered')).toBe(true);
    const peer = sent.find((x) => x.type === 'peer_public_key');
    expect(peer?.publicKey).toBeTruthy();
    expect(session.singleClientAgentId).toBe('agent-a');
    session.destroy();
  });

  it('attestation disabled accepts challenge response without attestation', () => {
    const sent = [];
    const clientWs = {
      readyState: 1,
      send(s) {
        sent.push(JSON.parse(s));
      },
    };
    const session = new MachineRelaySession({
      clientId: 't1-off',
      clientWs,
      keyPair,
      bridgeMode: false,
      config: baseConfig(),
    });
    const registerPayload = {
      type: 'register_public_key',
      publicKey: clientPk,
      boxPublicKey: publicKeyToBase64(clientBox.publicKey),
      conversationId: 'c1-off',
      participantId: 'p1',
      traceId: 'tr-off',
      protocolVersion: 2,
      capabilities: ['signature', 'replay_guard'],
      agentId: 'agent-a',
      appAttestationEnabled: false,
    };
    const prep = session.validateAndPrepareRegister(registerPayload);
    expect(prep.ok).toBe(false);
    expect(prep.response.requireAttestation).toBe(false);
    session.notifyClientJson(prep.response);

    const challenge = sent.find((x) => x.type === 'challenge');
    expect(challenge).toBeTruthy();
    const timestamp = challenge.issuedAt + 1;
    const body = `${registerChallengeSigningPayload({
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      traceId: challenge.traceId,
      participantId: challenge.participantId,
      conversationId: challenge.conversationId,
      publicKey: challenge.publicKey,
      protocolVersion: challenge.protocolVersion,
    })}|${timestamp}`;
    const sigHex = sign(hexToBytes(clientSk), body);
    const res = session.handleRegisterChallengeResponse({
      type: 'register_challenge_response',
      nonce: challenge.nonce,
      timestamp,
      signature: sigHex,
    });
    expect(res.ok).toBe(true);
    session.destroy();
  });

  it('tryDecryptClientBox decrypts client-encrypted frame', () => {
    const clientWs = { readyState: 1, send() {} };
    const session = new MachineRelaySession({
      clientId: 't2',
      clientWs,
      keyPair,
      bridgeMode: false,
      config: baseConfig(),
    });
    session.chatroomBoxKeys = {
      publicKey: serverBox.publicKey,
      secretKey: serverBox.secretKey,
      peerPublicKey: clientBox.publicKey,
      peerPublicKeys: {},
    };
    const inner = JSON.stringify({
      type: 'req',
      id: 'r1',
      method: 'agent',
      params: { message: 'hi' },
    });
    const { nonce, payload } = encrypt(inner, serverBox.publicKey, clientBox.secretKey);
    const outer = { type: 'encrypted', nonce, payload };
    const dec = session.tryDecryptClientBox(JSON.stringify(outer), outer);
    expect(dec?.json.method).toBe('agent');
    expect(dec?.json.params.message).toBe('hi');
    session.destroy();
  });

  it(
    'relays signed req to gateway and encrypts assistant reply',
    async () => {
    stopSingleClientGateway();
    const gatewayFrames = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    const { port } = wss.address();
    const gwUrl = `ws://127.0.0.1:${port}`;

    wss.on('connection', (ws) => {
      ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        gatewayFrames.push(msg);
        if (msg.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true }));
        }
        if (msg.method === 'agent') {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { text: 'hello-back' },
            })
          );
        }
      });
    });

    vi.stubEnv('OPENCLAW_SINGLE_CLIENT_MODE', '1');
    vi.stubEnv('OPENCLAW_GATEWAY_URL', gwUrl);
    // Mock gateway does not emit `event: connect.challenge`; use blind-first connect.
    vi.stubEnv('OPENCLAW_GATEWAY_LEGACY_BLIND_CONNECT', '1');
    startSingleClientGateway();

    const sent = [];
    const clientWs = {
      readyState: 1,
      send(s) {
        sent.push(JSON.parse(s));
      },
    };
    const session = new MachineRelaySession({
      clientId: 't3',
      clientWs,
      keyPair,
      bridgeMode: false,
      config: baseConfig(),
    });
    session.clientVerifyPublicKey = hexToBytes(clientPk);
    session.chatroomBoxKeys = {
      publicKey: serverBox.publicKey,
      secretKey: serverBox.secretKey,
      peerPublicKey: clientBox.publicKey,
      peerPublicKeys: {},
    };
    session.singleClientAgentId = 'default';
    session._handshakeState = 'ready_for_agent_req';

    const reqJson = {
      type: 'req',
      id: 'req-1',
      method: 'agent',
      params: { message: 'user-line' },
    };
    const raw = JSON.stringify(reqJson);
    const ok = session.relaySignedReqSingleClient(raw, reqJson);
    expect(ok).toBe(true);

    await new Promise((r) => setTimeout(r, 400));

    const enc = sent.find((x) => x.type === 'encrypted');
    expect(enc).toBeTruthy();
    const plain = JSON.parse(
      decrypt(enc.nonce, enc.payload, serverBox.publicKey, clientBox.secretKey)
    );
    expect(plain.type).toBe('res');
    expect(plain.payload.text).toBe('hello-back');

    session.destroy();
    stopSingleClientGateway();
    await new Promise((r) => wss.close(r));
  },
    15_000
  );
});
