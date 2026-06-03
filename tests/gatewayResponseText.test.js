import { describe, expect, it } from 'vitest';
import {
  extractAssistantTextFromGateway,
  isGatewayAcceptedAck,
} from '../gatewayResponseText.js';

describe('gatewayResponseText', () => {
  it('reads payload.text string', () => {
    expect(
      extractAssistantTextFromGateway({ type: 'res', ok: true, payload: { text: 'hello' } })
    ).toBe('hello');
  });

  it('ignores status accepted with no text', () => {
    const ack = { type: 'res', ok: true, payload: { status: 'accepted' } };
    expect(isGatewayAcceptedAck(ack)).toBe(true);
    expect(extractAssistantTextFromGateway(ack)).toBeNull();
  });

  it('does not stringify message object to [object Object]', () => {
    expect(
      extractAssistantTextFromGateway({
        type: 'res',
        ok: true,
        payload: { message: { role: 'assistant', content: [] } },
      })
    ).toBeNull();
    expect(
      extractAssistantTextFromGateway({
        type: 'res',
        ok: true,
        payload: { content: [{ type: 'text', text: 'block' }] },
      })
    ).toBe('block');
  });

  it('reads OpenClaw agent event payload.data.text', () => {
    expect(
      extractAssistantTextFromGateway({
        type: 'event',
        event: 'agent',
        payload: { data: { text: 'Hey! I just woke up...' } },
      })
    ).toBe('Hey! I just woke up...');
  });

  it('reads payload.data.delta', () => {
    expect(
      extractAssistantTextFromGateway({
        type: 'event',
        event: 'agent',
        payload: { data: { delta: 'partial' } },
      })
    ).toBe('partial');
  });

  it('reads message.content text blocks', () => {
    expect(
      extractAssistantTextFromGateway({
        type: 'event',
        event: 'agent',
        payload: {
          message: {
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world' },
            ],
          },
        },
      })
    ).toBe('Helloworld');
  });

  it('handles error res', () => {
    const t = extractAssistantTextFromGateway({
      type: 'res',
      ok: false,
      error: { message: 'nope' },
    });
    expect(t).toContain('nope');
  });
});
