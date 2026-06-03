#!/usr/bin/env bash
# openclaw compose / rollback for ombot-admin (JSON envelope).
# shellcheck shell=bash

ombist_cmd_openclaw_compose_main() {
  local ombot_tools_dir="${OMBOT_TOOLS_DIR:-}"
  if [[ -z "${ombot_tools_dir}" ]] && [[ -n "${LIB:-}" ]]; then
    if ombot_tools_dir="$(cd "${LIB}/../../Ombot/tools" 2>/dev/null && pwd)" && [[ -f "${ombot_tools_dir}/openclaw-compose.mjs" ]]; then
      :
    elif [[ -n "${OMBOT_REPO_DIR:-}" ]] && [[ -f "${OMBOT_REPO_DIR}/tools/openclaw-compose.mjs" ]]; then
      ombot_tools_dir="${OMBOT_REPO_DIR}/tools"
    else
      ombot_tools_dir=""
    fi
  fi
  if [[ -z "${ombot_tools_dir}" ]] || [[ ! -f "${ombot_tools_dir}/openclaw-compose.mjs" ]]; then
    ombist_emit_envelope false "openclaw_compose" "Ombot tools dir missing openclaw-compose.mjs." "{}" "[]" '[{"code":"CLI_MISSING","message":"set OMBOT_TOOLS_DIR or install Ombot repo under /opt/ombot/Ombot"}]'
    return 0
  fi

  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "openclaw_compose" "node not found." "{}" "[]" "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  local dry=false rollback=false strict=false json_out=false no_flock=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry=true; shift ;;
      --rollback) rollback=true; shift ;;
      --strict-keys) strict=true; shift ;;
      --json) json_out=true; shift ;;
      --no-flock) no_flock=true; shift ;;
      *) shift ;;
    esac
  done

  local args=()
  [[ "${dry}" == "true" ]] && args+=(--dry-run)
  [[ "${rollback}" == "true" ]] && args+=(--rollback)
  [[ "${strict}" == "true" ]] && args+=(--strict-keys)
  [[ "${json_out}" == "true" ]] && args+=(--json)
  [[ "${no_flock}" == "true" ]] && args+=(--no-flock)

  local out_json=""
  local err_file
  err_file="$(mktemp /tmp/ombist-compose-err.XXXXXX 2>/dev/null || echo "/tmp/ombist-compose-err.$$")"
  set +e
  out_json="$(ombist_as_root env \
    OPENCLAW_FRAGMENTS_DIR="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}" \
    OPENCLAW_RUNTIME_CONFIG_PATH="${OPENCLAW_RUNTIME_CONFIG_PATH:-/var/lib/ombot/openclaw.json}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}" \
    OPENCLAW_COMPOSE_USE_FLOCK="${OPENCLAW_COMPOSE_USE_FLOCK:-1}" \
    "${node_bin}" "${ombot_tools_dir}/openclaw-compose.mjs" "${args[@]}" 2>"${err_file}")"
  local rc=$?
  set -e

  local em=""
  em="$(tr '\n' ' ' < "${err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-400)"
  rm -f "${err_file}" 2>/dev/null || true

  if [[ "${rc}" -eq 2 ]]; then
    ombist_emit_envelope false "openclaw_compose" "compose lock not acquired." "{}" "[]" '[{"code":"COMPOSE_LOCKED","message":"another compose may be running"}]'
    return 0
  fi
  if [[ "${rc}" -eq 3 ]]; then
    ombist_emit_envelope false "openclaw_compose" "strict-keys validation failed." "{}" "[]" '[{"code":"STRICT_KEYS_VIOLATION","message":"fragment filename vs keys mismatch"}]'
    return 0
  fi
  if [[ "${rc}" -ne 0 ]]; then
    if [[ -z "${em}" ]]; then
      em="$(printf '%s' "${out_json}" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-400)"
    fi
    ombist_emit_envelope false "openclaw_compose" "compose failed." "{}" "[]" "$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${em:-compose exit ${rc}}")")"
    return 0
  fi

  local gw_restart="no_unit"
  if [[ "${dry}" != "true" ]]; then
    if ombist_as_root systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
      if ombist_as_root systemctl restart ombist-openclaw-gateway.service 2>/dev/null; then
        gw_restart="restarted"
      else
        gw_restart="restart_failed"
      fi
    fi
  fi

  local summary data
  summary="openclaw_compose_ok; gateway=${gw_restart}"
  if [[ "${dry}" == "true" ]]; then
    summary="openclaw_compose_dry_run"
  elif [[ "${rollback}" == "true" ]]; then
    summary="openclaw_compose_rollback"
  fi
  data="$(printf '{"gatewayRestart":%s,"dryRun":%s,"rollback":%s}' \
    "$(ombist_json_escape_string "${gw_restart}")" \
    "${dry}" \
    "${rollback}")"
  if [[ -n "${out_json}" ]] && "${node_bin}" -e "JSON.parse(process.argv[1])" "${out_json}" >/dev/null 2>&1; then
    data="$("${node_bin}" -e '
const rep = JSON.parse(process.argv[1]);
const base = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({ ...base, composeReport: rep }));
' "${out_json}" "${data}")"
  fi
  ombist_emit_envelope true "openclaw_compose" "${summary}" "${data}" "[]" "[]"
}
