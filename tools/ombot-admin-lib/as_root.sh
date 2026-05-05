#!/usr/bin/env bash
# Shared privilege helper for ombot-admin (sourced only).
# shellcheck shell=bash

ombist_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  else
    return 7
  fi
}
