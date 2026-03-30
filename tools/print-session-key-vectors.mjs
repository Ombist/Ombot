/**
 * Regenerate docs/e2e-session-key-test-vectors.json cases (sessionKey field only verification).
 */
import { computeSessionKey, normalizeAgentId, normalizeConversationId } from '../sessionKey.js';

const cases = [
  { agentId: null, conversationId: 'room-1' },
  { agentId: '', conversationId: 'room-1' },
  { agentId: 'agent-a', conversationId: 'room-1' },
  { agentId: 'default', conversationId: 'default' },
  { agentId: '  ', conversationId: '  x  ' },
];

for (const c of cases) {
  const agentNorm = normalizeAgentId(c.agentId);
  const convNorm = normalizeConversationId(c.conversationId);
  console.log(
    JSON.stringify({
      ...c,
      agentNorm,
      convNorm,
      sessionKey: computeSessionKey(c.agentId, c.conversationId),
    })
  );
}
