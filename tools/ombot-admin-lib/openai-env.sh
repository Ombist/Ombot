#!/usr/bin/env bash
# Apply OPENAI provider env into /etc/ombot/ombot.env and restart core services.
# shellcheck shell=bash

ombist_cmd_openai_env_apply_main() {
  local env_path="${OMBOT_ENV_PATH:-/etc/ombot/ombot.env}"
  local key_raw="${OMB_OPENAI_KEY:-}"
  local base_raw="${OMB_OPENAI_BASE_URL:-}"
  local ombot_group="${OMBOT_GROUP:-ombot}"

  if ! command -v node >/dev/null 2>&1; then
    local err
    err="$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "node not in PATH")")"
    ombist_emit_envelope false "openai_env_apply" "node not found." "{}" "[]" "${err}"
    return 0
  fi

  local tmp_js="/tmp/ombist-openai-env-$$.js"
  cat > "${tmp_js}" <<'NODE'
const fs = require('fs');
const envPath = process.env.OMB_ENV_PATH || '/etc/ombot/ombot.env';
const key = process.env.OMB_OPENAI_KEY || '';
const base = process.env.OMB_OPENAI_BASE_URL || '';
let lines = [];
if (fs.existsSync(envPath)) {
  lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
}
const out = [];
const seen = new Set();
const setMap = new Map([
  ['OPENAI_API_KEY', key],
  ['OPENAI_BASE_URL', base],
]);
for (const line of lines) {
  const m = /^([A-Z0-9_]+)=/.exec(line);
  if (!m) {
    if (line !== '') out.push(line);
    continue;
  }
  const k = m[1];
  if (!setMap.has(k)) {
    out.push(line);
    continue;
  }
  if (seen.has(k)) continue;
  seen.add(k);
  const v = setMap.get(k) || '';
  if (v.trim() !== '') out.push(`${k}=${v}`);
}
for (const [k, v] of setMap) {
  if (seen.has(k)) continue;
  if ((v || '').trim() !== '') out.push(`${k}=${v}`);
}
fs.writeFileSync(envPath, out.join('\n') + '\n');
process.stdout.write(
  JSON.stringify({
    ok: true,
    hasOpenAIKey: key.trim() !== '',
    hasOpenAIBaseURL: base.trim() !== '',
    envPath,
  })
);
NODE

  local out
  out="$(OMB_ENV_PATH="${env_path}" OMB_OPENAI_KEY="${key_raw}" OMB_OPENAI_BASE_URL="${base_raw}" ombist_as_root node "${tmp_js}" 2>/dev/null || true)"
  rm -f "${tmp_js}" >/dev/null 2>&1 || true
  if [[ -z "${out}" ]] || [[ "${out}" != \{* ]]; then
    ombist_emit_envelope false "openai_env_apply" "env update failed." "{}" "[]" '[{"code":"APPLY_FAILED","message":"openai env update failed"}]'
    return 0
  fi

  local ok_flag
  ok_flag="$(node -p "JSON.parse(process.argv[1]).ok===true" "${out}" 2>/dev/null || echo false)"
  if [[ "${ok_flag}" != "true" ]]; then
    ombist_emit_envelope false "openai_env_apply" "env update failed." "{}" "[]" '[{"code":"APPLY_FAILED","message":"openai env update failed"}]'
    return 0
  fi

  ombist_as_root chmod 640 "${env_path}" >/dev/null 2>&1 || true
  ombist_as_root chown "root:${ombot_group}" "${env_path}" >/dev/null 2>&1 || ombist_as_root chown root:root "${env_path}" >/dev/null 2>&1 || true

  local gw_state="no_unit"
  local ombot_state="no_unit"
  if ombist_as_root systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
    ombist_as_root systemctl restart ombist-openclaw-gateway.service >/dev/null 2>&1 || true
    gw_state="$(ombist_as_root systemctl is-active ombist-openclaw-gateway.service 2>/dev/null || echo unknown)"
  fi
  if ombist_as_root systemctl list-unit-files 2>/dev/null | grep -q '^ombist-ombot.service'; then
    ombist_as_root systemctl restart ombist-ombot.service >/dev/null 2>&1 || true
    ombot_state="$(ombist_as_root systemctl is-active ombist-ombot.service 2>/dev/null || echo unknown)"
  fi

  local data summary
  data="$(printf '{"gatewayState":%s,"ombotState":%s}' \
    "$(ombist_json_escape_string "${gw_state}")" \
    "$(ombist_json_escape_string "${ombot_state}")")"
  summary="OpenAI provider env applied; gateway=${gw_state}; ombot=${ombot_state}"
  ombist_emit_envelope true "openai_env_apply" "${summary}" "${data}" "[]" "[]"
}
