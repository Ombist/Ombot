#!/usr/bin/env bash
# Lock Ombot health port to localhost + tailnet (ufw / iptables / nft).
# shellcheck shell=bash

ombist_cmd_health_port_ensure_main() {
  local PORT=""
  local raw="${OMBIST_HP:-}"
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
  if [ -n "$raw" ] && [ "$raw" -ge 1 ] 2>/dev/null && [ "$raw" -le 65535 ] 2>/dev/null; then
    PORT="$raw"
  fi
  if [ -z "$PORT" ] && [ -r /etc/ombot/ombot.env ]; then
    local hp
    hp="$(grep -E '^[[:space:]]*HEALTH_PORT=' /etc/ombot/ombot.env 2>/dev/null | tail -n1 | sed 's/^[[:space:]]*//' | sed 's/^HEALTH_PORT=//')"
    hp="$(printf '%s' "$hp" | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
    if [ -n "$hp" ] && [ "$hp" -ge 1 ] 2>/dev/null && [ "$hp" -le 65535 ] 2>/dev/null; then
      PORT="$hp"
    fi
  fi
  if [ -z "$PORT" ]; then
    PORT="8082"
  fi
  local TAILNET4=100.64.0.0/10
  local TAILNET6=fd7a:115c:a1e0::/48
  local warn_ip6=0
  local legacy_tag=""
  local mode=""

  if ! ombist_as_root test -d / 2>/dev/null; then
    ombist_emit_envelope false "health_port_ensure" "No passwordless sudo." \
      "$(printf '{"healthPort":{"port":%s,"legacySummaryTag":%s,"mode":%s}}' "${PORT}" "$(ombist_json_escape_string "OMBIST_9090_ENSURE_ERR_NO_SUDO")" "$(ombist_json_escape_string "")")" \
      "[]" '[{"code":"NO_SUDO","message":"passwordless sudo required"}]'
    return 0
  fi

  if command -v ufw >/dev/null 2>&1; then
    ombist_as_root ufw allow in from 127.0.0.1 to any port "${PORT}" proto tcp comment 'ombist-9090-local-v4' >/dev/null 2>&1 || true
    ombist_as_root ufw allow in from "${TAILNET4}" to any port "${PORT}" proto tcp comment 'ombist-9090-tailnet4' >/dev/null 2>&1 || true
    ombist_as_root ufw allow in from "${TAILNET6}" to any port "${PORT}" proto tcp comment 'ombist-9090-tailnet6' >/dev/null 2>&1 || true
    ombist_as_root ufw deny in to any port "${PORT}" proto tcp comment 'ombist-9090-deny-rest' >/dev/null 2>&1 || true
    legacy_tag="OMBIST_9090_ENSURE_OK:ufw"
    mode="ufw"
  elif command -v iptables >/dev/null 2>&1; then
    ombist_as_root iptables -C INPUT -p tcp --dport "${PORT}" -s 127.0.0.0/8 -j ACCEPT >/dev/null 2>&1 \
      || ombist_as_root iptables -I INPUT -p tcp --dport "${PORT}" -s 127.0.0.0/8 -j ACCEPT
    ombist_as_root iptables -C INPUT -p tcp --dport "${PORT}" -s "${TAILNET4}" -j ACCEPT >/dev/null 2>&1 \
      || ombist_as_root iptables -I INPUT -p tcp --dport "${PORT}" -s "${TAILNET4}" -j ACCEPT
    ombist_as_root iptables -C INPUT -p tcp --dport "${PORT}" -j DROP >/dev/null 2>&1 \
      || ombist_as_root iptables -A INPUT -p tcp --dport "${PORT}" -j DROP

    if command -v ip6tables >/dev/null 2>&1; then
      ombist_as_root ip6tables -C INPUT -p tcp --dport "${PORT}" -s ::1/128 -j ACCEPT >/dev/null 2>&1 \
        || ombist_as_root ip6tables -I INPUT -p tcp --dport "${PORT}" -s ::1/128 -j ACCEPT
      ombist_as_root ip6tables -C INPUT -p tcp --dport "${PORT}" -s "${TAILNET6}" -j ACCEPT >/dev/null 2>&1 \
        || ombist_as_root ip6tables -I INPUT -p tcp --dport "${PORT}" -s "${TAILNET6}" -j ACCEPT
      ombist_as_root ip6tables -C INPUT -p tcp --dport "${PORT}" -j DROP >/dev/null 2>&1 \
        || ombist_as_root ip6tables -A INPUT -p tcp --dport "${PORT}" -j DROP
    else
      warn_ip6=1
    fi
    legacy_tag="OMBIST_9090_ENSURE_OK:iptables"
    mode="iptables"
  elif command -v nft >/dev/null 2>&1; then
    ombist_as_root nft add table inet ombist_9090 >/dev/null 2>&1 || true
    ombist_as_root nft add chain inet ombist_9090 input "{ type filter hook input priority -5; policy accept; }" >/dev/null 2>&1 || true
    ombist_as_root nft flush chain inet ombist_9090 input
    ombist_as_root nft add rule inet ombist_9090 input ip protocol tcp ip saddr 127.0.0.0/8 tcp dport "${PORT}" accept
    ombist_as_root nft add rule inet ombist_9090 input ip protocol tcp ip saddr "${TAILNET4}" tcp dport "${PORT}" accept
    ombist_as_root nft add rule inet ombist_9090 input ip6 nexthdr tcp ip6 saddr ::1/128 tcp dport "${PORT}" accept
    ombist_as_root nft add rule inet ombist_9090 input ip6 nexthdr tcp ip6 saddr "${TAILNET6}" tcp dport "${PORT}" accept
    ombist_as_root nft add rule inet ombist_9090 input tcp dport "${PORT}" drop
    legacy_tag="OMBIST_9090_ENSURE_OK:nft"
    mode="nft"
  else
    ombist_emit_envelope false "health_port_ensure" "No firewall tool." \
      "$(printf '{"healthPort":{"port":%s,"legacySummaryTag":%s,"mode":%s}}' "${PORT}" "$(ombist_json_escape_string "OMBIST_9090_ENSURE_ERR_NO_FIREWALL_TOOL")" "$(ombist_json_escape_string "")")" \
      "[]" '[{"code":"NO_FIREWALL_TOOL","message":"ufw/iptables/nft not found"}]'
    return 0
  fi

  local warnings="[]"
  if [ "$warn_ip6" -eq 1 ]; then
    legacy_tag="${legacy_tag}"$'\n'"OMBIST_9090_ENSURE_WARN_NO_IP6TABLES"
    warnings='[{"code":"NO_IP6TABLES","message":"ip6tables not available"}]'
  fi

  local data
  data="$(printf '{"healthPort":{"port":%s,"legacySummaryTag":%s,"mode":%s,"warnNoIp6tables":%s}}' \
    "${PORT}" "$(ombist_json_escape_string "${legacy_tag}")" "$(ombist_json_escape_string "${mode}")" \
    "$( [ "$warn_ip6" -eq 1 ] && echo true || echo false)")"

  ombist_emit_envelope true "health_port_ensure" "${legacy_tag}" "${data}" "${warnings}" "[]"
}
