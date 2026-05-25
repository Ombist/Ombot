#!/usr/bin/env bash
# Ensure OpenClaw json has gateway.mode=local (newer openclaw gateway requires it).
# shellcheck shell=bash

ombist_cmd_openclaw_config_ensure_local_main() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
  local port="${OPENCLAW_GATEWAY_PORT:-18789}"
  local ombot_group="${OMBOT_GROUP:-ombot}"

  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    local err
    err="$(printf '[{"code":%s,"message":%s}]' "NO_NODE" "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    ombist_emit_envelope false "openclaw_config_ensure_local" "node not found." '{}' "[]" "${err}"
    return 0
  fi

  local out
  set +e
  out="$(
    OMBIST_OPENCLAW_CFG="${cfg}" OPENCLAW_GATEWAY_PORT="${port}" ombist_as_root "${node_bin}" - <<'NODE'
const fs = require('fs');
const path = process.env.OMBIST_OPENCLAW_CFG;
const defaultPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
let cfg;
let previousMode = null;
let created = false;
let changed = false;
try {
  if (!fs.existsSync(path)) {
    cfg = { gateway: { mode: 'local', bind: 'loopback', port: defaultPort } };
    created = true;
    changed = true;
  } else {
    cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!cfg.gateway || typeof cfg.gateway !== 'object') cfg.gateway = {};
    previousMode = cfg.gateway.mode === undefined ? null : cfg.gateway.mode;
    if (cfg.gateway.mode !== 'local') {
      cfg.gateway.mode = 'local';
      changed = true;
    }
  }
  if (created || changed) {
    const tmp = `${path}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, path);
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      created,
      changed,
      previousMode,
      path,
    })
  );
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: String(e && e.message ? e.message : e),
    })
  );
}
NODE
  )"
  local rc=$?
  set -e
  if [[ "${rc}" -eq 7 ]]; then
    local err
    err="$(printf '[{"code":%s,"message":%s}]' "NO_SUDO" "$(ombist_json_escape_string "passwordless sudo or root required")")"
    ombist_emit_envelope false "openclaw_config_ensure_local" "need root or passwordless sudo." '{}' "[]" "${err}"
    return 0
  fi

  if [[ -z "${out}" ]] || [[ "${out}" != \{* ]]; then
    ombist_emit_envelope false "openclaw_config_ensure_local" "unexpected merge output." '{}' "[]" '[{"code":"MERGE_FAILED","message":"openclaw config merge failed"}]'
    return 0
  fi

  local ok_flag
  ok_flag="$("${node_bin}" -p "JSON.parse(process.argv[1]).ok===true" "${out}" 2>/dev/null || echo false)"
  if [[ "${ok_flag}" != "true" ]]; then
    local em
    em="$("${node_bin}" -p "JSON.parse(process.argv[1]).error||'unknown'" "${out}" 2>/dev/null || echo unknown)"
    local err
    err="$(printf '[{"code":%s,"message":%s}]' "MERGE_FAILED" "$(ombist_json_escape_string "${em}")")"
    ombist_emit_envelope false "openclaw_config_ensure_local" "${em}" '{}' "[]" "${err}"
    return 0
  fi

  ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || ombist_as_root chown root:root "${cfg}" 2>/dev/null || true
  ombist_as_root chmod 640 "${cfg}" 2>/dev/null || true

  local gw_restarted="no_unit"
  if ombist_as_root systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
    if ombist_as_root systemctl restart ombist-openclaw-gateway.service 2>/dev/null; then
      gw_restarted="restarted"
    else
      gw_restarted="restart_failed"
    fi
  fi

  local summary data
  summary="$("${node_bin}" -p "
const j=JSON.parse(process.argv[1]);
const g=process.argv[2];
let s='gateway.mode=local';
if (j.created) s += '; created '+j.path;
else if (j.changed) s += '; was '+JSON.stringify(j.previousMode);
else s += ' (already set)';
s += '; '+g;
s
" "${out}" "${gw_restarted}")"

  data="$("${node_bin}" -p "
const j=JSON.parse(process.argv[1]);
const g=process.argv[2];
JSON.stringify({
  configPath: j.path,
  created: j.created,
  changed: j.changed,
  previousMode: j.previousMode,
  gatewayRestart: g,
})
" "${out}" "${gw_restarted}")"

  ombist_emit_envelope true "openclaw_config_ensure_local" "${summary}" "${data}" "[]" "[]"
}
