#!/usr/bin/env bash
# Install / refresh ombot-admin CLI from OMBOT_REPO_DIR (no full reprovision).
# shellcheck shell=bash

ombist_cmd_tools_install_main() {
  local repo="${OMBOT_REPO_DIR:-/opt/ombot/Ombot}"
  local bin_dir="${OMBOT_BIN_DIR:-/opt/ombot/bin}"
  repo="$(printf '%s' "${repo}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  bin_dir="$(printf '%s' "${bin_dir}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  if [[ ! -f "${repo}/tools/ombot-admin" ]]; then
    ombist_emit_envelope false "tools_install" "Ombot repo missing ombot-admin." "{}" "[]" '[{"code":"CLI_MISSING","message":"OMBOT_REPO_DIR must point at Ombot checkout"}]'
    return 0
  fi

  if ! ombist_as_root mkdir -p "${bin_dir}"; then
    ombist_emit_envelope false "tools_install" "need root or passwordless sudo." "{}" "[]" '[{"code":"NO_SUDO","message":"passwordless sudo or root required"}]'
    return 0
  fi

  if ! ombist_as_root install -m 0755 "${repo}/tools/ombot-admin" "${bin_dir}/ombot-admin"; then
    ombist_emit_envelope false "tools_install" "failed to install ombot-admin." "{}" "[]" '[{"code":"INTERNAL_ERROR","message":"install ombot-admin failed"}]'
    return 0
  fi
  ombist_as_root rm -rf "${bin_dir}/ombot-admin-lib"
  ombist_as_root mkdir -p "${bin_dir}/ombot-admin-lib"
  if ! ombist_as_root cp -a "${repo}/tools/ombot-admin-lib/." "${bin_dir}/ombot-admin-lib/"; then
    ombist_emit_envelope false "tools_install" "failed to copy ombot-admin-lib." "{}" "[]" '[{"code":"INTERNAL_ERROR","message":"cp ombot-admin-lib failed"}]'
    return 0
  fi
  ombist_as_root chown -R root:root "${bin_dir}/ombot-admin" "${bin_dir}/ombot-admin-lib" 2>/dev/null || true

  local data
  data="$(printf '{"binDir":%s,"repoDir":%s,"version":%s}' \
    "$(ombist_json_escape_string "${bin_dir}")" \
    "$(ombist_json_escape_string "${repo}")" \
    "$(ombist_json_escape_string "${OMBOT_ADMIN_VERSION}")")"
  ombist_emit_envelope true "tools_install" "ombot-admin installed to ${bin_dir}" "${data}" "[]" "[]"
}
