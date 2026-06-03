/**
 * Extract assistant-visible text from OpenClaw Gateway WebSocket frames (res + event).
 * Newer gateways ACK with `status: accepted` then stream/finalize via `event: agent`
 * (`payload.data.text` / `payload.data.delta`). Never coerce objects with String().
 */

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {unknown} content
 * @returns {string | null}
 */
function textFromMessageContent(content) {
  if (isNonEmptyString(content)) return content.trim();
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = /** @type {Record<string, unknown>} */ (block);
    if (isNonEmptyString(b.text)) {
      parts.push(String(b.text).trim());
      continue;
    }
    if (String(b.type || '').toLowerCase() === 'text' && isNonEmptyString(b.text)) {
      parts.push(String(b.text).trim());
    }
  }
  if (parts.length === 0) return null;
  return parts.join('');
}

/**
 * @param {unknown} data
 * @returns {string | null}
 */
function textFromPayloadData(data) {
  if (!data || typeof data !== 'object') return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  if (isNonEmptyString(d.text)) return d.text.trim();
  if (isNonEmptyString(d.delta)) return d.delta;
  if (d.message != null) {
    const fromMsg = textFromPayloadObject(d.message);
    if (fromMsg) return fromMsg;
  }
  if (d.content != null) {
    const fromContent = textFromMessageContent(d.content);
    if (fromContent) return fromContent;
  }
  return null;
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
function textFromPayloadObject(obj) {
  if (isNonEmptyString(obj)) return obj.trim();
  if (!obj || typeof obj !== 'object') return null;
  const p = /** @type {Record<string, unknown>} */ (obj);
  if (isNonEmptyString(p.text)) return p.text.trim();
  if (p.data != null) {
    const fromData = textFromPayloadData(p.data);
    if (fromData) return fromData;
  }
  if (p.message != null) {
    const m = p.message;
    if (isNonEmptyString(m)) return m.trim();
    if (m && typeof m === 'object') {
      const mo = /** @type {Record<string, unknown>} */ (m);
      if (isNonEmptyString(mo.text)) return mo.text.trim();
      if (mo.content != null) {
        const fromContent = textFromMessageContent(mo.content);
        if (fromContent) return fromContent;
      }
    }
  }
  if (p.content != null) {
    const fromContent = textFromMessageContent(p.content);
    if (fromContent) return fromContent;
  }
  return null;
}

/**
 * True when the frame is only an ACK (no assistant text yet).
 * @param {object | null | undefined} msg
 */
export function isGatewayAcceptedAck(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const p = msg.payload;
  if (!p || typeof p !== 'object') {
    const top = String(msg.status || '').toLowerCase();
    return top === 'accepted';
  }
  const po = /** @type {Record<string, unknown>} */ (p);
  const st = String(po.status ?? po.state ?? '').toLowerCase();
  if (st !== 'accepted') return false;
  return textFromPayloadObject(po) == null;
}

/**
 * @param {object} msg
 * @returns {string | null}
 */
export function extractAssistantTextFromGateway(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'res' && msg.ok === false) {
    const err =
      msg.error && typeof msg.error === 'object'
        ? msg.error.message || msg.error.code
        : msg.error;
    return err != null ? `[error] ${String(err)}` : '[error]';
  }
  if (isGatewayAcceptedAck(msg)) return null;

  const fromPayload = textFromPayloadObject(msg.payload);
  if (fromPayload) return fromPayload;

  if (typeof msg.payload === 'string' && isNonEmptyString(msg.payload)) {
    return msg.payload.trim();
  }
  if (isNonEmptyString(msg.text)) return msg.text.trim();

  return null;
}
