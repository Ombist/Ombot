/**
 * Decide when to forward OpenClaw Gateway assistant text to Phone / chat room.
 * Gateway emits both `event: chat` (state: final) and `event: agent` (lifecycle: end)
 * with the same body; forwarding both duplicates the UI message.
 */
import {
  extractAssistantTextFromGateway,
  isGatewayAcceptedAck,
} from './gatewayResponseText.js';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {object} msg
 * @returns {string | null}
 */
export function extractGatewayRunId(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const candidates = [
    msg.runId,
    msg.idempotencyKey,
    msg.payload?.runId,
    msg.payload?.idempotencyKey,
    msg.payload?.data?.runId,
    msg.payload?.data?.idempotencyKey,
  ];
  for (const c of candidates) {
    if (isNonEmptyString(c)) return String(c).trim();
  }
  if (msg.type === 'res' && isNonEmptyString(msg.id)) {
    return String(msg.id).trim();
  }
  return null;
}

/**
 * @param {object} msg
 */
export function isChatFinalEvent(msg) {
  if (!msg || msg.type !== 'event' || msg.event !== 'chat') return false;
  const p = msg.payload;
  const st = String(
    (p && typeof p === 'object' ? p.state : null) ?? msg.state ?? ''
  ).toLowerCase();
  return st === 'final';
}

/**
 * Agent lifecycle end carries duplicate final text; buffer-only upstream.
 * @param {object} msg
 */
export function isAgentLifecycleEndEvent(msg) {
  if (!msg || msg.type !== 'event' || msg.event !== 'agent') return false;
  const p = msg.payload;
  if (!p || typeof p !== 'object') return false;
  const po = /** @type {Record<string, unknown>} */ (p);
  const data = po.data && typeof po.data === 'object' ? /** @type {Record<string, unknown>} */ (po.data) : {};
  const phase = String(po.phase ?? po.lifecycle ?? data.phase ?? data.lifecycle ?? '').toLowerCase();
  if (phase === 'end' || phase === 'done' || phase === 'complete') return true;
  const stream = String(po.stream ?? data.stream ?? '').toLowerCase();
  return stream === 'lifecycle' && (phase === 'end' || data.status === 'end');
}

/**
 * @param {object} msg
 * @returns {{ deliver: boolean, text: string | null, runId: string | null, reason: string }}
 */
export function evaluateGatewayAssistantDelivery(msg) {
  if (!msg || typeof msg !== 'object') {
    return { deliver: false, text: null, runId: null, reason: 'invalid' };
  }

  if (msg.type === 'event') {
    if (msg.event === 'connect.challenge') {
      return { deliver: false, text: null, runId: null, reason: 'connect_challenge' };
    }
    if (isChatFinalEvent(msg)) {
      const text = extractAssistantTextFromGateway({
        type: 'res',
        ok: true,
        payload: msg.payload,
      });
      const runId = extractGatewayRunId(msg);
      return {
        deliver: Boolean(text),
        text,
        runId,
        reason: 'chat_final',
      };
    }
    if (msg.event === 'agent') {
      if (isAgentLifecycleEndEvent(msg)) {
        const text = extractAssistantTextFromGateway({
          type: 'res',
          ok: true,
          payload: msg.payload,
        });
        const runId = extractGatewayRunId(msg);
        return {
          deliver: Boolean(text),
          text,
          runId,
          reason: 'agent_lifecycle_end',
        };
      }
      return {
        deliver: false,
        text: null,
        runId: extractGatewayRunId(msg),
        reason: 'agent_stream',
      };
    }
    return { deliver: false, text: null, runId: extractGatewayRunId(msg), reason: 'other_event' };
  }

  if (msg.type === 'res') {
    if (isGatewayAcceptedAck(msg)) {
      return { deliver: false, text: null, runId: extractGatewayRunId(msg), reason: 'accepted_ack' };
    }
    const text = extractAssistantTextFromGateway(msg);
    const runId = extractGatewayRunId(msg);
    return {
      deliver: Boolean(text),
      text,
      runId,
      reason: 'res',
    };
  }

  return { deliver: false, text: null, runId: null, reason: 'ignored' };
}

/** Tracks runIds already forwarded to the consumer (one assistant bubble per turn). */
export class GatewayReplyDeduper {
  /**
   * @param {{ maxEntries?: number }} [opts]
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 256;
    /** @type {Set<string>} */
    this._seen = new Set();
    /** @type {string[]} */
    this._order = [];
  }

  reset() {
    this._seen.clear();
    this._order.length = 0;
  }

  /**
   * @param {string | null | undefined} runId
   * @param {string | null | undefined} text
   * @returns {boolean} true if caller should deliver `text` to the user
   */
  shouldDeliver(runId, text) {
    if (!isNonEmptyString(text)) return false;
    const key = isNonEmptyString(runId) ? `run:${runId}` : `text:${text.trim()}`;
    if (this._seen.has(key)) return false;
    this._seen.add(key);
    this._order.push(key);
    while (this._order.length > this.maxEntries) {
      const old = this._order.shift();
      if (old) this._seen.delete(old);
    }
    return true;
  }
}

/**
 * @param {object} msg
 * @param {GatewayReplyDeduper} deduper
 * @returns {string | null} text to deliver, or null
 */
export function assistantTextForConsumer(msg, deduper) {
  const decision = evaluateGatewayAssistantDelivery(msg);
  if (!decision.deliver || !decision.text) return null;
  if (!deduper.shouldDeliver(decision.runId, decision.text)) return null;
  return decision.text;
}
