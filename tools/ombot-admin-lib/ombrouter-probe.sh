#!/usr/bin/env bash
# Probe OmbRouter presence/version using OpenClaw config + proxy reachability.
# shellcheck shell=bash

ombist_cmd_ombrouter_probe_main() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
  local proxy_b64="${OMBIST_PROBE_PROXY_B64:-}"
  local min_b64="${OMBIST_MIN_VERSION_B64:-}"
  local proxy=""
  local min_v="1.0.0"

  if [[ -n "${proxy_b64}" ]]; then
    proxy="$(printf '%s' "${proxy_b64}" | base64 -d 2>/dev/null || true)"
  fi
  if [[ -n "${min_b64}" ]]; then
    min_v="$(printf '%s' "${min_b64}" | base64 -d 2>/dev/null || true)"
  fi
  if [[ -z "${min_v}" ]]; then
    min_v="1.0.0"
  fi

  local node_bin
  node_bin="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    local err
    err="$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "node not in PATH")")"
    ombist_emit_envelope false "ombrouter_probe" "node not found." "{}" "[]" "${err}"
    return 0
  fi

  local out
  set +e
  out="$(
    OMBIST_P="${proxy}" OMBIST_M="${min_v}" OMBIST_C="${cfg}" "${node_bin}" - <<'NODE'
const fs = require('fs');
const { execSync } = require('child_process');
const proxy = (process.env.OMBIST_P || '').trim();
const minV = (process.env.OMBIST_M || '1.0.0').trim();
const cfg = (process.env.OMBIST_C || '/etc/ombot/openclaw.json').trim();
function parts(v) {
  const h = String(v || '').split(/[-+]/)[0];
  return h.split('.').map((s) => {
    const m = String(s).match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
}
function lt(a, b) {
  const A = parts(a);
  const B = parts(b);
  const n = Math.max(A.length, B.length, 1);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
let plugin = false;
try {
  if (fs.existsSync(cfg)) {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    plugin = Array.isArray(j.plugins) && j.plugins.some((p) => p && p.id === 'ombrouter');
  }
} catch (_) {}
let curlOk = false;
if (/^https?:\/\/.+/i.test(proxy)) {
  const base = proxy.replace(/\/+$/, '');
  try {
    execSync('curl -sf --max-time 3 ' + JSON.stringify(base + '/models'), { stdio: 'ignore' });
    curlOk = true;
  } catch (_) {}
}
let ver = '';
try {
  const s = execSync('npm list -g ombrouter --depth=0 2>/dev/null', { encoding: 'utf8' });
  const m = s.match(/ombrouter@([0-9][^\s)]*)/);
  if (m) ver = m[1].trim();
} catch (_) {}
if (!ver) {
  try {
    execSync('command -v ombrouter >/dev/null 2>&1', { stdio: 'ignore' });
    const t = execSync('ombrouter --version 2>/dev/null', { encoding: 'utf8' });
    ver = String(t || '').trim().split(/\r?\n/)[0] || '';
  } catch (_) {}
}
if (plugin || curlOk) {
  if (ver && lt(ver, minV)) {
    process.stdout.write(JSON.stringify({ status: 'presentOutdated', version: ver, detail: '已安裝 ' + ver + '，App 建議至少 ' + minV + '。' }));
  } else {
    process.stdout.write(JSON.stringify({ status: 'presentOk', version: ver || null, detail: '' }));
  }
} else {
  process.stdout.write(JSON.stringify({ status: 'missing', version: null, detail: '未偵測到 ombrouter 外掛且 proxy 無法取得 /v1/models。' }));
}
NODE
  )"
  local rc=$?
  set -e
  if [[ "${rc}" -ne 0 ]] || [[ -z "${out}" ]] || [[ "${out}" != \{* ]]; then
    local err
    err="$(printf '[{"code":"PROBE_FAILED","message":%s}]' "$(ombist_json_escape_string "probe script failed")")"
    ombist_emit_envelope false "ombrouter_probe" "probe failed." "{}" "[]" "${err}"
    return 0
  fi

  local status version detail
  status="$(node -p "JSON.parse(process.argv[1]).status||''" "${out}" 2>/dev/null || true)"
  version="$(node -p "const v=JSON.parse(process.argv[1]).version; v===null?'':String(v||'')" "${out}" 2>/dev/null || true)"
  detail="$(node -p "const v=JSON.parse(process.argv[1]).detail; v===null?'':String(v||'')" "${out}" 2>/dev/null || true)"
  if [[ -z "${status}" ]]; then
    local err
    err="$(printf '[{"code":"PROBE_FAILED","message":%s}]' "$(ombist_json_escape_string "probe output missing status")")"
    ombist_emit_envelope false "ombrouter_probe" "probe failed." "{}" "[]" "${err}"
    return 0
  fi

  local data summary
  data="$(printf '{"status":%s,"version":%s,"detail":%s}' \
    "$(ombist_json_escape_string "${status}")" \
    "$(ombist_json_escape_string "${version}")" \
    "$(ombist_json_escape_string "${detail}")")"
  summary="ombrouter probe: ${status}"
  ombist_emit_envelope true "ombrouter_probe" "${summary}" "${data}" "[]" "[]"
}
