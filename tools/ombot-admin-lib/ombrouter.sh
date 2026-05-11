#!/usr/bin/env bash
# Clone/build OmbRouter without OpenClaw plugin registration (runs as SSH user, not ombot).
# shellcheck shell=bash

ombist_cmd_ombrouter_install_main() {
  set +e
  local pinned_ref="${1:-}"
  local GIT_URL="https://github.com/Ombist/OmbRouter.git"
  local SRC_DIR="${HOME}/.ombist/src/OmbRouter"
  local summary="ombist_ombrouter_install_ok"
  local err_json="[]"

  if ! command -v git >/dev/null 2>&1; then
    err_json="$(printf '[{"code":"NO_GIT","message":%s}]' "$(ombist_json_escape_string "git not found")")"
    ombist_emit_envelope false "ombrouter_install" "git not found." "{}" "[]" "${err_json}"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    err_json="$(printf '[{"code":"NO_NPM","message":%s}]' "$(ombist_json_escape_string "npm not found")")"
    ombist_emit_envelope false "ombrouter_install" "npm not found." "{}" "[]" "${err_json}"
    return 0
  fi

  if ! mkdir -p "$(dirname "${SRC_DIR}")"; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to create source parent directory")")"
    ombist_emit_envelope false "ombrouter_install" "failed to prepare source directory." "{}" "[]" "${err_json}"
    return 0
  fi
  if [[ -d "${SRC_DIR}/.git" ]]; then
    if ! cd "${SRC_DIR}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter source directory")")"
      ombist_emit_envelope false "ombrouter_install" "failed to enter source directory." "{}" "[]" "${err_json}"
      return 0
    fi
    if ! git pull --ff-only 2>/dev/null; then
      if ! cd "${HOME}"; then
        err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to return to home directory")")"
        ombist_emit_envelope false "ombrouter_install" "failed to reset source directory." "{}" "[]" "${err_json}"
        return 0
      fi
      rm -rf "${SRC_DIR}"
      if ! git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"; then
        err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "git clone failed after pull fallback")")"
        ombist_emit_envelope false "ombrouter_install" "git clone failed." "{}" "[]" "${err_json}"
        return 0
      fi
      if ! cd "${SRC_DIR}"; then
        err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter cloned source directory")")"
        ombist_emit_envelope false "ombrouter_install" "failed to enter source directory." "{}" "[]" "${err_json}"
        return 0
      fi
    fi
  else
    rm -rf "${SRC_DIR}"
    if ! git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "git clone failed")")"
      ombist_emit_envelope false "ombrouter_install" "git clone failed." "{}" "[]" "${err_json}"
      return 0
    fi
    if ! cd "${SRC_DIR}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter cloned source directory")")"
      ombist_emit_envelope false "ombrouter_install" "failed to enter source directory." "{}" "[]" "${err_json}"
      return 0
    fi
  fi

  if [[ -n "${pinned_ref}" ]]; then
    git fetch origin "${pinned_ref}" 2>/dev/null || true
    git checkout --detach "${pinned_ref}" 2>/dev/null || git checkout "${pinned_ref}" 2>/dev/null || true
  fi

  if ! npm install; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm install failed")")"
    ombist_emit_envelope false "ombrouter_install" "npm install failed." "{}" "[]" "${err_json}"
    return 0
  fi
  if ! npm run build; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm run build failed")")"
    ombist_emit_envelope false "ombrouter_install" "npm run build failed." "{}" "[]" "${err_json}"
    return 0
  fi
  if ! npm install -g .; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm install -g failed")")"
    ombist_emit_envelope false "ombrouter_install" "npm install -g failed." "{}" "[]" "${err_json}"
    return 0
  fi
  # Intentionally skip `openclaw plugins install` for OmbRouter.
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    if sudo -n systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
      sudo -n systemctl restart ombist-openclaw-gateway.service || true
    fi
  fi

  local data
  data="$(printf '{"ombrouter":{"okMarker":"ombist_ombrouter_install_ok","sourceDir":%s}}' "$(ombist_json_escape_string "${SRC_DIR}")")"
  ombist_emit_envelope true "ombrouter_install" "${summary}" "${data}" "[]" "[]"
}
