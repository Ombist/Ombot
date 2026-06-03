#!/usr/bin/env bash
# Golden-path: refresh ombot-admin, repair OpenClaw route, restart services, verify gateway + /readyz.
# shellcheck shell=bash

ombist_envelope_line_ok() {
  local line="${1:-}"
  local node_bin="${2:-}"
  [[ "${line}" == \{* ]] || return 1
  [[ -n "${node_bin}" ]] || return 1
  "${node_bin}" -e 'const j=JSON.parse(process.argv[1]); process.exit(j.ok===true?0:1)' "${line}" 2>/dev/null
}

ombist_capture_last_json_line() {
  local tmp
  tmp="$(mktemp)"
  "$@" >"${tmp}" 2>&1 || true
  tail -n1 "${tmp}" | tr -d '\r'
  rm -f "${tmp}"
}

ombist_cmd_bot_ensure_ready_main() {
  local skip_route=0
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --skip-route) skip_route=1 ;;
    esac
  done

  ombist_export_standard_path
  local node_bin repo health_port readyz_body ready_code gw_port warnings_json
  warnings_json="[]"
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "bot_ensure_ready" "node not found." "{}" "[]" \
      "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  local major
  major="$("${node_bin}" -p 'parseInt(process.versions.node.split(".")[0],10)' 2>/dev/null || echo 0)"
  if [[ "${major}" -lt 22 ]]; then
    ombist_emit_envelope false "bot_ensure_ready" "node version < 22 (found $(command -v node 2>/dev/null || echo missing))." "{}" "[]" \
      '[{"code":"NODE_TOO_OLD","message":"require Node.js >= 22"}]'
    return 0
  fi

  repo="${OMBOT_REPO_DIR:-/opt/ombot/Ombot}"
  if [[ ! -f "${repo}/tools/ombot-admin" ]]; then
    ombist_emit_envelope false "bot_ensure_ready" "Ombot repo missing." "{}" "[]" \
      '[{"code":"CLI_MISSING","message":"OMBOT_REPO_DIR invalid"}]'
    return 0
  fi

  local gw_unit ombot_unit
  gw_unit="$(ombist_gateway_pick_unit "ombist-openclaw-gateway.service" "openclaw-gateway@Ombist_IOS.service")"
  ombot_unit="$(ombist_gateway_pick_unit "ombist-ombot.service" "ombot.service")"
  if ! ombist_as_root systemctl cat "${gw_unit}" >/dev/null 2>&1; then
    ombist_emit_envelope false "bot_ensure_ready" "gateway unit not installed." \
      "$(printf '{"gatewayUnit":%s}' "$(ombist_json_escape_string "${gw_unit}")")" "[]" \
      '[{"code":"UNIT_MISSING","message":"run full provision first"}]'
    return 0
  fi

  local step_line
  step_line="$(ombist_capture_last_json_line ombist_cmd_tools_install_main)"
  if ! ombist_envelope_line_ok "${step_line}" "${node_bin}"; then
    ombist_emit_envelope false "bot_ensure_ready" "tools install failed." "{}" "[]" \
      '[{"code":"TOOLS_INSTALL_FAILED","message":"ombot-admin tools install did not succeed"}]'
    return 0
  fi

  if [[ "${skip_route}" -eq 0 ]]; then
    step_line="$(ombist_capture_last_json_line ombist_cmd_openclaw_config_repair_route_main)"
    if ! ombist_envelope_line_ok "${step_line}" "${node_bin}"; then
      ombist_emit_envelope false "bot_ensure_ready" "openclaw repair-route failed." "{}" "[]" \
        '[{"code":"REPAIR_ROUTE_FAILED","message":"openclaw config repair-route did not succeed"}]'
      return 0
    fi
  else
    ombist_cmd_openclaw_compose_main --no-flock 2>/dev/null || ombist_cmd_openclaw_compose_main 2>/dev/null || true
    ombist_as_root systemctl restart "${gw_unit}" 2>/dev/null || true
  fi

  ombist_as_root systemctl restart "${gw_unit}" 2>/dev/null || true
  sleep 2
  ombist_as_root systemctl restart "${ombot_unit}" 2>/dev/null || true
  sleep 1

  gw_port="${OPENCLAW_GATEWAY_PORT:-18789}"
  if ! ombist_wait_gateway_loopback "${gw_port}" 60; then
    ombist_emit_envelope false "bot_ensure_ready" "gateway port ${gw_port} not listening." \
      "$(printf '{"gatewayPort":%s,"gatewayUnit":%s}' "$(ombist_json_escape_string "${gw_port}")" "$(ombist_json_escape_string "${gw_unit}")")" \
      "[]" '[{"code":"GATEWAY_NOT_READY","message":"loopback gateway not listening"}]'
    return 0
  fi

  health_port="${OMBOT_HEALTH_PORT:-9090}"
  if [[ -f /etc/ombot/ombot.env ]]; then
    local hp
    hp="$(grep -E '^HEALTH_PORT=' /etc/ombot/ombot.env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
    if [[ -n "${hp}" ]]; then
      health_port="${hp}"
    fi
  fi

  readyz_body="$(curl -fsS --max-time 10 "http://127.0.0.1:${health_port}/readyz" 2>/dev/null || true)"
  ready_code=0
  if [[ -z "${readyz_body}" ]]; then
    ready_code=503
  elif ! printf '%s' "${readyz_body}" | "${node_bin}" -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.ready===true?0:1)' 2>/dev/null; then
    ready_code=503
  fi

  if [[ "${ready_code}" -ne 0 ]]; then
    ombist_emit_envelope false "bot_ensure_ready" "ombot /readyz not ready (port ${health_port})." \
      "$(printf '{"healthPort":%s,"readyz":%s}' "$(ombist_json_escape_string "${health_port}")" "$(ombist_json_escape_string "${readyz_body:-}")")" \
      "[]" '[{"code":"OMBOT_NOT_READY","message":"/readyz returned not ready"}]'
    return 0
  fi

  if declare -F ombist_cmd_gateway_config_drift_main >/dev/null 2>&1; then
    local drift_line
    drift_line="$(ombist_capture_last_json_line ombist_cmd_gateway_config_drift_main)"
    if [[ -n "${drift_line}" ]] && [[ "${drift_line}" == \{* ]] && ! ombist_envelope_line_ok "${drift_line}" "${node_bin}"; then
      warnings_json='[{"code":"CONFIG_DRIFT","message":"token/scope drift detected (non-blocking)"}]'
    fi
  fi

  local data summary
  data="$(printf '{"gatewayPort":%s,"healthPort":%s,"gatewayUnit":%s,"ombotUnit":%s,"ready":true}' \
    "$(ombist_json_escape_string "${gw_port}")" \
    "$(ombist_json_escape_string "${health_port}")" \
    "$(ombist_json_escape_string "${gw_unit}")" \
    "$(ombist_json_escape_string "${ombot_unit}")")"
  summary="bot ensure-ready ok; gateway :${gw_port}; readyz :${health_port}"
  ombist_emit_envelope true "bot_ensure_ready" "${summary}" "${data}" "${warnings_json}" "[]"
}
