#!/usr/bin/env bash
# systemd monitor JSON for single-bot units.
# shellcheck shell=bash

ombist_cmd_systemctl_monitor_main() {
  if ! command -v systemctl >/dev/null 2>&1; then
    local data='{"monitor":{"error":"NO_SYSTEMCTL","services":[]}}'
    ombist_emit_envelope false "systemctl_monitor" "systemctl not installed." "${data}" "[]" '[{"code":"NO_SYSTEMCTL","message":"systemctl not found"}]'
    return 0
  fi

  local SYS=""
  if [ "$(id -u)" -eq 0 ]; then
    SYS=""
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SYS="sudo -n"
  else
    local data='{"monitor":{"error":"NO_SUDO","services":[]}}'
    ombist_emit_envelope false "systemctl_monitor" "No passwordless sudo for systemctl." "${data}" "[]" '[{"code":"NO_SUDO","message":"sudo -n required"}]'
    return 0
  fi

  svc_json() {
    local u="$1"
    local a s sb64
    if [ -n "$SYS" ]; then
      a="$($SYS systemctl --no-pager is-active "$u" 2>/dev/null || true)"
      s="$($SYS systemctl --no-pager status --lines=20 "$u" 2>&1 || true)"
    else
      a="$(systemctl --no-pager is-active "$u" 2>/dev/null || true)"
      s="$(systemctl --no-pager status --lines=20 "$u" 2>&1 || true)"
    fi
    [ -n "$a" ] || a="unknown"
    sb64="$(printf '%s' "$s" | base64 | tr -d '\n')"
    printf '{"unit":"%s","activeState":"%s","statusB64":"%s","error":null}' "$u" "$a" "$sb64"
  }

  # Ombist_IOS provision always writes:
  #   /etc/systemd/system/ombist-ombot.service
  #   /etc/systemd/system/ombist-openclaw-gateway.service
  # Prefer that path first so we never fall back to README `ombot.service` when the real unit
  # exists (some hosts: `systemctl cat` / DBus quirks; or ombot-admin-lib not yet updated from git).
  ombist_unit_file_on_disk() {
    local u="$1"
    local f="/etc/systemd/system/${u}"
    if [ -n "$SYS" ]; then
      $SYS test -f "$f" 2>/dev/null
    else
      test -f "$f" 2>/dev/null
    fi
  }

  # README/manual path uses legacy names; `systemctl cat` asks systemd if a unit is known.
  unit_resolvable() {
    local u="$1"
    if [ -n "$SYS" ]; then
      $SYS systemctl --no-pager cat "$u" >/dev/null 2>&1
    else
      systemctl --no-pager cat "$u" >/dev/null 2>&1
    fi
  }

  use_ombist_ombot_unit() {
    ombist_unit_file_on_disk "ombist-ombot.service" || unit_resolvable "ombist-ombot.service"
  }

  use_ombist_gateway_unit() {
    ombist_unit_file_on_disk "ombist-openclaw-gateway.service" || unit_resolvable "ombist-openclaw-gateway.service"
  }

  local OMBOT_UNIT="ombot.service"
  local GW_UNIT="openclaw-gateway@Ombist_IOS.service"
  if use_ombist_ombot_unit; then
    OMBOT_UNIT="ombist-ombot.service"
  fi
  if use_ombist_gateway_unit; then
    GW_UNIT="ombist-openclaw-gateway.service"
  fi

  local inner
  inner="$(printf '{"error":null,"services":[%s,%s]}' "$(svc_json "$OMBOT_UNIT")" "$(svc_json "$GW_UNIT")")"
  local data
  data="$(printf '{"monitor":%s}' "${inner}")"
  ombist_emit_envelope true "systemctl_monitor" "systemd status collected." "${data}" "[]" "[]"
}
