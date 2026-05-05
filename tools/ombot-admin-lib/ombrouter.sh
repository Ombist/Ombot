#!/usr/bin/env bash
# Clone/build OmbRouter and register OpenClaw plugin (runs as SSH user, not ombot).
# shellcheck shell=bash

ombist_cmd_ombrouter_install_main() {
  set +e
  local pinned_ref="${1:-}"
  local GIT_URL="https://github.com/Ombist/OmbRouter.git"
  local SRC_DIR="${HOME}/.ombist/src/OmbRouter"

  mkdir -p "$(dirname "${SRC_DIR}")"
  if [[ -d "${SRC_DIR}/.git" ]]; then
    cd "${SRC_DIR}" || return 1
    if ! git pull --ff-only 2>/dev/null; then
      cd "${HOME}" || return 1
      rm -rf "${SRC_DIR}"
      git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"
      cd "${SRC_DIR}" || return 1
    fi
  else
    rm -rf "${SRC_DIR}"
    git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"
    cd "${SRC_DIR}" || return 1
  fi

  if [[ -n "${pinned_ref}" ]]; then
    git fetch origin "${pinned_ref}" 2>/dev/null || true
    git checkout --detach "${pinned_ref}" 2>/dev/null || git checkout "${pinned_ref}" 2>/dev/null || true
  fi

  npm install
  npm run build
  npm install -g .
  if command -v openclaw >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      timeout 300 openclaw plugins install "${SRC_DIR}" --force || timeout 300 openclaw plugins install "${SRC_DIR}" || true
    else
      openclaw plugins install "${SRC_DIR}" --force || openclaw plugins install "${SRC_DIR}" || true
    fi
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    if sudo -n systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
      sudo -n systemctl restart ombist-openclaw-gateway.service || true
    fi
  fi

  local data
  data="$(printf '{"ombrouter":{"okMarker":"ombist_ombrouter_install_ok","sourceDir":%s}}' "$(ombist_json_escape_string "${SRC_DIR}")")"
  ombist_emit_envelope true "ombrouter_install" "ombist_ombrouter_install_ok" "${data}" "[]" "[]"
}
