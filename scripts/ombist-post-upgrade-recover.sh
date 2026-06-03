#!/usr/bin/env bash
# Post-upgrade recovery on a single-bot host (run on server with sudo).
# Golden path: ombot-admin bot ensure-ready
set -euo pipefail

OMBOT_BIN_DIR="${OMBOT_BIN_DIR:-/opt/ombot/bin}"
ADMIN="${OMBOT_BIN_DIR}/ombot-admin"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ombist-post-upgrade-recover: run as root or via sudo -n" >&2
  exit 1
fi

if [[ ! -x "${ADMIN}" ]]; then
  echo "ombist-post-upgrade-recover: missing ${ADMIN}; run full provision first" >&2
  exit 1
fi

export OMBOT_REPO_DIR="${OMBOT_REPO_DIR:-/opt/ombot/Ombot}"
exec "${ADMIN}" bot ensure-ready --json
