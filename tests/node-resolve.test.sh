#!/usr/bin/env bash
# Smoke test for ombot-admin-lib/node-resolve.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${ROOT}/tools/ombot-admin-lib"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# shellcheck source=/dev/null
. "${LIB}/json.sh"
# shellcheck source=/dev/null
. "${LIB}/node-resolve.sh"

fail() {
  echo "node-resolve.test: FAIL: $*" >&2
  exit 1
}

pass() {
  echo "node-resolve.test: ok $*"
}

FAKE_NODE="${TMP}/fake-node"
cat > "${FAKE_NODE}" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-e" ]]; then exit 0; fi
exit 0
EOF
chmod +x "${FAKE_NODE}"

if ombist_node_executable "${FAKE_NODE}"; then
  pass "ombist_node_executable accepts fake node"
else
  fail "ombist_node_executable rejected fake node"
fi

if ombist_node_executable "${TMP}/missing-node"; then
  fail "ombist_node_executable accepted missing path"
else
  pass "ombist_node_executable rejects missing"
fi

# nvm glob fallback (headless layout)
ombot_home="${TMP}/ombot-home"
nvm_dir="${ombot_home}/.nvm/versions/node/v22.0.0/bin"
mkdir -p "${nvm_dir}" "${TMP}/empty-bin"
install -m 0755 "${FAKE_NODE}" "${nvm_dir}/node"
export OMBOT_HOME="${ombot_home}"
export NVM_DIR="${ombot_home}/.nvm"
export PATH="${TMP}/empty-bin"
resolved_nvm="$(ombist_resolve_node_bin 2>/dev/null || true)"
if [[ "${resolved_nvm}" == "${nvm_dir}/node" ]]; then
  pass "resolved via nvm versions glob"
else
  fail "expected ${nvm_dir}/node, got '${resolved_nvm}'"
fi

if ombist_has_node && ombist_has_npm; then
  pass "ombist_has_node true (npm may be false without fake npm)"
fi

if ombist_has_node; then
  pass "ombist_has_node true when nvm node present"
else
  fail "ombist_has_node false unexpectedly"
fi

pass "all checks"
