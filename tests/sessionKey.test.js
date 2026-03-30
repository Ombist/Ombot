import { describe, expect, it } from 'vitest';
import { computeSessionKey, middlewareWsUrlForSession, normalizeAgentId, normalizeConversationId, normalizeParticipantId } from '../sessionKey.js';

describe('sessionKey', () => {
  it('normalizes ids with defaults', () => {
    expect(normalizeAgentId('  ')).toBe('default');
    expect(normalizeConversationId(null)).toBe('default');
    expect(normalizeParticipantId('')).toBe('default');
  });

  it('computes deterministic keys', () => {
    const a = computeSessionKey('agentA', 'room1');
    const b = computeSessionKey('agentA', 'room1');
    const c = computeSessionKey('agentB', 'room1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('uses participantId when provided', () => {
    const p1 = computeSessionKey('agentA', 'room1', 'ios-a');
    const p2 = computeSessionKey('agentA', 'room1', 'ios-b');
    expect(p1).not.toBe(p2);
    expect(computeSessionKey('agentA', 'room1')).not.toBe(p1);
  });

  it('creates middleware URL with and without session key', () => {
    expect(middlewareWsUrlForSession('ws://127.0.0.1:8081/ws', '')).toBe('ws://127.0.0.1:8081/ws');
    expect(middlewareWsUrlForSession('ws://127.0.0.1:8081', 'abc')).toBe('ws://127.0.0.1:8081/ws/abc');
  });
});
