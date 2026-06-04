import { describe, expect, it } from 'vitest';
import { isGatewayAcceptedAck } from '../gatewayResponseText.js';
import { messageAckToPhoneEvent } from '../openclawGatewayBridge.js';

describe('messageAckToPhoneEvent', () => {
  it('builds message_ack event with clientMessageId', () => {
    const raw = messageAckToPhoneEvent('msg-3');
    const j = JSON.parse(raw);
    expect(j.type).toBe('event');
    expect(j.event).toBe('message_ack');
    expect(j.payload.clientMessageId).toBe('msg-3');
  });

  it('gateway accepted ack is detectable', () => {
    const ack = { type: 'res', ok: true, payload: { status: 'accepted' } };
    expect(isGatewayAcceptedAck(ack)).toBe(true);
  });
});
