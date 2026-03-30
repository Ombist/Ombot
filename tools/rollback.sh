#!/usr/bin/env bash
set -euo pipefail

RELEASES_DIR=${RELEASES_DIR:-/opt/ombot/releases}
CURRENT_LINK=${CURRENT_LINK:-/opt/ombot/Ombot}
SERVICE_NAME=${SERVICE_NAME:-ombot.service}

mapfile -t RELEASES < <(ls -1 "${RELEASES_DIR}" | sort)
COUNT=${#RELEASES[@]}
if [[ "${COUNT}" -lt 2 ]]; then
  echo "need at least two releases to rollback"
  exit 1
fi

PREV="${RELEASES[$((COUNT-2))]}"
ln -sfn "${RELEASES_DIR}/${PREV}" "${CURRENT_LINK}"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"
systemctl --no-pager status "${SERVICE_NAME}" || true

echo "rolled_back_to=${RELEASES_DIR}/${PREV}"
