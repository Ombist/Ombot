#!/usr/bin/env bash
# Shell tests for ombist_ensure_node22 helpers (no real apt/nvm).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${ROOT}/tools/provision-lib-common.sh"
# shellcheck source=/dev/null
source "${LIB}"

fail() {
  echo "provision-node22.test: FAIL: $*" >&2
  exit 1
}

pass() {
  echo "provision-node22.test: ok $*"
}

# Wrap node major for controlled tests.
ombist_node_major_mockable() {
  if [[ -n "${MOCK_NODE_MAJOR:-}" ]]; then
    printf '%s\n' "${MOCK_NODE_MAJOR}"
    return 0
  fi
  ombist_node_major "$@"
}

MOCK_NODE_MAJOR=22
[[ "$(ombist_node_major_mockable)" == "22" ]] || fail "mock major 22"
MOCK_NODE_MAJOR=20
[[ "$(ombist_node_major_mockable)" == "20" ]] || fail "mock major 20"
unset MOCK_NODE_MAJOR
pass "node major mock"

MOCK_NODE_MAJOR=22
export OMBIST_PROVISION_LABEL=test
ombist_ensure_node22() {
  local major
  major="$(ombist_node_major_mockable 2>/dev/null || echo 0)"
  [[ "${major}" -ge 22 ]] || return 14
  return 0
}
ombist_ensure_node22 || fail "ensure should pass when mock major=22"
unset MOCK_NODE_MAJOR
pass "ensure early exit"

MOCK_NODE_MAJOR=20
INSTALLED=0
ombist_install_node22_via_apt_nodesource() {
  INSTALLED=1
  MOCK_NODE_MAJOR=22
  return 0
}
major="$(ombist_node_major_mockable)"
[[ "${major}" -lt 22 ]] || fail "expected major 20 before install"
ombist_install_node22_via_apt_nodesource || fail "mock install failed"
major="$(ombist_node_major_mockable)"
[[ "${major}" -ge 22 ]] || fail "expected major 22 after mock install"
[[ "${INSTALLED}" -eq 1 ]] || fail "install should run"
unset MOCK_NODE_MAJOR INSTALLED
pass "mock install upgrades major"

echo "provision-node22.test: all passed"
