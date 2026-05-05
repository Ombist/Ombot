#!/usr/bin/env bash
# Remote capability probe (Linux). Prints ombot-admin JSON envelope.
# shellcheck shell=bash

ombist_cmd_preflight_main() {
  # shellcheck disable=SC1091
  set +e
  OS_UNAME="$(uname -s 2>/dev/null || echo unknown)"
  OS_ID="unknown"
  if [ "$OS_UNAME" = "Linux" ] && [ -r /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    OS_ID="${ID:-unknown}"
  fi
  if command -v apt-get >/dev/null 2>&1; then PKG_MGR="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG_MGR="dnf"
  elif command -v yum >/dev/null 2>&1; then PKG_MGR="yum"
  elif command -v brew >/dev/null 2>&1; then PKG_MGR="brew"
  else PKG_MGR="unknown"
  fi
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then IS_ROOT=1; else IS_ROOT=0; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO_NOPASSWD=1; else SUDO_NOPASSWD=0; fi
  if command -v bash >/dev/null 2>&1; then HAS_BASH=1; else HAS_BASH=0; fi
  if command -v git >/dev/null 2>&1; then HAS_GIT=1; else HAS_GIT=0; fi
  if command -v curl >/dev/null 2>&1; then HAS_CURL=1; else HAS_CURL=0; fi
  if command -v wget >/dev/null 2>&1; then HAS_WGET=1; else HAS_WGET=0; fi
  if command -v node >/dev/null 2>&1; then HAS_NODE=1; else HAS_NODE=0; fi
  if command -v npm >/dev/null 2>&1; then HAS_NPM=1; else HAS_NPM=0; fi
  if command -v systemctl >/dev/null 2>&1; then HAS_SYSTEMCTL=1; else HAS_SYSTEMCTL=0; fi
  if command -v openssl >/dev/null 2>&1; then HAS_OPENSSL=1; else HAS_OPENSSL=0; fi
  GITHUB_OK=-1
  NPM_REGISTRY_OK=-1
  if command -v curl >/dev/null 2>&1; then
    curl -fsSI --max-time 6 https://github.com >/dev/null 2>&1 && GITHUB_OK=1 || GITHUB_OK=0
    curl -fsSI --max-time 6 https://registry.npmjs.org >/dev/null 2>&1 && NPM_REGISTRY_OK=1 || NPM_REGISTRY_OK=0
  elif command -v wget >/dev/null 2>&1; then
    wget -q --spider --timeout=6 https://github.com >/dev/null 2>&1 && GITHUB_OK=1 || GITHUB_OK=0
    wget -q --spider --timeout=6 https://registry.npmjs.org >/dev/null 2>&1 && NPM_REGISTRY_OK=1 || NPM_REGISTRY_OK=0
  fi

  local data
  data=$(printf '{"profile":{"OS_UNAME":%s,"OS_ID":%s,"PKG_MGR":%s,"IS_ROOT":"%s","SUDO_NOPASSWD":"%s","HAS_BASH":"%s","HAS_GIT":"%s","HAS_CURL":"%s","HAS_WGET":"%s","HAS_NODE":"%s","HAS_NPM":"%s","HAS_SYSTEMCTL":"%s","HAS_OPENSSL":"%s","GITHUB_OK":"%s","NPM_REGISTRY_OK":"%s"}}' \
    "$(ombist_json_escape_string "${OS_UNAME}")" \
    "$(ombist_json_escape_string "${OS_ID}")" \
    "$(ombist_json_escape_string "${PKG_MGR}")" \
    "${IS_ROOT}" \
    "${SUDO_NOPASSWD}" \
    "${HAS_BASH}" \
    "${HAS_GIT}" \
    "${HAS_CURL}" \
    "${HAS_WGET}" \
    "${HAS_NODE}" \
    "${HAS_NPM}" \
    "${HAS_SYSTEMCTL}" \
    "${HAS_OPENSSL}" \
    "${GITHUB_OK}" \
    "${NPM_REGISTRY_OK}")

  ombist_emit_envelope true "preflight" "SSH environment probe complete." "${data}" "[]" "[]"
}
