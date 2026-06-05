#!/usr/bin/env bash
# Shared Hermes Agent install helpers for Ombist provision scripts.
# Expects: as_root, run_as_ombot, OMBOT_USER, OMBOT_GROUP, OMBOT_HOME, OMBOT_DATA_DIR,
# OMBOT_BIN_DIR, OMBOT_ENV_PATH, OMBOT_REPO_DIR, INSTALL_ROOT, assert_openclaw_gateway_mode_local (optional)

HERMES_ENV_PATH="${HERMES_ENV_PATH:-/etc/ombot/hermes.env}"
HERMES_HOME="${HERMES_HOME:-${OMBOT_DATA_DIR}/hermes}"
HERMES_API_PORT="${HERMES_API_PORT:-8642}"
HERMES_API_HOST="${HERMES_API_HOST:-127.0.0.1}"
HERMES_SERVICE_PATH="/etc/systemd/system/ombist-hermes-gateway.service"
HERMES_API_SERVER_KEY="${HERMES_API_SERVER_KEY:-}"
OMBIST_GATEWAY_AGENT_ID="${OMBIST_GATEWAY_AGENT_ID:-default}"

ombist_generate_hermes_api_key() {
  if [[ -n "${HERMES_API_SERVER_KEY}" ]]; then
    return 0
  fi
  HERMES_API_SERVER_KEY="$(openssl rand -hex 32 2>/dev/null || true)"
  if [[ -z "${HERMES_API_SERVER_KEY}" ]]; then
    HERMES_API_SERVER_KEY="$(run_as_ombot "python3 -c \"import secrets; print(secrets.token_hex(32))\"" 2>/dev/null || true)"
  fi
  if [[ -z "${HERMES_API_SERVER_KEY}" ]]; then
    echo "ombist-provision-hermes: failed to generate HERMES_API_SERVER_KEY" >&2
    return 1
  fi
}

ombist_install_hermes_cli() {
  echo "ombist-provision-hermes: installing Hermes Agent for ${OMBOT_USER}..."
  as_root mkdir -p "${HERMES_HOME}"
  as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${HERMES_HOME}"
  if ! run_as_ombot "test -x '${HERMES_HOME}/.local/bin/hermes' || command -v hermes >/dev/null 2>&1"; then
    run_as_ombot "export HERMES_HOME='${HERMES_HOME}'; \
export XDG_DATA_HOME='${HERMES_HOME}/.local/share'; \
curl -fsSL 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh' | bash" || {
      echo "ombist-provision-hermes: Hermes install script failed" >&2
      return 1
    }
  fi
  run_as_ombot "export HERMES_HOME='${HERMES_HOME}'; export PATH=\"${HERMES_HOME}/.local/bin:\${HOME}/.local/bin:\${PATH}\"; command -v hermes >/dev/null" || {
    echo "ombist-provision-hermes: hermes CLI not found after install" >&2
    return 1
  }
}

ombist_write_hermes_env_file() {
  ombist_generate_hermes_api_key || return 1
  {
    echo "HERMES_HOME=${HERMES_HOME}"
    echo "API_SERVER_ENABLED=true"
    echo "API_SERVER_PORT=${HERMES_API_PORT}"
    echo "API_SERVER_HOST=${HERMES_API_HOST}"
    echo "API_SERVER_KEY=${HERMES_API_SERVER_KEY}"
    echo "API_SERVER_MODEL_NAME=hermes-agent"
  } | as_root tee "${HERMES_ENV_PATH}" >/dev/null
  as_root chown root:"${OMBOT_GROUP}" "${HERMES_ENV_PATH}"
  as_root chmod 640 "${HERMES_ENV_PATH}"
}

ombist_write_hermes_gateway_systemd() {
  local wrapper="${OMBOT_BIN_DIR}/run-hermes-gateway.sh"
  as_root tee "${wrapper}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME="${HERMES_HOME}"
export PATH="${HERMES_HOME}/.local/bin:\${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
set -a
source "${HERMES_ENV_PATH}"
set +a
cd "\${HERMES_HOME}"
exec hermes gateway
EOF
  as_root chown root:"${OMBOT_GROUP}" "${wrapper}"
  as_root chmod 750 "${wrapper}"

  as_root tee "${HERMES_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Hermes Agent gateway (API server, Ombist)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OMBOT_USER}
Group=${OMBOT_GROUP}
EnvironmentFile=${HERMES_ENV_PATH}
WorkingDirectory=${HERMES_HOME}
ExecStart=${wrapper}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=${HERMES_HOME} ${OMBOT_DATA_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
}

ombist_append_ombot_env_hermes_bridge() {
  {
    echo "HERMES_AGENT_BRIDGE=1"
    echo "HERMES_API_SERVER_URL=http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1"
    echo "HERMES_API_SERVER_KEY=${HERMES_API_SERVER_KEY}"
    echo "HERMES_BRIDGE_AGENT_ID=${OMBIST_GATEWAY_AGENT_ID}"
    echo "HERMES_BRIDGE_CONVERSATION_ID=${HERMES_BRIDGE_CONVERSATION_ID:-default}"
    echo "HERMES_BRIDGE_PARTICIPANT_ID=${HERMES_BRIDGE_PARTICIPANT_ID:-default}"
    echo "HERMES_BRIDGE_MODEL=${HERMES_BRIDGE_MODEL:-hermes-agent}"
    echo "HERMES_BRIDGE_API_MODE=${HERMES_BRIDGE_API_MODE:-responses}"
    echo "OPENCLAW_READYZ_REQUIRE_GATEWAY=0"
    echo "OPENCLAW_SELF_HEAL=0"
  } >>"${OMBOT_ENV_PATH}"
}

ombist_wait_hermes_api() {
  local ok="false"
  for _i in {1..60}; do
    if run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/health'" 2>/dev/null \
      || run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/models'" 2>/dev/null; then
      ok="true"
      break
    fi
    sleep 1
  done
  if [[ "${ok}" != "true" ]]; then
    echo "ombist-provision-hermes: Hermes API server did not become ready on ${HERMES_API_HOST}:${HERMES_API_PORT}" >&2
    return 1
  fi
}

ombist_hermes_firewall_guard() {
  local port="${HERMES_API_PORT}"
  if command -v ufw >/dev/null 2>&1; then
    as_root ufw deny in proto tcp to any port "${port}" >/dev/null 2>&1 || true
  elif command -v iptables >/dev/null 2>&1; then
    if ! as_root iptables -C INPUT -p tcp --dport "${port}" ! -s 127.0.0.1 -j DROP >/dev/null 2>&1; then
      as_root iptables -I INPUT -p tcp --dport "${port}" ! -s 127.0.0.1 -j DROP
    fi
  fi
}

ombist_provision_summary_hermes() {
  local hm_state ombot_state api_ok listen_row
  hm_state="$(as_root systemctl is-active ombist-hermes-gateway.service 2>/dev/null || true)"
  ombot_state="$(as_root systemctl is-active ombist-ombot.service 2>/dev/null || true)"
  api_ok="false"
  if run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/health'" 2>/dev/null \
    || run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/models'" 2>/dev/null; then
    api_ok="true"
  fi
  listen_row="$(as_root ss -ltnp 2>/dev/null | awk -v p=":${HERMES_API_PORT}\$" '\$4 ~ p {print; exit}')"
  echo "PROVISION_SUMMARY_BEGIN"
  echo "agent_runtime=hermes"
  echo "hermes_api_port=${HERMES_API_PORT}"
  echo "hermes_api_ok=${api_ok}"
  echo "hermes_gateway_active=${hm_state}"
  echo "hermes_gateway_state=${hm_state}"
  echo "ombot_state=${ombot_state}"
  echo "ombot_loopback_port=${OMBOT_PORT:-8082}"
  echo "ombot_ws_bind_ok=${OMBIST_OMBOT_WS_BIND_OK:-false}"
  echo "ombot_port_firewall_mode=${OMBIST_OMBOT_PORT_FW_MODE:-}"
  echo "health_port_firewall_mode=${OMBIST_HEALTH_PORT_FW_MODE:-}"
  if [[ -n "${FW_WARNING:-}" ]]; then
    echo "warning=${FW_WARNING}"
  fi
  if [[ -n "${middleware_ws_url:-}" ]]; then
    echo "middleware_ws_url=${middleware_ws_url}"
  elif [[ -n "${MW_URL:-}" ]]; then
    echo "middleware_ws_url=${MW_URL}"
  fi
  if [[ -n "${listen_row}" ]]; then
    echo "listen_row=${listen_row}"
  fi
  echo "PROVISION_SUMMARY_END"
}
