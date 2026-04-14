import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  assistantTextToPhoneRes,
  extractAssistantTextFromGateway,
  phonePayloadToUserText,
} from '../openclawGatewayBridge.js';

describe('openclawGatewayBridge helpers', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCLAW_BRIDGE_PHONE_METHOD', 'agent');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('phonePayloadToUserText reads agent params.message', () => {
    expect(
      phonePayloadToUserText({
        type: 'req',
        method: 'agent',
        params: { message: 'hi' },
      })
    ).toBe('hi');
  });

  it('phonePayloadToUserText returns null for wrong method', () => {
    expect(
      phonePayloadToUserText({
        type: 'req',
        method: 'other',
        params: { message: 'x' },
      })
    ).toBeNull();
  });

  it('assistantTextToPhoneRes is valid JSON res', () => {
    const s = assistantTextToPhoneRes('ok');
    const j = JSON.parse(s);
    expect(j.type).toBe('res');
    expect(j.payload.text).toBe('ok');
  });

  it('extractAssistantTextFromGateway reads payload.text', () => {
    expect(
      extractAssistantTextFromGateway({ type: 'res', ok: true, payload: { text: 'a' } })
    ).toBe('a');
  });

  it('extractAssistantTextFromGateway handles error res', () => {
    const t = extractAssistantTextFromGateway({
      type: 'res',
      ok: false,
      error: { message: 'nope' },
    });
    expect(t).toContain('nope');
  });
});

describe('mock gateway server handshake', () => {
  it('accepts connect and responds with res ok', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'req' && msg.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }));
        }
        if (msg.type === 'req' && msg.method === 'agent') {
          expect(msg.params.idempotencyKey).toBeTruthy();
          expect(msg.params.agentId).toBeTruthy();
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { text: `echo:${msg.params.message}:${msg.params.agentId}` },
            })
          );
        }
      });
    });

    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const nextJson = () =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 2000);
        ws.once('message', (d) => {
          clearTimeout(t);
          resolve(JSON.parse(d.toString()));
        });
      });

    const id = 'c1';
    ws.send(
      JSON.stringify({
        type: 'req',
        id,
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 9,
          client: { id: 't' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
        },
      })
    );

    const res = await nextJson();
    expect(res.type).toBe('res');
    expect(res.id).toBe(id);
    expect(res.ok).toBe(true);

    const id2 = 'a1';
    ws.send(
      JSON.stringify({
        type: 'req',
        id: id2,
        method: 'agent',
        params: { message: 'hello', idempotencyKey: id2, agentId: 'default' },
      })
    );
    const res2 = await nextJson();
    expect(res2.ok).toBe(true);
    expect(res2.payload.text).toBe('echo:hello:default');

    ws.close();
    await new Promise((r) => wss.close(r));
  });
});
