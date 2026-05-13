#!/usr/bin/env bash
# Mirrors default SYNC_OPENCLAW_PATCH_TARGET logic in tools/ombot-admin-lib/route-sync.sh
# when the variable is unset. Run from repo root: bash Ombot/tests/route-sync-patch-target-default.test.sh
set -euo pipefail

ombist_default_patch_target() {
  local frag_dir="${1:-}"
  if [[ -d "${frag_dir}" ]] && {
    [[ -f "${frag_dir}/10-gateway-transport.json" ]] || [[ -f "${frag_dir}/20-gateway-security.json" ]]
  }; then
    echo fragment
  else
    echo merged
  fi
}

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ombist-route-target-test.XXXXXX")"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

mkdir -p "${tmp}/empty"
[[ "$(ombist_default_patch_target "${tmp}/empty")" == "merged" ]] || {
  echo "expected merged for empty dir" >&2
  exit 1
}

mkdir -p "${tmp}/only40"
echo '{}' >"${tmp}/only40/40-route-sync-patch.json"
[[ "$(ombist_default_patch_target "${tmp}/only40")" == "merged" ]] || {
  echo "expected merged when only 40-route-sync exists" >&2
  exit 1
}

mkdir -p "${tmp}/has20"
echo '{}' >"${tmp}/has20/20-gateway-security.json"
[[ "$(ombist_default_patch_target "${tmp}/has20")" == "fragment" ]] || {
  echo "expected fragment when 20-gateway-security exists" >&2
  exit 1
}

mkdir -p "${tmp}/has10"
echo '{}' >"${tmp}/has10/10-gateway-transport.json"
[[ "$(ombist_default_patch_target "${tmp}/has10")" == "fragment" ]] || {
  echo "expected fragment when 10-gateway-transport exists" >&2
  exit 1
}

echo "route-sync-patch-target-default: ok (root=${root})"
