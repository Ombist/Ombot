#!/usr/bin/env bash
# Post-upgrade recovery on a single-bot host (run on server with sudo).
# Installs ombot-admin from Ombot repo, repairs OpenClaw route fragments, verifies gateway port.
set -euo pipefail

OMBOT_REPO_DIR="${OMBOT_REPO_DIR:-/opt/ombot/Ombot}"
OMBOT_BIN_DIR="${OMBOT_BIN_DIR:-/opt/ombot/bin}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ombist-post-upgrade-recover: run as root or via sudo -n" >&2
  exit 1
fi

if [[ ! -f "${OMBOT_REPO_DIR}/tools/ombot-admin" ]]; then
  echo "ombist-post-upgrade-recover: missing ${OMBOT_REPO_DIR}/tools/ombot-admin" >&2
  exit 1
fi

install -m 0755 "${OMBOT_REPO_DIR}/tools/ombot-admin" "${OMBOT_BIN_DIR}/ombot-admin"
rm -rf "${OMBOT_BIN_DIR}/ombot-admin-lib"
mkdir -p "${OMBOT_BIN_DIR}/ombot-admin-lib"
cp -a "${OMBOT_REPO_DIR}/tools/ombot-admin-lib/." "${OMBOT_BIN_DIR}/ombot-admin-lib/"

systemctl daemon-reload
systemctl restart ombist-ombot.service 2>/dev/null || true

export OMBOT_REPO_DIR
"${OMBOT_BIN_DIR}/ombot-admin" openclaw config repair-route --json

for i in $(seq 1 60); do
  if ss -H -ltn "sport = :${OPENCLAW_GATEWAY_PORT}" 2>/dev/null | grep -q LISTEN; then
    echo "ombist-post-upgrade-recover: gateway port ${OPENCLAW_GATEWAY_PORT} listening"
    exit 0
  fi
  sleep 1
done

echo "ombist-post-upgrade-recover: gateway port ${OPENCLAW_GATEWAY_PORT} not listening after 60s" >&2
exit 24
