#!/usr/bin/env bash
# Gateway stability diagnostics for ombot-admin.
# shellcheck shell=bash

ombist_gateway_pick_unit() {
  local primary="$1"
  local fallback="$2"
  if ombist_as_root test -f "/etc/systemd/system/${primary}" 2>/dev/null; then
    printf '%s' "${primary}"
    return 0
  fi
  if ombist_as_root systemctl --no-pager cat "${primary}" >/dev/null 2>&1; then
    printf '%s' "${primary}"
    return 0
  fi
  printf '%s' "${fallback}"
}

ombist_cmd_gateway_health_gates_main() {
  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "gateway_health_gates" "node not found." '{"gates":{},"units":{}}' "[]" "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    ombist_emit_envelope false "gateway_health_gates" "systemctl not installed." '{"gates":{},"units":{}}' "[]" '[{"code":"NO_SYSTEMCTL","message":"systemctl not found"}]'
    return 0
  fi

  local ombot_unit gateway_unit since_window
  ombot_unit="$(ombist_gateway_pick_unit "ombist-ombot.service" "ombot.service")"
  gateway_unit="$(ombist_gateway_pick_unit "ombist-openclaw-gateway.service" "openclaw-gateway@Ombist_IOS.service")"
  since_window="${OPENCLAW_GATE_HEALTH_SINCE:-10 min ago}"

  local ombot_logs gateway_logs
  ombot_logs="$(ombist_as_root journalctl -u "${ombot_unit}" --since "${since_window}" --no-pager 2>/dev/null || true)"
  gateway_logs="$(ombist_as_root journalctl -u "${gateway_unit}" --since "${since_window}" --no-pager 2>/dev/null || true)"

  local combined
  combined="$(printf '%s\n%s\n' "${ombot_logs}" "${gateway_logs}")"

  local data
  data="$(
    printf '%s' "${combined}" | "${node_bin}" -e '
const fs = require("fs");
const text = fs.readFileSync(0, "utf8");
const count = (re) => (text.match(re) || []).length;
const pairing = count(/NOT_PAIRED|DEVICE_IDENTITY_REQUIRED|device identity required/gi);
const scope = count(/missing scope|insufficient_scope|operator\.write/gi);
const provider = count(/No API key found|invalid api key|401|unauthorized|AUTH_FAILED/gi);
const gates = {
  pairing: { status: pairing > 0 ? "fail" : "pass", hits: pairing },
  scope: { status: scope > 0 ? "fail" : "pass", hits: scope },
  provider: { status: provider > 0 ? "fail" : "pass", hits: provider },
};
const unhealthy = Object.values(gates).some((g) => g.status !== "pass");
process.stdout.write(JSON.stringify({ gates, unhealthy }));
'
  )"
  if [[ -z "${data}" ]]; then
    data='{"gates":{"pairing":{"status":"unknown","hits":0},"scope":{"status":"unknown","hits":0},"provider":{"status":"unknown","hits":0}},"unhealthy":true}'
  fi

  local summary
  summary="$(
    "${node_bin}" -e '
const j = JSON.parse(process.argv[1]);
const p = j.gates.pairing;
const s = j.gates.scope;
const r = j.gates.provider;
const status = j.unhealthy ? "degraded" : "healthy";
process.stdout.write(`gateway gates ${status}; pairing=${p.hits}, scope=${s.hits}, provider=${r.hits}`);
' "${data}"
  )"

  local wrapped
  wrapped="$(printf '{"units":{"ombot":%s,"gateway":%s},"since":%s,"health":%s}' \
    "$(ombist_json_escape_string "${ombot_unit}")" \
    "$(ombist_json_escape_string "${gateway_unit}")" \
    "$(ombist_json_escape_string "${since_window}")" \
    "${data}")"
  ombist_emit_envelope true "gateway_health_gates" "${summary}" "${wrapped}" "[]" "[]"
}

ombist_cmd_gateway_config_drift_main() {
  local env_path runtime_cfg
  env_path="${OMBOT_ENV_PATH:-/etc/ombot/ombot.env}"
  runtime_cfg="${OPENCLAW_RUNTIME_CONFIG_PATH:-/home/ombot/.openclaw/openclaw.json}"
  local ombot_home="${OMBOT_HOME:-/home/ombot}"
  local frag_dir="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}"
  local ombot_tools_dir="${OMBOT_TOOLS_DIR:-}"
  if [[ -z "${ombot_tools_dir}" ]] && [[ -n "${LIB:-}" ]]; then
    if ombot_tools_dir="$(cd "${LIB}/../../Ombot/tools" 2>/dev/null && pwd)" && [[ -f "${ombot_tools_dir}/ombist-openclaw-drift.mjs" ]]; then
      :
    elif [[ -n "${OMBOT_REPO_DIR:-}" ]] && [[ -f "${OMBOT_REPO_DIR}/tools/ombist-openclaw-drift.mjs" ]]; then
      ombot_tools_dir="${OMBOT_REPO_DIR}/tools"
    else
      ombot_tools_dir=""
    fi
  fi

  local env_dump runtime_dump systemd_env
  env_dump="$(ombist_as_root cat "${env_path}" 2>/dev/null || true)"
  runtime_dump="$(ombist_as_root cat "${runtime_cfg}" 2>/dev/null || true)"
  systemd_env="$(ombist_as_root systemctl show ombist-ombot.service -p Environment --no-pager 2>/dev/null || true)"

  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "gateway_config_drift" "node not found." "{}" "[]" "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  local data
  data="$(
    "${node_bin}" -e '
const envRaw = process.argv[1] || "";
const cfgRaw = process.argv[2] || "";
const sdRaw = process.argv[3] || "";
const readEnv = (raw, key) => {
  const lines = raw.split(/\r?\n/);
  for (const ln of lines) {
    const line = ln.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(`${key}=`)) continue;
    return line.slice(key.length + 1).trim();
  }
  return "";
};
const parseCfgToken = (raw) => {
  try {
    const j = JSON.parse(raw || "{}");
    return (
      j?.gateway?.auth?.token ||
      (Array.isArray(j?.gateway?.auth?.tokens) && j.gateway.auth.tokens[0]) ||
      ""
    );
  } catch {
    return "";
  }
};
const parseSystemdEnv = (raw, key) => {
  const prefix = "Environment=";
  const idx = raw.indexOf(prefix);
  if (idx < 0) return "";
  const body = raw.slice(idx + prefix.length);
  const m = body.match(new RegExp(`${key}=("[^"]*"|\\S+)`));
  if (!m) return "";
  return String(m[1] || "").replace(/^"|"$/g, "");
};
const envToken = readEnv(envRaw, "OPENCLAW_GATEWAY_TOKEN");
const envScopes = readEnv(envRaw, "OPENCLAW_BRIDGE_OPERATOR_SCOPES");
const cfgToken = parseCfgToken(cfgRaw);
const sdToken = parseSystemdEnv(sdRaw, "OPENCLAW_GATEWAY_TOKEN");
const sdScopes = parseSystemdEnv(sdRaw, "OPENCLAW_BRIDGE_OPERATOR_SCOPES");
const drift = [];
if (envToken && cfgToken && envToken !== cfgToken) drift.push("token_env_vs_runtime");
if (envToken && sdToken && envToken !== sdToken) drift.push("token_env_vs_systemd");
if (envScopes && sdScopes && envScopes !== sdScopes) drift.push("scopes_env_vs_systemd");
const out = {
  sources: {
    envPathPresent: envRaw.length > 0,
    runtimeConfigPresent: cfgRaw.length > 0,
    systemdPresent: sdRaw.length > 0,
  },
  values: {
    envGatewayTokenSet: Boolean(envToken),
    runtimeGatewayTokenSet: Boolean(cfgToken),
    systemdGatewayTokenSet: Boolean(sdToken),
    envBridgeScopesSet: Boolean(envScopes),
    systemdBridgeScopesSet: Boolean(sdScopes),
  },
  drift,
};
process.stdout.write(JSON.stringify(out));
' "${env_dump}" "${runtime_dump}" "${systemd_env}"
  )"

  if [[ -n "${node_bin}" ]] && [[ -n "${ombot_tools_dir}" ]] && [[ -f "${ombot_tools_dir}/ombist-openclaw-drift.mjs" ]]; then
    local extra
    extra="$("${node_bin}" "${ombot_tools_dir}/ombist-openclaw-drift.mjs" "${env_dump}" "${runtime_dump}" "${systemd_env}" "${frag_dir}" "${ombot_home}" 2>/dev/null || true)"
    if [[ -n "${extra}" ]] && [[ "${extra}" == \{* ]]; then
      data="$("${node_bin}" -e '
const base = JSON.parse(process.argv[1]);
const ext = JSON.parse(process.argv[2]);
const drift = Array.isArray(base.drift) ? base.drift.slice() : [];
if (ext.composedMatchesRuntime === false) drift.push("composed_runtime_vs_fragments_mismatch");
if (ext.bridgeAgentIdMatch === false) drift.push("bridge_agent_id_vs_agents_list");
if (ext.llmSecretDuplicationWarning) drift.push("llm_secret_env_and_auth_profiles_overlap");
base.drift = drift;
base.openclawExtended = ext;
process.stdout.write(JSON.stringify(base));
' "${data}" "${extra}")"
    fi
  fi

  local ok_flag summary
  ok_flag="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.drift.length===0?"true":"false")' "${data}")"
  summary="$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.drift.length===0?"no config drift for token/scope sources":"config drift found: "+j.drift.join(","))' "${data}")"

  if [[ "${ok_flag}" == "true" ]]; then
    ombist_emit_envelope true "gateway_config_drift" "${summary}" "${data}" "[]" "[]"
  else
    ombist_emit_envelope false "gateway_config_drift" "${summary}" "${data}" "[]" '[{"code":"CONFIG_DRIFT","message":"token/scope source mismatch detected"}]'
  fi
}

ombist_cmd_gateway_loopback_main() {
  ombist_export_standard_path
  local node_bin repo
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    ombist_emit_envelope false "gateway_loopback" "node not found." "{}" "[]" "$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    return 0
  fi

  repo="${OMBOT_REPO_DIR:-/opt/ombot/Ombot}"
  if [[ ! -f "${repo}/openclawConfigSelfHeal.js" ]]; then
    ombist_emit_envelope false "gateway_loopback" "openclawConfigSelfHeal.js not found." "{}" "[]" '[{"code":"NO_REPO","message":"Ombot repo path invalid"}]'
    return 0
  fi

  local gateway_unit gw_state data summary ok_flag
  gateway_unit="$(ombist_gateway_pick_unit "ombist-openclaw-gateway.service" "openclaw-gateway@Ombist_IOS.service")"
  gw_state="$(ombist_as_root systemctl is-active "${gateway_unit}" 2>/dev/null || true)"

  data="$(
    OMBOT_REPO_DIR="${repo}" "${node_bin}" --input-type=module -e "
import { probeGatewayLoopback, parseGatewayLoopbackTarget, isGatewayWatchdogEnabled } from '${repo}/openclawConfigSelfHeal.js';
const target = parseGatewayLoopbackTarget();
const probe = await probeGatewayLoopback(2000);
const out = {
  host: target.host,
  port: target.port,
  url: target.url,
  reachable: probe.ok,
  error: probe.ok ? null : (probe.error || 'closed'),
  watchdogEnabled: isGatewayWatchdogEnabled(),
  systemd: { unit: '${gateway_unit}', active: '${gw_state}' },
};
process.stdout.write(JSON.stringify(out));
" 2>/dev/null || true
  )"

  if [[ -z "${data}" || "${data}" != \{* ]]; then
    ombist_emit_envelope false "gateway_loopback" "probe failed." "{}" "[]" '[{"code":"PROBE_FAILED","message":"could not probe loopback gateway"}]'
    return 0
  fi

  ok_flag="$("${node_bin}" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.reachable?"true":"false")' "${data}")"
  summary="$("${node_bin}" -e 'const j=JSON.parse(process.argv[1]); const s=j.reachable?"reachable":"down"; process.stdout.write(`gateway loopback ${s} (${j.host}:${j.port}); unit ${j.systemd.unit}=${j.systemd.active}`)' "${data}")"

  if [[ "${ok_flag}" == "true" ]]; then
    ombist_emit_envelope true "gateway_loopback" "${summary}" "${data}" "[]" "[]"
  else
    ombist_emit_envelope false "gateway_loopback" "${summary}" "${data}" "[]" '[{"code":"GATEWAY_DOWN","message":"loopback gateway port not accepting TCP"}]'
  fi
}
