function redact(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = { ...meta };
  for (const key of ['publicKey', 'boxPublicKey', 'payload', 'nonce', 'secret', 'secretKey']) {
    if (key in out) out[key] = '[redacted]';
  }
  return out;
}

function log(level, message, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...redact(meta),
  };
  console.log(JSON.stringify(line));
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
