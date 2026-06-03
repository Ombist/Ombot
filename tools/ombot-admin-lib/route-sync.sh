#!/usr/bin/env bash
# Route sync for Ombist_IOS: merge openclaw patch, optional cost config, optional auth profiles.
# Expects ombist_validate_openclaw_runtime_config / ombist_wait_gateway_loopback from openclaw-repair-route.sh.
# shellcheck shell=bash

ombist_cmd_route_sync_main() {
  local cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
  local runtime_cfg="${OPENCLAW_RUNTIME_CONFIG_PATH:-/var/lib/ombot/openclaw.json}"
  local ombot_tools_dir="${OMBOT_TOOLS_DIR:-}"
  if [[ -z "${ombot_tools_dir}" ]] && [[ -n "${LIB:-}" ]]; then
    if ombot_tools_dir="$(cd "${LIB}/../../Ombot/tools" 2>/dev/null && pwd)" && [[ -f "${ombot_tools_dir}/openclaw-merge-patch.mjs" ]]; then
      :
    elif [[ -n "${OMBOT_REPO_DIR:-}" ]] && [[ -f "${OMBOT_REPO_DIR}/tools/openclaw-merge-patch.mjs" ]]; then
      ombot_tools_dir="${OMBOT_REPO_DIR}/tools"
    else
      ombot_tools_dir=""
    fi
  fi
  local ombot_group="${OMBOT_GROUP:-ombot}"
  local ombot_user="${OMBOT_USER:-ombot}"
  local ombot_home="${OMBOT_HOME:-/home/ombot}"
  ombot_home="$(printf '%s' "${ombot_home}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -z "${ombot_home}" ]]; then
    ombot_home="/home/ombot"
  elif [[ "${ombot_home}" != /* ]]; then
    ombot_home="/${ombot_home#./}"
  fi
  local patch_b64="${SYNC_OPENCLAW_PATCH_B64:-}"
  local patch_target
  local patch_target_inferred_fragment=false
  if [[ -n "${SYNC_OPENCLAW_PATCH_TARGET:-}" ]]; then
    patch_target="${SYNC_OPENCLAW_PATCH_TARGET}"
  else
    local frag_dir_default="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}"
    if [[ -d "${frag_dir_default}" ]] && {
      [[ -f "${frag_dir_default}/10-gateway-transport.json" ]] || [[ -f "${frag_dir_default}/20-gateway-security.json" ]]
    }; then
      patch_target="fragment"
      patch_target_inferred_fragment=true
    else
      patch_target="merged"
    fi
  fi
  local cost_b64="${SYNC_COST_CONFIG_JSON_B64:-}"
  local cost_path="${SYNC_COST_CONFIG_PATH:-}"
  local auth_b64="${SYNC_OPENCLAW_AUTH_B64:-}"

  if [[ -z "${patch_b64}" && -z "${cost_b64}" && -z "${auth_b64}" ]]; then
    ombist_emit_envelope false "route_sync" "no payload provided." "{}" "[]" '[{"code":"NO_PAYLOAD","message":"missing sync payload"}]'
    return 0
  fi

  ombist_export_standard_path
  local node_bin
  node_bin="$(ombist_resolve_node_bin 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    local err
    err="$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "${ombist_NO_NODE_MSG}")")"
    ombist_emit_envelope false "route_sync" "node not found." "{}" "[]" "${err}"
    return 0
  fi

  local work="/tmp/ombist-route-sync-$$"
  local patch_path="${work}/patch.json"
  local merge_js="${work}/merge-openclaw.cjs"
  local merge_out="${work}/merged-openclaw.json"
  local auth_path="${work}/auth.json"
  local auth_js="${work}/merge-auth.cjs"
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
  local gateway_listening=false
  local gw_port="${OPENCLAW_GATEWAY_PORT:-18789}"

  if [[ -n "${patch_b64}" ]]; then
    did_patch=true
    # Prefer runtime JSON as merge base when present (Gateway reads OPENCLAW_RUNTIME_CONFIG_PATH); else /etc copy.
    local merge_source="${cfg}"
    if [[ -f "${runtime_cfg}" ]]; then
      merge_source="${runtime_cfg}"
    fi
    if ! printf '%s' "${patch_b64}" | base64 -d > "${patch_path}" 2>/dev/null; then
      ombist_emit_envelope false "route_sync" "invalid patch payload." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid patch payload base64"}]'
      return 0
    fi

    local merge_err_file="${work}/merge.err"
    if [[ "${patch_target}" == "fragment" ]]; then
      if [[ -z "${ombot_tools_dir}" ]] || [[ ! -f "${ombot_tools_dir}/openclaw-merge-route-fragment.mjs" ]] || [[ ! -f "${ombot_tools_dir}/openclaw-compose.mjs" ]]; then
        ombist_emit_envelope false "route_sync" "Ombot tools dir missing compose scripts." "{}" "[]" '[{"code":"MERGE_FAILED","message":"OPENCLAW fragment mode requires Ombot tools (set OMBOT_TOOLS_DIR or install Ombot under /opt/ombot/Ombot)"}]'
        return 0
      fi
      local frag_dir="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}"
      local frag_40="${frag_dir}/40-route-sync-patch.json"
      local merged_frag="${work}/merged-40-route-sync.json"
      if ! ombist_as_root mkdir -p "${frag_dir}"; then
        ombist_emit_envelope false "route_sync" "failed to create fragments dir." "{}" "[]" '[{"code":"NO_SUDO","message":"passwordless sudo or root required"}]'
        return 0
      fi
      if ! ombist_as_root env OMBOT_REPO_DIR="${OMBOT_REPO_DIR:-}" "${node_bin}" "${ombot_tools_dir}/openclaw-merge-route-fragment.mjs" "${frag_40}" "${patch_path}" "${merged_frag}" >/dev/null 2>"${merge_err_file}"; then
        local merge_err merge_err_json
        merge_err="$(tr '\n' ' ' < "${merge_err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
        merge_err_json="$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${merge_err:-fragment merge failed}")")"
        ombist_emit_envelope false "route_sync" "openclaw fragment merge failed." "{}" "[]" "${merge_err_json}"
        return 0
      fi
      if ! ombist_validate_openclaw_runtime_config "${merged_frag}" "${ombot_tools_dir}" "${node_bin}"; then
        ombist_emit_envelope false "route_sync" "invalid openclaw patch before fragment write." "{}" "[]" '[{"code":"MERGE_FAILED","message":"route patch models shape invalid (blockrun or nested models); fix iOS patch or OMB template"}]'
        return 0
      fi
      if ! ombist_as_root cp "${merged_frag}" "${frag_40}"; then
        ombist_emit_envelope false "route_sync" "fragment write failed." "{}" "[]" '[{"code":"MERGE_FAILED","message":"failed to write 40-route-sync-patch.json"}]'
        return 0
      fi
      ombist_as_root chown "root:${ombot_group}" "${frag_40}" 2>/dev/null || ombist_as_root chown root:root "${frag_40}" 2>/dev/null || true
      ombist_as_root chmod 640 "${frag_40}" 2>/dev/null || true
      if ! ombist_as_root env OPENCLAW_FRAGMENTS_DIR="${frag_dir}" OPENCLAW_RUNTIME_CONFIG_PATH="${runtime_cfg}" OPENCLAW_CONFIG_PATH="${cfg}" OPENCLAW_COMPOSE_USE_FLOCK=0 "${node_bin}" "${ombot_tools_dir}/openclaw-compose.mjs" >/dev/null 2>"${merge_err_file}"; then
        local merge_err merge_err_json
        merge_err="$(tr '\n' ' ' < "${merge_err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
        merge_err_json="$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${merge_err:-compose failed}")")"
        ombist_emit_envelope false "route_sync" "openclaw compose failed." "{}" "[]" "${merge_err_json}"
        return 0
      fi
      ombist_as_root chown "${ombot_user}:${ombot_group}" "${runtime_cfg}" 2>/dev/null || ombist_as_root chown "ombot:${ombot_group}" "${runtime_cfg}" 2>/dev/null || true
      ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || ombist_as_root chown root:root "${cfg}" 2>/dev/null || true
      ombist_as_root chmod 640 "${runtime_cfg}" "${cfg}" 2>/dev/null || true
      ombist_repair_openclaw_json_paths "${ombot_tools_dir}" "${node_bin}" "${runtime_cfg}" "${cfg}" "${frag_40}"
      if ! ombist_validate_openclaw_runtime_config "${runtime_cfg}" "${ombot_tools_dir}" "${node_bin}"; then
        ombist_emit_envelope false "route_sync" "invalid openclaw models shape after compose." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid openclaw models after compose; run ombot-admin openclaw config repair-route"}]'
        return 0
      fi
    else
      if [[ -z "${ombot_tools_dir}" ]] || [[ ! -f "${ombot_tools_dir}/openclaw-merge-patch.mjs" ]]; then
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
        if ! OMB_CFG="${merge_source}" OMB_PATCH="${patch_path}" OMB_OUT="${merge_out}" "${node_bin}" "${merge_js}" >/dev/null 2>"${merge_err_file}"; then
          local merge_err merge_err_json
          merge_err="$(tr '\n' ' ' < "${merge_err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
          if [[ -z "${merge_err}" ]]; then
            merge_err="openclaw patch merge failed"
          fi
          merge_err_json="$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${merge_err}")")"
          ombist_emit_envelope false "route_sync" "openclaw merge failed." "{}" "[]" "${merge_err_json}"
          return 0
        fi
      else
        if ! "${node_bin}" "${ombot_tools_dir}/openclaw-merge-patch.mjs" "${merge_source}" "${patch_path}" "${merge_out}" >/dev/null 2>"${merge_err_file}"; then
          local merge_err merge_err_json
          merge_err="$(tr '\n' ' ' < "${merge_err_file}" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
          if [[ -z "${merge_err}" ]]; then
            merge_err="openclaw patch merge failed"
          fi
          merge_err_json="$(printf '[{"code":"MERGE_FAILED","message":%s}]' "$(ombist_json_escape_string "${merge_err}")")"
          ombist_emit_envelope false "route_sync" "openclaw merge failed." "{}" "[]" "${merge_err_json}"
          return 0
        fi
      fi
      if ! ombist_as_root cp "${merge_out}" "${cfg}"; then
        local err_no_sudo
        err_no_sudo="$(printf '[{"code":"NO_SUDO","message":%s}]' "$(ombist_json_escape_string "passwordless sudo or root required")")"
        ombist_emit_envelope false "route_sync" "need root or passwordless sudo." "{}" "[]" "${err_no_sudo}"
        return 0
      fi
      ombist_as_root chown "root:${ombot_group}" "${cfg}" 2>/dev/null || ombist_as_root chown root:root "${cfg}" 2>/dev/null || true
      ombist_as_root chmod 640 "${cfg}" 2>/dev/null || true
      if [[ -n "${runtime_cfg}" && "${cfg}" != "${runtime_cfg}" ]]; then
        if ! ombist_as_root mkdir -p "$(dirname "${runtime_cfg}")"; then
          :
        elif ! ombist_as_root cp "${merge_out}" "${runtime_cfg}"; then
          :
        else
          ombist_as_root chown "${ombot_user}:${ombot_group}" "${runtime_cfg}" 2>/dev/null || true
          ombist_as_root chmod 640 "${runtime_cfg}" 2>/dev/null || true
        fi
      fi
      if [[ -n "${ombot_tools_dir}" ]] && [[ -f "${ombot_tools_dir}/openclaw-validate-runtime-config.mjs" ]]; then
        if ! ombist_validate_openclaw_runtime_config "${merge_out}" "${ombot_tools_dir}" "${node_bin}"; then
          ombist_emit_envelope false "route_sync" "invalid openclaw patch before merge write." "{}" "[]" '[{"code":"MERGE_FAILED","message":"merged patch models shape invalid"}]'
          return 0
        fi
      fi
      ombist_repair_openclaw_json_paths "${ombot_tools_dir}" "${node_bin}" "${runtime_cfg}" "${cfg}"
      if [[ -f "${runtime_cfg}" ]] && [[ -n "${ombot_tools_dir}" ]] && [[ -f "${ombot_tools_dir}/openclaw-validate-runtime-config.mjs" ]]; then
        if ! ombist_validate_openclaw_runtime_config "${runtime_cfg}" "${ombot_tools_dir}" "${node_bin}"; then
          ombist_emit_envelope false "route_sync" "invalid openclaw models shape after merge." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid openclaw models after merge"}]'
          return 0
        fi
      elif [[ -f "${cfg}" ]] && [[ -n "${ombot_tools_dir}" ]] && [[ -f "${ombot_tools_dir}/openclaw-validate-runtime-config.mjs" ]]; then
        if ! ombist_validate_openclaw_runtime_config "${cfg}" "${ombot_tools_dir}" "${node_bin}"; then
          ombist_emit_envelope false "route_sync" "invalid openclaw models shape after merge." "{}" "[]" '[{"code":"MERGE_FAILED","message":"invalid openclaw.json after merge"}]'
          return 0
        fi
      fi
    fi
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
function isHttpUrl(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  try {
    return Boolean(new URL(t).hostname);
  } catch (e) {
    return false;
  }
}
const rejectedUrlKeys = [];
for (const [agentId, providerKeys] of Object.entries(agents)) {
  if (!providerKeys || typeof providerKeys !== 'object') continue;
  for (const [prov, key] of Object.entries(providerKeys)) {
    if (typeof key === 'string' && isHttpUrl(key)) {
      rejectedUrlKeys.push(String(agentId) + '/' + String(prov || '').trim());
    }
  }
}
if (rejectedUrlKeys.length > 0) {
  console.error('AUTH_KEY_IS_URL:' + rejectedUrlKeys.join(','));
  process.exit(3);
}
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
    const trimmedKey = String(key).trim();
    const provider = String(prov).trim();
    const profileKey = provider + ':' + suffix;
    store.profiles[profileKey] = { type: 'api_key', provider, key: trimmedKey };
  }
  fs.writeFileSync(authPath, JSON.stringify(store, null, 2) + '\n');
}
for (const [agentId, providerKeys] of Object.entries(agents)) {
  mergeAuthForAgent(agentId, providerKeys);
}
NODE

    local auth_rc=0
    local auth_out=""
    if command -v sudo >/dev/null 2>&1 && sudo -n -u ombot true >/dev/null 2>&1; then
      auth_out="$(sudo -n -u ombot env HOME="${ombot_home}" OMBOT_HOME="${ombot_home}" OMB_AUTH_PAYLOAD="${auth_path}" PATH="${PATH}" "${node_bin}" "${auth_js}" 2>&1)" || auth_rc=$?
    elif [[ "$(id -u)" -eq 0 ]]; then
      auth_out="$(HOME="${ombot_home}" OMBOT_HOME="${ombot_home}" OMB_AUTH_PAYLOAD="${auth_path}" "${node_bin}" "${auth_js}" 2>&1)" || auth_rc=$?
      # Root fallback can create root-owned agent directories; restore ownership for runtime writes.
      ombist_as_root chown -R "ombot:${ombot_group}" "${ombot_home}/.openclaw/agents" >/dev/null 2>&1 || true
    else
      local err_no_sudo
      err_no_sudo="$(printf '[{"code":"NO_SUDO","message":%s}]' "$(ombist_json_escape_string "sudo -n -u ombot required for auth profile sync")")"
      ombist_emit_envelope false "route_sync" "need root or passwordless sudo." "{}" "[]" "${err_no_sudo}"
      return 0
    fi
    if [[ "${auth_rc}" -eq 3 ]] || [[ "${auth_out}" == *AUTH_KEY_IS_URL:* ]]; then
      ombist_emit_envelope false "route_sync" "auth profile key looks like URL." "{}" "[]" '[{"code":"AUTH_KEY_IS_URL","message":"auth-profiles key must be API secret, not base URL; put endpoint in API base URL field"}]'
      return 0
    fi
    if [[ "${auth_rc}" -ne 0 ]]; then
      ombist_emit_envelope false "route_sync" "auth profile merge failed." "{}" "[]" '[{"code":"AUTH_SYNC_FAILED","message":"failed to merge auth profiles"}]'
      return 0
    fi
  fi

  if [[ "${did_patch}" == "true" || "${did_cost}" == "true" || "${did_auth}" == "true" ]]; then
    local gw_unit
    gw_unit="$(ombist_gateway_pick_unit "ombist-openclaw-gateway.service" "openclaw-gateway@Ombist_IOS.service")"
    if [[ "${did_patch}" == "true" ]]; then
      if ombist_as_root systemctl restart "${gw_unit}" 2>/dev/null; then
        gw_restart="restarted"
      elif [[ -n "${gw_unit}" ]]; then
        gw_restart="restart_failed"
      fi
      if ombist_wait_gateway_loopback "${gw_port}" 60; then
        gateway_listening=true
      elif [[ "${gw_restart}" == "restarted" ]]; then
        gw_restart="not_listening"
      fi
    fi
  fi

  local data summary inferred_json sync_ok=true
  if [[ "${patch_target_inferred_fragment}" == "true" ]]; then
    inferred_json="true"
  else
    inferred_json="false"
  fi
  if [[ "${did_patch}" == "true" && "${gateway_listening}" != "true" ]]; then
    sync_ok=false
  fi
  data="$(printf '{"didPatch":%s,"didCostConfig":%s,"didAuthSync":%s,"costConfigPath":%s,"gatewayRestart":%s,"gatewayListening":%s,"gatewayPort":%s,"openclawPatchTarget":%s,"openclawPatchTargetInferredFragment":%s}' \
    "${did_patch}" \
    "${did_cost}" \
    "${did_auth}" \
    "$(ombist_json_escape_string "${cost_path}")" \
    "$(ombist_json_escape_string "${gw_restart}")" \
    "${gateway_listening}" \
    "$(ombist_json_escape_string "${gw_port}")" \
    "$(ombist_json_escape_string "${patch_target}")" \
    "${inferred_json}")"
  summary="ombist_route_sync_ok; gateway=${gw_restart}; listening=${gateway_listening}"
  if [[ "${sync_ok}" == "true" ]]; then
    ombist_emit_envelope true "route_sync" "${summary}" "${data}" "[]" "[]"
  else
    ombist_emit_envelope false "route_sync" "${summary}" "${data}" "[]" '[{"code":"GATEWAY_NOT_READY","message":"openclaw patch applied but gateway port not listening"}]'
  fi
}
