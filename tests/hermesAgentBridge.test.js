import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractAssistantTextFromChatCompletion,
  extractAssistantTextFromResponses,
  getHermesBridgeConnected,
  HermesAgentBridge,
  hermesConversationName,
  hermesSessionIdHeader,
  hermesSessionKeyHeader,
  shouldStartHermesAgentBridge,
  startHermesAgentBridge,
  stopHermesAgentBridge,
} from '../hermesAgentBridge.js';
import { phonePayloadToUserText } from '../openclawGatewayBridge.js';

describe('hermesAgentBridge helpers', () => {
  it('extractAssistantTextFromResponses reads output_text parts', () => {
    expect(
      extractAssistantTextFromResponses({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello from hermes' }],
          },
        ],
      })
    ).toBe('hello from hermes');
  });

  it('extractAssistantTextFromChatCompletion reads choices[0].message.content', () => {
    expect(
      extractAssistantTextFromChatCompletion({
        choices: [{ message: { content: 'ok' } }],
      })
    ).toBe('ok');
  });

  it('session headers respect 256 char limit and distinct key vs id', () => {
    const id = hermesSessionIdHeader('a', 'c', 'p');
    const key = hermesSessionKeyHeader('a', 'c');
    expect(id).toContain('p');
    expect(key).not.toContain('p');
    expect(id.length).toBeLessThanOrEqual(256);
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('conversation name is stable for responses API', () => {
    expect(hermesConversationName('agent1', 'conv1')).toBe('ombist:agent1:conv1');
  });
});

describe('hermesAgentBridge', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCLAW_BRIDGE_PHONE_METHOD', 'agent');
    vi.stubEnv('HERMES_API_SERVER_URL', 'http://127.0.0.1:8642/v1');
    vi.stubEnv('HERMES_API_SERVER_KEY', 'test-key');
    vi.stubEnv('HERMES_BRIDGE_MODEL', 'hermes-agent');
    vi.stubEnv('HERMES_BRIDGE_API_MODE', 'responses');
  });

  afterEach(() => {
    stopHermesAgentBridge();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shouldStartHermesAgentBridge when HERMES_AGENT_BRIDGE=1', () => {
    vi.stubEnv('HERMES_AGENT_BRIDGE', '1');
    expect(shouldStartHermesAgentBridge()).toBe(true);
  });

  it('phonePayloadToUserText maps agent req to user text', () => {
    expect(
      phonePayloadToUserText({
        type: 'req',
        method: 'agent',
        params: { message: 'hello' },
      })
    ).toBe('hello');
  });

  it('posts /v1/responses with conversation + session headers (doc default)', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('/health')) {
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }
      expect(String(url)).toBe('http://127.0.0.1:8642/v1/responses');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.input).toBe('ping user');
      expect(body.conversation).toBe('ombist:default:conv-1');
      expect(body.store).toBe(true);
      expect(init.headers['X-Hermes-Session-Id']).toBeTruthy();
      expect(init.headers['X-Hermes-Session-Key']).toBeTruthy();
      expect(init.headers.Authorization).toBe('Bearer test-key');
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'assistant reply' }],
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const sent = [];
    const bridge = new HermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
      agentId: 'default',
      conversationId: 'conv-1',
      participantId: 'part-1',
    });
    bridge.session = {
      handleApplicationPing: vi.fn(),
      sendPlaintextToPhone: (plain) => sent.push(plain),
      startBridgeSession: vi.fn(),
      destroy: vi.fn(),
    };

    await bridge._probeApiHealth();
    expect(bridge._apiConnected).toBe(true);

    bridge._onPhonePlaintext(
      JSON.stringify({
        type: 'req',
        method: 'agent',
        params: { message: 'ping user' },
      })
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalled();
    expect(sent.length).toBe(1);
    const res = JSON.parse(sent[0]);
    expect(res.type).toBe('res');
    expect(res.payload.text).toBe('assistant reply');
  });

  it('chat_completions mode sends accumulated messages[]', async () => {
    vi.stubEnv('HERMES_BRIDGE_API_MODE', 'chat_completions');
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).includes('/health')) {
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }
      const body = JSON.parse(init.body);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('only user');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'reply' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new HermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
      agentId: 'default',
      conversationId: 'c',
      participantId: 'p',
    });
    bridge.session = {
      handleApplicationPing: vi.fn(),
      sendPlaintextToPhone: vi.fn(),
      startBridgeSession: vi.fn(),
      destroy: vi.fn(),
    };
    await bridge._sendChatCompletion('only user');
    expect(bridge._chatMessages).toHaveLength(2);
  });

  it('health probe prefers /v1/health per API Server doc', async () => {
    const urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/v1/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) };
        }
        return { ok: false, json: async () => ({}) };
      })
    );
    const bridge = new HermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
      agentId: 'default',
      conversationId: 'default',
      participantId: 'default',
    });
    await bridge._probeApiHealth();
    expect(urls[0]).toBe('http://127.0.0.1:8642/v1/health');
    expect(bridge._apiConnected).toBe(true);
  });

  it('handleApplicationPing uses bridgeConnected from health probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('/health')) {
          return { ok: true, json: async () => ({ status: 'ok' }) };
        }
        return { ok: false, json: async () => ({}) };
      })
    );
    const bridge = new HermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
      agentId: 'default',
      conversationId: 'default',
      participantId: 'default',
    });
    const pings = [];
    bridge.session = {
      handleApplicationPing: (j, connected) => pings.push({ j, connected }),
      startBridgeSession: vi.fn(),
      destroy: vi.fn(),
      sendPlaintextToPhone: vi.fn(),
    };
    await bridge._probeApiHealth();
    bridge._onPhonePlaintext(JSON.stringify({ type: 'ping', id: 'p1' }));
    expect(pings[0]?.connected).toBe(true);
  });

  it('startHermesAgentBridge is singleton', () => {
    vi.stubEnv('HERMES_AGENT_BRIDGE', '1');
    const a = startHermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
    });
    const b = startHermesAgentBridge({
      keyPair: { publicKey: 'pk', secretKey: 'sk' },
      config: { machineSeed: 'seed' },
    });
    expect(a).toBe(b);
    stopHermesAgentBridge();
    expect(getHermesBridgeConnected()).toBe(false);
  });
});
