import fs from 'fs';
import path from 'path';

const AUDIT_LOG_PATH = process.env.OPENCLAW_AUDIT_LOG || path.join(process.env.OPENCLAW_DATA_DIR || path.join(process.cwd(), 'data'), 'audit.log');

function ensureParent(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function writeAuditEvent(eventType, detail = {}) {
  try {
    ensureParent(AUDIT_LOG_PATH);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      eventType,
      detail,
    });
    fs.appendFileSync(AUDIT_LOG_PATH, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Audit logging must not crash service.
  }
}
