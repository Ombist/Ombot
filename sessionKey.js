/**
 * Middleware 多路 tunnel 鍵：與 Ombist iOS / RN 相同算法（見 docs/clawchat-e2e-protocol.md）
 */
import crypto from 'crypto';

export function normalizeAgentId(agentId) {
  const t = agentId == null ? '' : String(agentId).trim();
  return t || 'default';
}

export function normalizeConversationId(conversationId) {
  const t = conversationId == null ? '' : String(conversationId).trim();
  return t || 'default';
}

export function normalizeParticipantId(participantId) {
  const t = participantId == null ? '' : String(participantId).trim();
  return t || 'default';
}

export function computeSessionKey(agentId, conversationId, participantId = null) {
  const agentNorm = normalizeAgentId(agentId);
  const convNorm = normalizeConversationId(conversationId);
  const hasParticipant = participantId != null && String(participantId).trim() !== '';
  const input = hasParticipant
    ? `${agentNorm}\n${convNorm}\n${normalizeParticipantId(participantId)}`
    : `${agentNorm}\n${convNorm}`;
  const hash = crypto.createHash('sha256').update(input, 'utf8').digest();
  return base64UrlEncode(hash);
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** 確保 URL 以 /ws 結尾（不含尾隨 slash） */
export function normalizeMiddlewareBase(url) {
  let u = (url || '').trim().replace(/\/$/, '');
  if (!u) u = 'ws://127.0.0.1:8081/ws';
  if (!/\/ws$/i.test(u)) {
    u = `${u}/ws`;
  }
  return u;
}

/** sessionKey 為 null/undefined 時回傳 legacy 基底（…/ws）；否則 …/ws/<sessionKey> */
export function middlewareWsUrlForSession(baseUrl, sessionKey) {
  const base = normalizeMiddlewareBase(baseUrl);
  if (sessionKey == null || sessionKey === '') {
    return base;
  }
  const enc = encodeURIComponent(sessionKey);
  return `${base}/${enc}`;
}
