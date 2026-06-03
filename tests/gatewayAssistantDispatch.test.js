import { describe, expect, it } from 'vitest';
import {
  assistantTextForConsumer,
  evaluateGatewayAssistantDelivery,
  GatewayReplyDeduper,
  isAgentLifecycleEndEvent,
  isChatFinalEvent,
} from '../gatewayAssistantDispatch.js';

describe('gatewayAssistantDispatch', () => {
  it('detects chat final vs agent lifecycle end', () => {
    expect(
      isChatFinalEvent({
        type: 'event',
        event: 'chat',
        payload: { state: 'final', runId: 'r1' },
      })
    ).toBe(true);
    expect(
      isAgentLifecycleEndEvent({
        type: 'event',
        event: 'agent',
        payload: { runId: 'r1', stream: 'lifecycle', data: { phase: 'end' } },
      })
    ).toBe(true);
  });

  it('dedupes chat final and agent lifecycle end for same runId', () => {
    const deduper = new GatewayReplyDeduper();
    const body = 'Hello from assistant';

    const chatFinal = {
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        runId: 'run-abc',
        message: { content: [{ type: 'text', text: body }] },
      },
    };
    const agentEnd = {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'run-abc',
        stream: 'lifecycle',
        data: { phase: 'end', text: body },
      },
    };

    expect(assistantTextForConsumer(chatFinal, deduper)).toBe(body);
    expect(assistantTextForConsumer(agentEnd, deduper)).toBeNull();
  });

  it('delivers agent lifecycle end when chat final is absent', () => {
    const deduper = new GatewayReplyDeduper();
    const body = 'Fallback from agent end';
    const agentEnd = {
      type: 'event',
      event: 'agent',
      payload: {
        runId: 'run-only-agent',
        stream: 'lifecycle',
        data: { phase: 'end', text: body },
      },
    };
    expect(assistantTextForConsumer(agentEnd, deduper)).toBe(body);
  });

  it('dedupes second delivery for same runId (chat final + late res)', () => {
    const deduper = new GatewayReplyDeduper();
    const runId = 'run-dup';
    const text = 'Once only';

    const chatFinal = {
      type: 'event',
      event: 'chat',
      payload: { state: 'final', runId, text },
    };
    const lateRes = {
      type: 'res',
      ok: true,
      id: runId,
      payload: { text },
    };

    expect(assistantTextForConsumer(chatFinal, deduper)).toBe(text);
    expect(assistantTextForConsumer(lateRes, deduper)).toBeNull();
  });

  it('does not deliver agent stream deltas', () => {
    const decision = evaluateGatewayAssistantDelivery({
      type: 'event',
      event: 'agent',
      payload: { runId: 'r1', data: { delta: 'partial' } },
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe('agent_stream');
  });
});
