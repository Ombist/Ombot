#!/usr/bin/env bash
# Route sync for Ombist_IOS: merge openclaw patch, optional cost config, optional auth profiles.
# shellcheck shell=bash

ombist_cmd_route_sync_main() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
  local ombot_group="${OMBOT_GROUP:-ombot}"
  local ombot_home="${OMBOT_HOME:-/home/ombot}"
  local patch_b64="${SYNC_OPENCLAW_PATCH_B64:-}"
  local cost_b64="${SYNC_COST_CONFIG_JSON_B64:-}"
  local cost_path="${SYNC_COST_CONFIG_PATH:-}"
  local auth_b64="${SYNC_OPENCLAW_AUTH_B64:-}"

  if [[ -z "${patch_b64}" && -z "${cost_b64}" && -z "${auth_b64}" ]]; then
    ombist_emit_envelope false "route_sync" "no payload provided." "{}" "[]" '[{"code":"NO_PAYLOAD","message":"missing sync payload"}]'
    return 0
  fi

  local node_bin
  node_bin="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    local err
    err="$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "node not in PATH")")"
    ombist_emit_envelope false "route_sync" "node not found." "{}" "[]" "${err}"
    return 0
  fi

  local work="/tmp/ombist-route-sync-$$"
  local patch_path="${work}/patch.json"
  local merge_js="${work}/merge-openclaw.mjs"
  local merge_out="${work}/merged-openclaw.json"
  local auth_path="${work}/auth.json"
  local auth_js="${work}/merge-auth.mjs"
  local cost_tmp="${work}/cost-config.json"
  mkdir -p "${work}" || {
    ombist_emit_envelope false "route_sync" "failed to create temp dir." "{}" "[]" '[{"code":"INTERNAL_ERROR","message":"unable to create temp directory"}]'
    return 0
  }
  cleanup_route_sync_tmp() {
    local d="${work:-}"
    if [[ -n "${d}" ]]; then
      rm -rf "${d}" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_route_sync_tmp EXIT

  local did_patch=false
  local did_cost=false
  local did_auth=false
  local gw_restart="no_unit"

  if [[ -n "${patch_b64}" ]]; then
    did_patch=true
    if ! printf '%s' "${patch_b64}" | base64 -d > "${patch_path}" 2>/dev/null; then
      ombist_emit_envelope false "route_sync" "invalid patch payload." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid patch payload base64"}]'
      return 0
    fi

    cat > "${merge_js}" <<'NODE'
const fs = require('fs');
const cfgPath = process.env.OMB_CFG;
const patchPath = process.env.OMB_PATCH;
const outPath = process.env.OMB_OUT;
const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
function mergePlugins(curList, patchList) {
  if (!Array.isArray(patchList)) return curList;
  const curArr = Array.isArray(curList) ? curList.slice() : [];
  for (const pp of patchList) {
    if (!pp || typeof pp !== 'object' || !pp.id) continue;
    const idx = curArr.findIndex((p) => p && p.id === pp.id);
    if (idx === -1) {
      curArr.push(pp);
      continue;
    }
    const existing = Object.assign({}, curArr[idx]);
    if (pp.config && typeof pp.config === 'object' && !Array.isArray(pp.config)) {
      if (!existing.config || typeof existing.config !== 'object') existing.config = {};
      deepMerge(existing.config, pp.config);
    }
    for (const kk of Object.keys(pp)) {
      if (kk === 'config') continue;
      existing[kk] = pp[kk];
    }
    curArr[idx] = existing;
  }
  return curArr;
}
function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (k === 'plugins' && Array.isArray(v)) {
      target.plugins = mergePlugins(target.plugins, v);
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}
deepMerge(cur, patch);
fs.writeFileSync(outPath, JSON.stringify(cur, null, 2) + '\n');
NODE

    local merge_err_file="${work}/merge.err"
    if ! OMB_CFG="${cfg}" OMB_PATCH="${patch_path}" OMB_OUT="${merge_out}" "${node_bin}" "${merge_js}" >/dev/null 2>"${merge_err_file}"; then
      local merge_err merge_err_json
      merge_err="$(tr '\n' ' ' < "${merge_err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
      if [[ -z "${merge_err}" ]]; then
        merge_err="openclaw patch merge failed"
      fi
      merge_err_json="$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${merge_err}")")"
      ombist_emit_envelope false "route_sync" "openclaw merge failed." "{}" "[]" "${merge_err_json}"
      return 0
    fi
    if ! ombist_as_root cp "${merge_out}" "${cfg}"; then
      local err_no_sudo
      err_no_sudo="$(printf '[{"code":"NO_SUDO","message":%s}]' "$(ombist_json_escape_string "passwordless sudo or root required")")"
      ombist_emit_envelope false "route_sync" "need root or passwordless sudo." "{}" "[]" "${err_no_sudo}"
      return 0
    fi
    ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || ombist_as_root chown root:root "${cfg}" 2>/dev/null || true
    ombist_as_root chmod 640 "${cfg}" 2>/dev/null || true
  fi

  if [[ -n "${cost_b64}" ]]; then
    if [[ -z "${cost_path}" ]]; then
      ombist_emit_envelope false "route_sync" "cost config path missing." "{}" "[]" '[{"code":"COST_PATH_MISSING","message":"cost config payload provided without path"}]'
      return 0
    fi
    did_cost=true
    if ! printf '%s' "${cost_b64}" | base64 -d > "${cost_tmp}" 2>/dev/null; then
      ombist_emit_envelope false "route_sync" "invalid cost payload." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid cost payload base64"}]'
      return 0
    fi
    if ! ombist_as_root mkdir -p "$(dirname "${cost_path}")"; then
      local err_no_sudo
      err_no_sudo="$(printf '[{"code":"NO_SUDO","message":%s}]' "$(ombist_json_escape_string "passwordless sudo or root required")")"
      ombist_emit_envelope false "route_sync" "need root or passwordless sudo." "{}" "[]" "${err_no_sudo}"
      return 0
    fi
    ombist_as_root cp "${cost_tmp}" "${cost_path}" || {
      ombist_emit_envelope false "route_sync" "cost config write failed." "{}" "[]" '[{"code":"MERGE_FAILED","message":"failed to write cost config"}]'
      return 0
    }
    ombist_as_root chown "ombot:${ombot_group}" "${cost_path}" 2>/dev/null || ombist_as_root chown root:root "${cost_path}" 2>/dev/null || true
    ombist_as_root chmod 640 "${cost_path}" 2>/dev/null || true
  fi

  if [[ -n "${auth_b64}" ]]; then
    did_auth=true
    if ! printf '%s' "${auth_b64}" | base64 -d > "${auth_path}" 2>/dev/null; then
      ombist_emit_envelope false "route_sync" "invalid auth payload." "{}" "[]" '[{"code":"AUTH_SYNC_FAILED","message":"invalid auth payload base64"}]'
      return 0
    fi

    cat > "${auth_js}" <<'NODE'
const fs = require('fs');
const home = String(process.env.HOME || process.env.OMBOT_HOME || '/home/ombot').trim();
const payloadPath = process.env.OMB_AUTH_PAYLOAD;
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const suffix = String(payload.profileIdSuffix || 'default');
const agents = payload.agents && typeof payload.agents === 'object' ? payload.agents : {};
function mergeAuthForAgent(agentId, providerKeys) {
  if (!agentId || typeof providerKeys !== 'object' || !providerKeys) return;
  const base = home + '/.openclaw/agents/' + agentId + '/agent';
  fs.mkdirSync(base, { recursive: true });
  const authPath = base + '/auth-profiles.json';
  let store = { version: 1, profiles: {} };
  if (fs.existsSync(authPath)) {
    try {
      const cur = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (cur && cur.version && cur.profiles && typeof cur.profiles === 'object') store = cur;
    } catch (e) {}
  }
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  for (const [prov, key] of Object.entries(providerKeys)) {
    if (!prov || typeof prov !== 'string') continue;
    if (typeof key !== 'string' || !String(key).trim()) continue;
    const provider = String(prov).trim();
    const profileKey = provider + ':' + suffix;
    store.profiles[profileKey] = { type: 'api_key', provider, key: String(key).trim() };
  }
  fs.writeFileSync(authPath, JSON.stringify(store, null, 2) + '\n');
}
for (const [agentId, providerKeys] of Object.entries(agents)) {
  mergeAuthForAgent(agentId, providerKeys);
}
NODE

    if [[ "$(id -u)" -eq 0 ]]; then
      if ! HOME="${ombot_home}" OMBOT_HOME="${ombot_home}" OMB_AUTH_PAYLOAD="${auth_path}" "${node_bin}" "${auth_js}" >/dev/null 2>&1; then
        ombist_emit_envelope false "route_sync" "auth profile merge failed." "{}" "[]" '[{"code":"AUTH_SYNC_FAILED","message":"failed to merge auth profiles"}]'
        return 0
      fi
    elif command -v sudo >/dev/null 2>&1 && sudo -n -u ombot true >/dev/null 2>&1; then
      if ! sudo -n -u ombot env HOME="${ombot_home}" OMBOT_HOME="${ombot_home}" OMB_AUTH_PAYLOAD="${auth_path}" PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/ombot/npm-global/bin" "${node_bin}" "${auth_js}" >/dev/null 2>&1; then
        ombist_emit_envelope false "route_sync" "auth profile merge failed." "{}" "[]" '[{"code":"AUTH_SYNC_FAILED","message":"failed to merge auth profiles"}]'
        return 0
      fi
    else
      local err_no_sudo
      err_no_sudo="$(printf '[{"code":"NO_SUDO","message":%s}]' "$(ombist_json_escape_string "sudo -n -u ombot required for auth profile sync")")"
      ombist_emit_envelope false "route_sync" "need root or passwordless sudo." "{}" "[]" "${err_no_sudo}"
      return 0
    fi
  fi

  if [[ "${did_patch}" == "true" || "${did_cost}" == "true" || "${did_auth}" == "true" ]]; then
    if ombist_as_root systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
      if ombist_as_root systemctl restart ombist-openclaw-gateway.service 2>/dev/null; then
        gw_restart="restarted"
      else
        gw_restart="restart_failed"
      fi
    fi
  fi

  local data summary
  data="$(printf '{"didPatch":%s,"didCostConfig":%s,"didAuthSync":%s,"costConfigPath":%s,"gatewayRestart":%s}' \
    "${did_patch}" \
    "${did_cost}" \
    "${did_auth}" \
    "$(ombist_json_escape_string "${cost_path}")" \
    "$(ombist_json_escape_string "${gw_restart}")")"
  summary="ombist_route_sync_ok; gateway=${gw_restart}"
  ombist_emit_envelope true "route_sync" "${summary}" "${data}" "[]" "[]"
}
