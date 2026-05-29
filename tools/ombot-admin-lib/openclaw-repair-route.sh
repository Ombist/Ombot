#!/usr/bin/env bash
# Shared OpenClaw validate/repair helpers + repair-route command.
# shellcheck shell=bash

ombist_validate_openclaw_runtime_config() {
  local runtime_path="$1"
  local tools_dir="$2"
  local node_bin="$3"
  [[ -n "${runtime_path}" ]] || return 0
  [[ -f "${runtime_path}" ]] || return 0
  [[ -n "${tools_dir}" ]] || return 0
  [[ -f "${tools_dir}/openclaw-validate-runtime-config.mjs" ]] || return 0
  if "${node_bin}" "${tools_dir}/openclaw-validate-runtime-config.mjs" --repair "${runtime_path}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

ombist_repair_openclaw_json_paths() {
  local tools_dir="$1"
  local node_bin="$2"
  shift 2
  local p
  for p in "$@"; do
    [[ -n "${p}" ]] || continue
    [[ -f "${p}" ]] || continue
    ombist_repair_openclaw_json_file "${p}" "${tools_dir}" "${node_bin}" || true
  done
}

ombist_wait_gateway_loopback() {
  local port="${1:-18789}"
  local timeout_sec="${2:-60}"
  local i=0
  while [[ "${i}" -lt "${timeout_sec}" ]]; do
    if command -v ss >/dev/null 2>&1; then
      if ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN; then
        return 0
      fi
    elif command -v nc >/dev/null 2>&1; then
      if nc -z 127.0.0.1 "${port}" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

ombist_resolve_ombot_tools_dir() {
  local d="${OMBOT_TOOLS_DIR:-}"
  if [[ -n "${d}" ]] && [[ -f "${d}/openclaw-compose.mjs" ]]; then
    printf '%s' "${d}"
    return 0
  fi
  if [[ -n "${LIB:-}" ]]; then
    if d="$(cd "${LIB}/../../Ombot/tools" 2>/dev/null && pwd)" && [[ -f "${d}/openclaw-compose.mjs" ]]; then
      printf '%s' "${d}"
      return 0
    fi
  fi
  if [[ -n "${OMBOT_REPO_DIR:-}" ]] && [[ -f "${OMBOT_REPO_DIR}/tools/openclaw-compose.mjs" ]]; then
    printf '%s' "${OMBOT_REPO_DIR}/tools"
    return 0
  fi
  if [[ -f "/opt/ombot/Ombot/tools/openclaw-compose.mjs" ]]; then
    printf '%s' "/opt/ombot/Ombot/tools"
    return 0
  fi
  return 1
}

ombist_repair_openclaw_json_file() {
  local file_path="$1"
  local tools_dir="$2"
  local node_bin="$3"
  [[ -n "${file_path}" ]] || return 0
  [[ -f "${file_path}" ]] || return 0
  [[ -n "${tools_dir}" ]] || return 1
  [[ -f "${tools_dir}/openclaw-validate-runtime-config.mjs" ]] || return 1
  "${node_bin}" "${tools_dir}/openclaw-validate-runtime-config.mjs" --repair "${file_path}" >/dev/null 2>&1
}

ombist_cmd_openclaw_config_repair_route_main() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
  local runtime_cfg="${OPENCLAW_RUNTIME_CONFIG_PATH:-/home/ombot/.openclaw/openclaw.json}"
  local frag_dir="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}"
  local port="${OPENCLAW_GATEWAY_PORT:-18789}"
  local ombot_user="${OMBOT_USER:-ombot}"
  local ombot_group="${OMBOT_GROUP:-ombot}"
  local ombot_home="${OMBOT_HOME:-/home/ombot}"
  local actions_json="[]"
  local restored_last_good=false
  local repaired=false
  local composed=false
  local gw_restart="no_unit"
  local gateway_listening=false

  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "openclaw_config_repair_route" "node not found." "{}" "[]" "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  local ombot_tools_dir
  if ! ombot_tools_dir="$(ombist_resolve_ombot_tools_dir)"; then
    ombist_emit_envelope false "openclaw_config_repair_route" "Ombot tools missing." "{}" "[]" '[{"code":"CLI_MISSING","message":"install Ombot under /opt/ombot/Ombot or set OMBOT_TOOLS_DIR"}]'
    return 0
  fi

  local last_good="${runtime_cfg}.last-good"
  if [[ -f "${last_good}" ]]; then
    if ombist_as_root cp "${last_good}" "${runtime_cfg}" 2>/dev/null; then
      ombist_as_root chown "${ombot_user}:${ombot_group}" "${runtime_cfg}" 2>/dev/null || true
      restored_last_good=true
      actions_json='["restored_last_good_runtime"]'
    fi
    if [[ "${cfg}" != "${runtime_cfg}" ]] && ombist_as_root cp "${last_good}" "${cfg}" 2>/dev/null; then
      ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || true
      actions_json='["restored_last_good_runtime","restored_last_good_etc"]'
    fi
  fi

  local repair_out
  repair_out="$(
    OPENCLAW_FRAGMENTS_DIR="${frag_dir}" \
      OPENCLAW_RUNTIME_CONFIG_PATH="${runtime_cfg}" \
      OPENCLAW_CONFIG_PATH="${cfg}" \
      "${node_bin}" "${ombot_tools_dir}/openclaw-repair-route.mjs" --json 2>/dev/null || true
  )"
  if [[ -n "${repair_out}" ]] && [[ "${repair_out}" == \{* ]]; then
    if printf '%s' "${repair_out}" | "${node_bin}" -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.ok?0:1);' 2>/dev/null; then
      :
    else
      repaired=true
    fi
    if printf '%s' "${repair_out}" | "${node_bin}" -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(j.repaired?"true":"false");' 2>/dev/null | grep -q true; then
      repaired=true
    fi
  fi

  if [[ -d "${frag_dir}" ]]; then
    local frag
    for frag in "${frag_dir}"/*.json; do
      [[ -f "${frag}" ]] || continue
      [[ "${frag}" == *.bak ]] && continue
      if ombist_repair_openclaw_json_file "${frag}" "${ombot_tools_dir}" "${node_bin}"; then
        repaired=true
      fi
    done
  fi
  if ombist_repair_openclaw_json_file "${runtime_cfg}" "${ombot_tools_dir}" "${node_bin}"; then
    repaired=true
  fi
  if [[ "${cfg}" != "${runtime_cfg}" ]] && ombist_repair_openclaw_json_file "${cfg}" "${ombot_tools_dir}" "${node_bin}"; then
    repaired=true
  fi

  if [[ -f "${ombot_tools_dir}/openclaw-compose.mjs" ]] && [[ -d "${frag_dir}" ]]; then
    if ombist_as_root env OPENCLAW_FRAGMENTS_DIR="${frag_dir}" OPENCLAW_RUNTIME_CONFIG_PATH="${runtime_cfg}" OPENCLAW_CONFIG_PATH="${cfg}" OPENCLAW_COMPOSE_USE_FLOCK=0 "${node_bin}" "${ombot_tools_dir}/openclaw-compose.mjs" >/dev/null 2>&1; then
      composed=true
      ombist_as_root chown "${ombot_user}:${ombot_group}" "${runtime_cfg}" 2>/dev/null || true
      ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || true
      ombist_repair_openclaw_json_file "${runtime_cfg}" "${ombot_tools_dir}" "${node_bin}" || true
      ombist_repair_openclaw_json_file "${cfg}" "${ombot_tools_dir}" "${node_bin}" || true
      local frag_40="${frag_dir}/40-route-sync-patch.json"
      if [[ -f "${frag_40}" ]]; then
        ombist_repair_openclaw_json_file "${frag_40}" "${ombot_tools_dir}" "${node_bin}" || true
      fi
    fi
  fi

  if ! ombist_validate_openclaw_runtime_config "${runtime_cfg}" "${ombot_tools_dir}" "${node_bin}"; then
    local err
    err='[{"code":"MERGE_FAILED","message":"openclaw config still invalid after repair-route"}]'
    ombist_emit_envelope false "openclaw_config_repair_route" "repair failed: invalid models shape." \
      "$(printf '{"restoredLastGood":%s,"repaired":%s,"composed":%s,"gatewayListening":false}' "${restored_last_good}" "${repaired}" "${composed}")" \
      "[]" "${err}"
    return 0
  fi

  local gw_unit
  gw_unit="$(ombist_gateway_pick_unit "ombist-openclaw-gateway.service" "openclaw-gateway@Ombist_IOS.service")"
  if ombist_as_root systemctl restart "${gw_unit}" 2>/dev/null; then
    gw_restart="restarted"
  elif [[ -n "${gw_unit}" ]]; then
    gw_restart="restart_failed"
  fi

  if ombist_wait_gateway_loopback "${port}" 60; then
    gateway_listening=true
  else
    gw_restart="not_listening"
  fi

  local data summary ok_flag
  data="$(printf '{"restoredLastGood":%s,"repaired":%s,"composed":%s,"gatewayRestart":%s,"gatewayListening":%s,"gatewayPort":%s}' \
    "${restored_last_good}" "${repaired}" "${composed}" \
    "$(ombist_json_escape_string "${gw_restart}")" "${gateway_listening}" \
    "$(ombist_json_escape_string "${port}")")"
  if [[ "${gateway_listening}" == "true" ]]; then
    ok_flag=true
    summary="openclaw_repair_route_ok; gateway=listening"
  else
    ok_flag=false
    summary="openclaw_repair_route_degraded; gateway=${gw_restart}"
  fi
  if [[ "${ok_flag}" == "true" ]]; then
    ombist_emit_envelope true "openclaw_config_repair_route" "${summary}" "${data}" "[]" "[]"
  else
    ombist_emit_envelope false "openclaw_config_repair_route" "${summary}" "${data}" "[]" '[{"code":"GATEWAY_NOT_READY","message":"gateway port not listening after repair"}]'
  fi
}
