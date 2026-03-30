#!/usr/bin/env bash
set -euo pipefail

RELEASES_DIR=${RELEASES_DIR:-/opt/ombot/releases}
CURRENT_LINK=${CURRENT_LINK:-/opt/ombot/Ombot}
SERVICE_NAME=${SERVICE_NAME:-ombot.service}
STAMP=$(date +%Y%m%d%H%M%S)
TARGET="${RELEASES_DIR}/${STAMP}"

mkdir -p "${RELEASES_DIR}"
cp -R . "${TARGET}"
ln -sfn "${TARGET}" "${CURRENT_LINK}"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"
systemctl --no-pager status "${SERVICE_NAME}" || true

echo "deployed_release=${TARGET}"
