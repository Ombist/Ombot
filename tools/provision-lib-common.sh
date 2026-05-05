#!/usr/bin/env bash

ombist_detect_pkg_family() {
  if command -v apt-get >/dev/null 2>&1; then
    printf 'deb'
    return 0
  fi
  if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    printf 'rpm'
    return 0
  fi
  printf 'unknown'
}

ombist_detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    printf 'apt'
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    printf 'dnf'
    return 0
  fi
  if command -v yum >/dev/null 2>&1; then
    printf 'yum'
    return 0
  fi
  printf 'unknown'
}

ombist_require_pkg_family() {
  local expected="${1:-unknown}"
  local actual
  actual="$(ombist_detect_pkg_family)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ombist-provision: package family mismatch (expected=${expected}, actual=${actual})" >&2
    exit 12
  fi
}

ombist_require_pkg_manager() {
  local expected="${1:-unknown}"
  local actual
  actual="$(ombist_detect_pkg_manager)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ombist-provision: package manager mismatch (expected=${expected}, actual=${actual})" >&2
    exit 13
  fi
}

# Wait until dpkg/apt lock files are not in use (e.g. unattended-upgrades, another SSH apt).
# Env: OMBIST_APT_LOCK_WAIT_SEC (default 600), OMBIST_APT_LOCK_POLL_SEC (default 3).
# If fuser(1) is missing, returns success immediately (caller should still retry apt on lock errors).
ombist_wait_for_apt_lock() {
  if [[ "$(ombist_detect_pkg_manager 2>/dev/null || printf '')" != "apt" ]]; then
    return 0
  fi
  if ! command -v fuser >/dev/null 2>&1; then
    return 0
  fi
  local max_wait="${OMBIST_APT_LOCK_WAIT_SEC:-600}"
  local poll="${OMBIST_APT_LOCK_POLL_SEC:-3}"
  local waited=0
  local locks=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock)
  local path busy
  while true; do
    busy=0
    for path in "${locks[@]}"; do
      [[ -e "${path}" ]] || continue
      if fuser -s "${path}" 2>/dev/null; then
        busy=1
        break
      fi
    done
    if [[ "${busy}" -eq 0 ]]; then
      return 0
    fi
    if [[ "${waited}" -ge "${max_wait}" ]]; then
      echo "ombist-provision: timed out after ${max_wait}s waiting for dpkg/apt lock" >&2
      return 1
    fi
    echo "ombist-provision: dpkg/apt lock held, waiting (${waited}s / ${max_wait}s)..." >&2
    sleep "${poll}"
    waited=$((waited + poll))
  done
}
