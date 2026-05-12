#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

assert_has() {
  local file="$1"
  local pattern="$2"
  if ! grep -Eq "${pattern}" "${file}"; then
    echo "provision-sync: missing pattern in ${file}" >&2
    echo "  pattern: ${pattern}" >&2
    return 1
  fi
}

check_core_markers() {
  local file="$1"
  assert_has "${file}" "assert_openclaw_gateway_mode_local\\(\\)"
  assert_has "${file}" "assert_openclaw_gateway_mode_local \\\"\\$\\{OPENCLAW_CONFIG_PATH\\}\\\""
  assert_has "${file}" "systemctl restart ombist-openclaw-gateway.service"
  assert_has "${file}" "systemctl restart ombist-ombot.service"
  assert_has "${file}" "EnvironmentFile=\\$\\{OMBOT_ENV_PATH\\}"
  assert_has "${file}" "OPENAI_API_KEY=\\$\\{OPENAI_API_KEY\\}"
  assert_has "${file}" "OPENAI_BASE_URL=\\$\\{OPENAI_BASE_URL\\}"
  assert_has "${file}" "ANTHROPIC_API_KEY=\\$\\{ANTHROPIC_API_KEY\\}"
  assert_has "${file}" "GOOGLE_API_KEY=\\$\\{GOOGLE_API_KEY\\}"
}

check_openclaw_fragment_markers() {
  local file="$1"
  assert_has "${file}" "OPENCLAW_FRAGMENTS_DIR"
  assert_has "${file}" "OPENCLAW_RUNTIME_CONFIG_PATH"
  assert_has "${file}" "openclaw-compose\\.mjs"
  assert_has "${file}" "10-gateway-transport\\.json"
}

check_pair() {
  local left="$1"
  local right="$2"
  check_core_markers "${left}"
  check_core_markers "${right}"
  check_openclaw_fragment_markers "${left}"
  check_openclaw_fragment_markers "${right}"
  echo "provision-sync: ok core markers ${left##*/} <-> ${right##*/}"
}

MAIN_SINGLE_TOOLS="${ROOT_DIR}/Ombot/tools/provision-single-bot.sh"
MAIN_SINGLE_IOS="${ROOT_DIR}/Ombist_IOS/Ombist_IOS/Resources/provision-single-bot.sh"
MAIN_HEADLESS_TOOLS="${ROOT_DIR}/Ombot/tools/provision-headless.sh"
MAIN_HEADLESS_IOS="${ROOT_DIR}/Ombist_IOS/Ombist_IOS/Resources/provision-headless.sh"

check_pair "${MAIN_SINGLE_TOOLS}" "${MAIN_SINGLE_IOS}"
check_pair "${MAIN_HEADLESS_TOOLS}" "${MAIN_HEADLESS_IOS}"

echo "provision-sync: all core markers are in sync."
