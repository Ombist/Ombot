#!/usr/bin/env bash
# Shared Node/npm resolution for ombot-admin (non-login SSH, headless nvm, npm-global).
# Keep in sync with OmbRouter/scripts/ombist-remote-probe.sh inline copy.
# shellcheck shell=bash

ombist_NO_NODE_MSG='node not found (checked PATH, system paths, /opt/ombot/npm-global, ombot nvm)'

ombist_export_standard_path() {
  export PATH="/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/ombot/npm-global/bin${PATH:+:$PATH}"
}

ombist_node_executable() {
  local bin="$1"
  [[ -n "${bin}" && -x "${bin}" ]] && "${bin}" -e 'process.exit(0)' >/dev/null 2>&1
}

ombist_npm_executable() {
  local bin="$1"
  [[ -n "${bin}" && -x "${bin}" ]]
}

ombist_ombot_home_default() {
  local h="${OMBOT_HOME:-/home/ombot}"
  h="$(printf '%s' "${h}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -z "${h}" ]]; then
    printf '%s' '/home/ombot'
  elif [[ "${h}" != /* ]]; then
    printf '/%s' "${h#./}"
  else
    printf '%s' "${h}"
  fi
}

ombist_resolve_node_via_nvm() {
  local ombot_home nvm_dir bin
  ombot_home="$(ombist_ombot_home_default)"
  nvm_dir="${NVM_DIR:-${ombot_home}/.nvm}"
  if [[ -s "${nvm_dir}/nvm.sh" ]]; then
    bin="$(
      bash -c '
        set +e
        export NVM_DIR="'"${nvm_dir}"'"
        # shellcheck source=/dev/null
        . "${NVM_DIR}/nvm.sh" 2>/dev/null
        nvm use 22 >/dev/null 2>&1
        command -v node 2>/dev/null
      ' 2>/dev/null | head -n1 | tr -d '\r'
    )"
    if ombist_node_executable "${bin}"; then
      printf '%s' "${bin}"
      return 0
    fi
  fi
  local glob_node
  glob_node="$(ls -1 "${nvm_dir}/versions/node/"*/bin/node 2>/dev/null | tail -n1 || true)"
  if ombist_node_executable "${glob_node}"; then
    printf '%s' "${glob_node}"
    return 0
  fi
  return 1
}

ombist_resolve_node_bin() {
  ombist_export_standard_path
  local cand bin
  for cand in node nodejs; do
    bin="$(command -v "${cand}" 2>/dev/null || true)"
    if ombist_node_executable "${bin}"; then
      printf '%s' "${bin}"
      return 0
    fi
  done
  for cand in \
    /snap/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /usr/bin/nodejs \
    /opt/ombot/npm-global/bin/node; do
    if ombist_node_executable "${cand}"; then
      printf '%s' "${cand}"
      return 0
    fi
  done
  if bin="$(ombist_resolve_node_via_nvm)" && [[ -n "${bin}" ]]; then
    printf '%s' "${bin}"
    return 0
  fi
  return 1
}

ombist_has_node() {
  ombist_resolve_node_bin >/dev/null 2>&1
}

ombist_resolve_npm_via_nvm() {
  local ombot_home nvm_dir bin
  ombot_home="$(ombist_ombot_home_default)"
  nvm_dir="${NVM_DIR:-${ombot_home}/.nvm}"
  if [[ -s "${nvm_dir}/nvm.sh" ]]; then
    bin="$(
      bash -c '
        set +e
        export NVM_DIR="'"${nvm_dir}"'"
        # shellcheck source=/dev/null
        . "${NVM_DIR}/nvm.sh" 2>/dev/null
        nvm use 22 >/dev/null 2>&1
        command -v npm 2>/dev/null
      ' 2>/dev/null | head -n1 | tr -d '\r'
    )"
    if ombist_npm_executable "${bin}"; then
      printf '%s' "${bin}"
      return 0
    fi
  fi
  local glob_npm
  glob_npm="$(ls -1 "${nvm_dir}/versions/node/"*/bin/npm 2>/dev/null | tail -n1 || true)"
  if ombist_npm_executable "${glob_npm}"; then
    printf '%s' "${glob_npm}"
    return 0
  fi
  return 1
}

ombist_resolve_npm_bin() {
  ombist_export_standard_path
  local cand bin
  if bin="$(command -v npm 2>/dev/null || true)" && ombist_npm_executable "${bin}"; then
    printf '%s' "${bin}"
    return 0
  fi
  for cand in \
    /snap/bin/npm \
    /usr/local/bin/npm \
    /usr/bin/npm \
    /opt/ombot/npm-global/bin/npm; do
    if ombist_npm_executable "${cand}"; then
      printf '%s' "${cand}"
      return 0
    fi
  done
  if bin="$(ombist_resolve_npm_via_nvm)" && [[ -n "${bin}" ]]; then
    printf '%s' "${bin}"
    return 0
  fi
  return 1
}

ombist_has_npm() {
  ombist_resolve_npm_bin >/dev/null 2>&1
}
