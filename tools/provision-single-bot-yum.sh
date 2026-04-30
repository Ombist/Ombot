#!/usr/bin/env bash
set -euo pipefail

: "${OMBIST_TLS_PUBLIC_HOST:?OMBIST_TLS_PUBLIC_HOST is required (cert SAN / iOS host)}"
: "${OMBIST_WSS_PORT:?OMBIST_WSS_PORT is required}"
: "${OPENCLAW_MACHINE_SEED:?OPENCLAW_MACHINE_SEED is required}"

LIB_PATH="${OMBIST_PROVISION_LIB_PATH:-/tmp/ombist-provision-lib.sh}"
CORE_PATH="${OMBIST_PROVISION_CORE_PATH:-/tmp/ombist-provision-core.sh}"

if [[ ! -s "${LIB_PATH}" ]]; then
  echo "ombist-provision-single-bot: missing common library at ${LIB_PATH}" >&2
  exit 10
fi
if [[ ! -s "${CORE_PATH}" ]]; then
  echo "ombist-provision-single-bot: missing core script at ${CORE_PATH}" >&2
  exit 11
fi

# shellcheck source=/dev/null
source "${LIB_PATH}"
ombist_require_pkg_manager "yum"
exec bash "${CORE_PATH}"
