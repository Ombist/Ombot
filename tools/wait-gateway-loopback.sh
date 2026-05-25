#!/usr/bin/env bash
# Wait until OpenClaw gateway listens on loopback (used by ombist-ombot.service ExecStartPre).
set -euo pipefail

OMBOT_ENV_PATH="${OMBOT_ENV_PATH:-/etc/ombot/ombot.env}"
if [[ -f "${OMBOT_ENV_PATH}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${OMBOT_ENV_PATH}"
  set +a
fi

OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
WAIT_TIMEOUT_SEC="${OPENCLAW_GATEWAY_BOOT_WAIT_SEC:-45}"

host="127.0.0.1"
port="${OPENCLAW_GATEWAY_PORT}"
if command -v node >/dev/null 2>&1; then
  parsed="$(node -e "
try {
  const u = new URL(process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789');
  const h = u.hostname || '127.0.0.1';
  const p = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  process.stdout.write(h + ' ' + (Number.isFinite(p) ? p : 18789));
} catch {
  process.stdout.write('127.0.0.1 18789');
}
" 2>/dev/null || true)"
  if [[ -n "${parsed}" ]]; then
    read -r host port <<<"${parsed}"
  fi
fi

deadline=$((SECONDS + WAIT_TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q "${host}:${port}"; then
      exit 0
    fi
  elif (echo >/dev/tcp/"${host}"/"${port}") 2>/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "wait-gateway-loopback: ${host}:${port} not listening after ${WAIT_TIMEOUT_SEC}s" >&2
exit 1
