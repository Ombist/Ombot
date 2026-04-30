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
