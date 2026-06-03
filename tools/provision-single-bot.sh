#!/usr/bin/env bash
# Single-bot (no Ombers): OpenClaw + Ombot + OmbRouter + Nginx TLS (WSS) → loopback Ombot.
# Requires: Linux, root/sudo, openssl.
# Env:
#   OMBIST_TLS_PUBLIC_HOST — hostname or IP for server cert SAN (must match iOS connection host)
#   OMBIST_WSS_PORT        — Nginx TLS listen port (e.g. 443 or 8443)
#   OPENCLAW_MACHINE_SEED  — required
# Optional: OMBOT_PORT (default 8082), OMBOT_HEALTH_PORT, OMBOT_GIT_URL, OMBROUTER_GIT_URL, OPENCLAW_GATEWAY_PORT, etc.
# Optional: OMBIST_INSTALL_OMBROUTER=0 (default). Set to 1 for OMB / when proxy is required on host.
# Optional: OMBIST_GATEWAY_AGENT_ID (default default), OMBIST_GATEWAY_AGENT_MODEL (default gpt-4o-mini) — auto-merge into openclaw.json agents.list + ombot.env bridge ids.

set -euo pipefail

_OMBIST_PROVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${OMBIST_PROVISION_LIB_PATH:-}" ]] && [[ -s "${OMBIST_PROVISION_LIB_PATH}" ]]; then
  # shellcheck source=/dev/null
  source "${OMBIST_PROVISION_LIB_PATH}"
elif [[ -s "${_OMBIST_PROVISION_DIR}/provision-lib-common.sh" ]]; then
  # shellcheck source=/dev/null
  source "${_OMBIST_PROVISION_DIR}/provision-lib-common.sh"
fi

: "${OMBIST_TLS_PUBLIC_HOST:?OMBIST_TLS_PUBLIC_HOST is required (cert SAN / iOS host)}"
: "${OMBIST_WSS_PORT:?OMBIST_WSS_PORT is required}"
: "${OPENCLAW_MACHINE_SEED:?OPENCLAW_MACHINE_SEED is required}"

OMBIST_AGENT_RUNTIME="${OMBIST_AGENT_RUNTIME:-openclaw}"
# shellcheck source=provision-hermes-lib.sh
source "${_OMBIST_PROVISION_DIR}/provision-hermes-lib.sh"

OMBOT_PORT="${OMBOT_PORT:-8082}"
OMBOT_HEALTH_PORT="${OMBOT_HEALTH_PORT:-9090}"
OMBOT_GIT_URL="${OMBOT_GIT_URL:-https://github.com/Ombist/Ombot.git}"
OMBROUTER_GIT_URL="${OMBROUTER_GIT_URL:-https://github.com/Ombist/OmbRouter.git}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

OMBOT_USER="${OMBOT_USER:-ombot}"
OMBOT_GROUP="${OMBOT_GROUP:-ombot}"
OMBOT_HOME="${OMBOT_HOME:-/home/${OMBOT_USER}}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/ombot}"
OMBOT_REPO_DIR="${INSTALL_ROOT}/Ombot"
OMBROUTER_REPO_DIR="${OMBROUTER_REPO_DIR:-${INSTALL_ROOT}/OmbRouter}"
OMBOT_DATA_DIR="${OMBOT_DATA_DIR:-/var/lib/ombot}"
OMBOT_BIN_DIR="${INSTALL_ROOT}/bin"
NPM_PREFIX="${INSTALL_ROOT}/npm-global"
TLS_DIR="/etc/ombot/tls"
NGINX_SITE="/etc/nginx/sites-available/ombist-single-bot.conf"
OMBOT_ENV_PATH="${OMBOT_ENV_PATH:-/etc/ombot/ombot.env}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
# Runtime JSON under OMBOT_DATA_DIR (not ~/.openclaw): ombist-ombot uses ProtectHome=true and cannot rely on ReadWritePaths under /home for compose/self-heal.
OPENCLAW_RUNTIME_CONFIG_PATH="${OPENCLAW_RUNTIME_CONFIG_PATH:-${OMBOT_DATA_DIR}/openclaw.json}"
OPENCLAW_FRAGMENTS_DIR="${OPENCLAW_FRAGMENTS_DIR:-/etc/ombot/openclaw.d}"
GW_SERVICE_PATH="/etc/systemd/system/ombist-openclaw-gateway.service"
OMBOT_SERVICE_PATH="/etc/systemd/system/ombist-ombot.service"

FW_MODE="none"
FW_WARNING=""

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ombist-provision-single-bot: Linux required (found: $(uname -s))" >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  ROOT_PREFIX=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  ROOT_PREFIX=(sudo -n)
else
  echo "ombist-provision-single-bot: root or passwordless sudo is required" >&2
  exit 1
fi

as_root() {
  "${ROOT_PREFIX[@]}" "$@"
}

LOG_DIR="${OMBIST_PROVISION_LOG_DIR:-/var/log/ombist}"
LOG_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/provision-single-bot-${LOG_STAMP}.log"

ombist_setup_provision_logging() {
  as_root mkdir -p "${LOG_DIR}"
  as_root touch "${LOG_FILE}"
  as_root chmod 640 "${LOG_FILE}" || true
  exec > >(tee -a "${LOG_FILE}") 2>&1
  echo "ombist-provision-single-bot: full log file: ${LOG_FILE}"
}

# apt-get with wait-for-lock + retries (dpkg held by unattended-upgrades / parallel apt).
# Env: OMBIST_APT_RETRY_MAX (default 40), OMBIST_APT_RETRY_DELAY_SEC (default 8),
# OMBIST_DPKG_LOCK_TIMEOUT_SEC (default 240, passed to apt -o), OMBIST_APT_NO_DPKG_LOCK_TIMEOUT=1 to skip that -o on old apt.
ombist_root_apt_get() {
  if declare -F ombist_wait_for_apt_lock >/dev/null 2>&1; then
    ombist_wait_for_apt_lock || return 1
  fi
  local max="${OMBIST_APT_RETRY_MAX:-40}"
  local delay="${OMBIST_APT_RETRY_DELAY_SEC:-8}"
  local attempt=1 out
  local lock_re='Could not get lock|Unable to acquire the dpkg frontend lock|Unable to lock the administration directory|dpkg frontend is locked|Another app is currently holding|is another apt process|Could not open lock file'
  local -a opts=()
  if [[ "${OMBIST_APT_NO_DPKG_LOCK_TIMEOUT:-0}" != "1" ]]; then
    opts+=(-o "DPkg::Lock::Timeout=${OMBIST_DPKG_LOCK_TIMEOUT_SEC:-240}" -o Acquire::Retries=3)
  fi
  while [[ "${attempt}" -le "${max}" ]]; do
    if out=$(as_root env DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" "$@" 2>&1); then
      [[ -n "${out}" ]] && printf '%s\n' "${out}"
      return 0
    fi
    if grep -Eiq "${lock_re}" <<<"${out}"; then
      echo "ombist-provision-single-bot: dpkg/apt busy, retry in ${delay}s (${attempt}/${max})..." >&2
      sleep "${delay}"
      attempt=$((attempt + 1))
      continue
    fi
    if [[ "${OMBIST_APT_NO_DPKG_LOCK_TIMEOUT:-0}" != "1" ]] && grep -Eiq 'Unknown configuration option:.*DPkg::Lock::Timeout|Unrecognized option.*DPkg::Lock::Timeout' <<<"${out}"; then
      echo "ombist-provision-single-bot: apt has no DPkg::Lock::Timeout; set OMBIST_APT_NO_DPKG_LOCK_TIMEOUT=1 or upgrade apt; retrying without it..." >&2
      OMBIST_APT_NO_DPKG_LOCK_TIMEOUT=1 ombist_root_apt_get "$@"
      return $?
    fi
    printf '%s\n' "${out}" >&2
    return 1
  done
  echo "ombist-provision-single-bot: apt still blocked after ${max} retries" >&2
  return 1
}

run_as_ombot() {
  if [[ "$(id -u)" -eq 0 ]]; then
    su -s /bin/bash - "${OMBOT_USER}" -c "$1"
  else
    sudo -n -u "${OMBOT_USER}" -H bash -lc "$1"
  fi
}

require_active_service() {
  local svc="$1"
  local state
  local wait_seconds="${2:-45}"
  local i
  for ((i=0; i<=wait_seconds; i++)); do
    state="$(as_root systemctl is-active "${svc}" 2>/dev/null || true)"
    if [[ "${state}" == "active" ]]; then
      return 0
    fi
    if [[ "${state}" == "failed" || "${state}" == "inactive" || "${state}" == "deactivating" ]]; then
      break
    fi
    sleep 1
  done
  echo "ombist-provision-single-bot: ${svc} not active after ${wait_seconds}s (state=${state:-unknown})" >&2
  as_root systemctl --no-pager -l status "${svc}" 2>&1 | tail -n 80 >&2 || true
  exit 20
}

assert_gateway_port_listening() {
  local port="${1:-18789}"
  local wait_seconds="${2:-60}"
  local i
  for ((i=0; i<=wait_seconds; i++)); do
    if command -v ss >/dev/null 2>&1; then
      if ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN; then
        return 0
      fi
    elif command -v nc >/dev/null 2>&1; then
      if nc -z 127.0.0.1 "${port}" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "ombist-provision-single-bot: gateway port ${port} not listening on loopback after ${wait_seconds}s" >&2
  exit 24
}

assert_openclaw_gateway_mode_local() {
  local cfg="$1"
  local mode=""
  if command -v node >/dev/null 2>&1; then
    mode="$(as_root env OMBIST_CFG_PATH="${cfg}" node -e "const fs=require('fs');try{const p=process.env.OMBIST_CFG_PATH||'';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String((j.gateway&&j.gateway.mode)||''));}catch(e){process.stdout.write('');}")" || mode=""
  fi
  if [[ "${mode}" == "local" ]]; then
    return 0
  fi
  if as_root test -r "${cfg}" && as_root grep -Eq '"mode"[[:space:]]*:[[:space:]]*"local"' "${cfg}"; then
    return 0
  fi
  echo "ombist-provision-single-bot: invalid OpenClaw config (${cfg}); require gateway.mode=local before starting gateway service" >&2
  exit 27
}

ombist_setup_provision_logging

trap 'rc=$?; if [[ "${rc}" -ne 0 ]]; then echo "ombist-provision-single-bot: failed (exit=${rc}); full log: ${LOG_FILE}" >&2; fi' EXIT

echo "ombist-provision-single-bot: service account and dirs..."
if ! getent group "${OMBOT_GROUP}" >/dev/null 2>&1; then
  as_root groupadd --system "${OMBOT_GROUP}"
fi
if ! id -u "${OMBOT_USER}" >/dev/null 2>&1; then
  as_root useradd --system --home-dir "${OMBOT_HOME}" --create-home --shell /usr/sbin/nologin --gid "${OMBOT_GROUP}" "${OMBOT_USER}"
fi

as_root mkdir -p "${INSTALL_ROOT}" "${OMBOT_REPO_DIR}" "${OMBOT_BIN_DIR}" "${OMBOT_DATA_DIR}" /etc/ombot "${TLS_DIR}"
as_root chown -R "${OMBOT_USER}:${OMBOT_GROUP}" "${INSTALL_ROOT}" "${OMBOT_DATA_DIR}"
as_root chmod 750 "${INSTALL_ROOT}" "${OMBOT_DATA_DIR}"
as_root chmod 711 "${TLS_DIR}"

echo "ombist-provision-single-bot: ensuring git (for Ombot clone / ombot-admin)..."
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    ombist_root_apt_get update -y && ombist_root_apt_get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y git
  else
    echo "ombist-provision-single-bot: git is required but no supported package manager found" >&2
    exit 1
  fi
fi

echo "ombist-provision-single-bot: cloning Ombot (early for ombot-admin + TLS helpers)..."
if as_root test -d "${OMBOT_REPO_DIR}/.git"; then
  run_as_ombot "git -C '${OMBOT_REPO_DIR}' pull --ff-only"
else
  as_root rm -rf "${OMBOT_REPO_DIR}"
  run_as_ombot "git clone --depth 1 '${OMBOT_GIT_URL}' '${OMBOT_REPO_DIR}'"
fi

if [[ -f "${OMBOT_REPO_DIR}/tools/ombot-admin" ]]; then
  echo "ombist-provision-single-bot: installing ombot-admin to ${OMBOT_BIN_DIR}..."
  as_root install -m 0755 "${OMBOT_REPO_DIR}/tools/ombot-admin" "${OMBOT_BIN_DIR}/ombot-admin"
  as_root rm -rf "${OMBOT_BIN_DIR}/ombot-admin-lib"
  as_root mkdir -p "${OMBOT_BIN_DIR}/ombot-admin-lib"
  as_root cp -a "${OMBOT_REPO_DIR}/tools/ombot-admin-lib/." "${OMBOT_BIN_DIR}/ombot-admin-lib/"
  as_root chown -R root:root "${OMBOT_BIN_DIR}/ombot-admin" "${OMBOT_BIN_DIR}/ombot-admin-lib"
fi

ombist_as_root() {
  as_root "$@"
}

# Bracket unbracketed IPv6 for nginx server_name (RFC 3986). PUBHOST stays unbracketed for tls.sh SAN.
ombist_tls_pubhost_url_authority() {
  local raw="$1"
  if [[ "${raw}" == *:* ]] && [[ ! "${raw}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "${raw}" != \[*\] ]]; then
    printf '[%s]' "${raw}"
  else
    printf '%s' "${raw}"
  fi
}

echo "ombist-provision-single-bot: TLS (Root CA + server cert)..."
PUBHOST="${OMBIST_TLS_PUBLIC_HOST}"
PUBHOST_TLS_AUTHORITY="$(ombist_tls_pubhost_url_authority "${PUBHOST}")"
# shellcheck source=/dev/null
source "${OMBOT_BIN_DIR}/ombot-admin-lib/tls.sh"
if ! ombist_tls_provision_initial "${PUBHOST}"; then
  echo "ombist-provision-single-bot: TLS generation failed" >&2
  exit 1
fi
echo "ombist-provision-single-bot: server.crt OK (leaf signed)"

OMBIST_PROVISION_LABEL="ombist-provision-single-bot"
echo "${OMBIST_PROVISION_LABEL}: ensuring nodejs >= 22..."
ombist_ensure_node22
if ! command -v npm >/dev/null 2>&1; then
  echo "${OMBIST_PROVISION_LABEL}: npm not found after node install" >&2
  exit 14
fi

run_as_ombot "mkdir -p '${NPM_PREFIX}'"
if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
  echo "ombist-provision-single-bot: agent runtime=hermes (skipping OpenClaw npm install)"
  ombist_install_hermes_cli || exit 30
  ombist_write_hermes_env_file || exit 31
else
echo "ombist-provision-single-bot: installing openclaw..."
run_as_ombot "export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
npm install -g openclaw@latest"

if [[ -z "${OPENCLAW_GATEWAY_TOKEN}" ]]; then
  OPENCLAW_GATEWAY_TOKEN="$(node -e "const c=require('crypto');process.stdout.write(c.randomBytes(32).toString('hex'));" 2>/dev/null || true)"
  if [[ -z "${OPENCLAW_GATEWAY_TOKEN}" ]] && command -v openssl >/dev/null 2>&1; then
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32 2>/dev/null || true)"
  fi
  if [[ -z "${OPENCLAW_GATEWAY_TOKEN}" ]]; then
    echo "ombist-provision-single-bot: failed to generate OPENCLAW_GATEWAY_TOKEN" >&2
    exit 1
  fi
  echo "ombist-provision-single-bot: generated gateway token for local auth."
fi
fi

echo "ombist-provision-single-bot: updating Ombot dependencies (repo already cloned)..."
run_as_ombot "npm --prefix '${OMBOT_REPO_DIR}' install --omit=dev"

: "${OMBIST_INSTALL_OMBROUTER:=0}"
if [[ "${OMBIST_INSTALL_OMBROUTER}" != "0" ]]; then
  echo "ombist-provision-single-bot: OmbRouter (without OpenClaw plugin registration)..."
  if as_root test -d "${OMBROUTER_REPO_DIR}/.git"; then
    run_as_ombot "git -C '${OMBROUTER_REPO_DIR}' pull --ff-only"
  else
    as_root rm -rf "${OMBROUTER_REPO_DIR}"
    run_as_ombot "git clone --depth 1 '${OMBROUTER_GIT_URL}' '${OMBROUTER_REPO_DIR}'"
  fi
  run_as_ombot "export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
cd '${OMBROUTER_REPO_DIR}' && npm install && npm run build && npm install -g ."
else
  echo "ombist-provision-single-bot: skipping OmbRouter (OMBIST_INSTALL_OMBROUTER=0)."
fi

if [[ "${OMBIST_AGENT_RUNTIME}" != "hermes" ]]; then
echo "ombist-provision-single-bot: OpenClaw fragments + compose..."
as_root mkdir -p "${OPENCLAW_FRAGMENTS_DIR}"
as_root tee "${OPENCLAW_FRAGMENTS_DIR}/10-gateway-transport.json" >/dev/null <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": ${OPENCLAW_GATEWAY_PORT}
  }
}
EOF
as_root tee "${OPENCLAW_FRAGMENTS_DIR}/20-gateway-security.json" >/dev/null <<EOF
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  }
}
EOF
as_root chown -R "root:${OMBOT_GROUP}" "${OPENCLAW_FRAGMENTS_DIR}"
as_root chmod 775 "${OPENCLAW_FRAGMENTS_DIR}"
as_root chmod 640 "${OPENCLAW_FRAGMENTS_DIR}/10-gateway-transport.json" "${OPENCLAW_FRAGMENTS_DIR}/20-gateway-security.json"

echo "ombist-provision-single-bot: composing OpenClaw config from fragments..."
as_root mkdir -p "$(dirname "${OPENCLAW_RUNTIME_CONFIG_PATH}")"
# Compose writes OPENCLAW_CONFIG_PATH under /etc (root-only); runtime path is chowned to ombot below.
OMBIST_NODE_BIN="$(command -v node)"
as_root env \
  OPENCLAW_FRAGMENTS_DIR="${OPENCLAW_FRAGMENTS_DIR}" \
  OPENCLAW_RUNTIME_CONFIG_PATH="${OPENCLAW_RUNTIME_CONFIG_PATH}" \
  OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
  OPENCLAW_COMPOSE_USE_FLOCK=0 \
  "${OMBIST_NODE_BIN}" "${OMBOT_REPO_DIR}/tools/openclaw-compose.mjs" || {
  echo "ombist-provision-single-bot: openclaw-compose failed (gateway will not start)" >&2
  exit 28
}

OMBIST_GATEWAY_AGENT_ID="${OMBIST_GATEWAY_AGENT_ID:-default}"
OMBIST_GATEWAY_AGENT_MODEL="${OMBIST_GATEWAY_AGENT_MODEL:-gpt-4o-mini}"
echo "ombist-provision-single-bot: ensuring OpenClaw agents.list id=${OMBIST_GATEWAY_AGENT_ID} (model=${OMBIST_GATEWAY_AGENT_MODEL})..."
as_root env \
  OMBIST_GATEWAY_AGENT_ID="${OMBIST_GATEWAY_AGENT_ID}" \
  OMBIST_GATEWAY_AGENT_MODEL="${OMBIST_GATEWAY_AGENT_MODEL}" \
  OPENCLAW_FRAGMENTS_DIR="${OPENCLAW_FRAGMENTS_DIR}" \
  OPENCLAW_RUNTIME_CONFIG_PATH="${OPENCLAW_RUNTIME_CONFIG_PATH}" \
  OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
  OPENCLAW_COMPOSE_USE_FLOCK=0 \
  "${OMBIST_NODE_BIN}" "${OMBOT_REPO_DIR}/tools/ensure-openclaw-gateway-agent.mjs" || {
  echo "ombist-provision-single-bot: ensure-openclaw-gateway-agent failed" >&2
  exit 29
}
as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${OPENCLAW_RUNTIME_CONFIG_PATH}"
as_root chmod 640 "${OPENCLAW_RUNTIME_CONFIG_PATH}"
as_root chown root:"${OMBOT_GROUP}" "${OPENCLAW_CONFIG_PATH}"
as_root chmod 640 "${OPENCLAW_CONFIG_PATH}"
as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${OPENCLAW_FRAGMENTS_DIR}/30-ombist-gateway-agent.json" 2>/dev/null || true
fi

{
  echo "PORT=${OMBOT_PORT}"
  echo "HEALTH_PORT=${OMBOT_HEALTH_PORT}"
  echo "OPENCLAW_WS_LISTEN_HOST=127.0.0.1"
  echo "OPENCLAW_SINGLE_CLIENT_MODE=1"
  echo "OPENCLAW_MACHINE_SEED=${OPENCLAW_MACHINE_SEED}"
  echo "MIDDLEWARE_WS_URL=wss://127.0.0.1:9/ws"
  echo "OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0"
  if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
    echo "OMBIST_AGENT_RUNTIME=hermes"
    echo "OPENCLAW_SELF_HEAL=0"
    echo "OPENCLAW_READYZ_REQUIRE_GATEWAY=0"
  else
    echo "OMBIST_AGENT_RUNTIME=openclaw"
    echo "OPENCLAW_SELF_HEAL=1"
    echo "OPENCLAW_SELF_HEAL_INTERVAL_MS=180000"
    echo "OPENCLAW_GATEWAY_WATCH_INTERVAL_MS=60000"
    echo "OPENCLAW_GATEWAY_CONNECT_WAIT_MS=45000"
    echo "OPENCLAW_READYZ_REQUIRE_GATEWAY=1"
    echo "OPENCLAW_FRAGMENTS_DIR=${OPENCLAW_FRAGMENTS_DIR}"
    echo "OPENCLAW_DATA_DIR=${OMBOT_DATA_DIR}"
    echo "OPENCLAW_RUNTIME_CONFIG_PATH=${OPENCLAW_RUNTIME_CONFIG_PATH}"
    echo "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH}"
    echo 'OPENCLAW_BRIDGE_OPERATOR_SCOPES=["operator.read","operator.write","operator.admin"]'
    echo "OPENCLAW_BRIDGE_AGENT_ID=${OMBIST_GATEWAY_AGENT_ID}"
    echo "OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID=${OMBIST_GATEWAY_AGENT_ID}"
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo "OPENAI_API_KEY=${OPENAI_API_KEY}"
  fi
  if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
    echo "OPENAI_BASE_URL=${OPENAI_BASE_URL}"
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
  fi
  if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
    echo "GOOGLE_API_KEY=${GOOGLE_API_KEY}"
  fi
  if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
  fi
} | as_root tee "${OMBOT_ENV_PATH}" >/dev/null
if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
  HERMES_BRIDGE_CONVERSATION_ID="${HERMES_BRIDGE_CONVERSATION_ID:-default}"
  HERMES_BRIDGE_PARTICIPANT_ID="${HERMES_BRIDGE_PARTICIPANT_ID:-default}"
  ombist_append_ombot_env_hermes_bridge
fi
as_root chown root:"${OMBOT_GROUP}" "${OMBOT_ENV_PATH}"
as_root chmod 640 "${OMBOT_ENV_PATH}"

if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
  ombist_write_hermes_gateway_systemd
  WRAPPER_OMBOT="${OMBOT_BIN_DIR}/run-ombot.sh"
  as_root tee "${WRAPPER_OMBOT}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
source "${OMBOT_ENV_PATH}"
set +a
cd "${OMBOT_REPO_DIR}"
exec node index.js
EOF
  as_root chown root:"${OMBOT_GROUP}" "${WRAPPER_OMBOT}"
  as_root chmod 750 "${WRAPPER_OMBOT}"

  as_root tee "${OMBOT_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Ombot single-client (Ombist, Hermes bridge)
Requires=ombist-hermes-gateway.service
After=network-online.target ombist-hermes-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=${OMBOT_USER}
Group=${OMBOT_GROUP}
EnvironmentFile=${OMBOT_ENV_PATH}
ExecStart=${WRAPPER_OMBOT}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${OMBOT_DATA_DIR} ${OMBOT_REPO_DIR} ${HERMES_HOME}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
fi

if [[ "${OMBIST_AGENT_RUNTIME}" != "hermes" ]]; then
WRAPPER_GW="${OMBOT_BIN_DIR}/run-openclaw-gateway.sh"
as_root tee "${WRAPPER_GW}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NPM_CONFIG_PREFIX="${NPM_PREFIX}"
export PATH="\${NPM_CONFIG_PREFIX}/bin:\${PATH}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_RUNTIME_CONFIG_PATH}"
export HOME="${OMBOT_HOME:-/home/${OMBOT_USER}}"
if [[ "\${HOME}" != /* ]]; then
  export HOME="/\${HOME#./}"
fi
exec openclaw gateway --port ${OPENCLAW_GATEWAY_PORT}
EOF
as_root chown root:"${OMBOT_GROUP}" "${WRAPPER_GW}"
as_root chmod 750 "${WRAPPER_GW}"

WRAPPER_OMBOT="${OMBOT_BIN_DIR}/run-ombot.sh"
as_root tee "${WRAPPER_OMBOT}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
source "${OMBOT_ENV_PATH}"
set +a
cd "${OMBOT_REPO_DIR}"
exec node index.js
EOF
as_root chown root:"${OMBOT_GROUP}" "${WRAPPER_OMBOT}"
as_root chmod 750 "${WRAPPER_OMBOT}"

WAIT_GATEWAY="${OMBOT_BIN_DIR}/wait-gateway-loopback.sh"
as_root install -m 0750 "${OMBOT_REPO_DIR}/tools/wait-gateway-loopback.sh" "${WAIT_GATEWAY}"
as_root chown root:"${OMBOT_GROUP}" "${WAIT_GATEWAY}"

as_root tee "${GW_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (single-bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OMBOT_USER}
Group=${OMBOT_GROUP}
EnvironmentFile=${OMBOT_ENV_PATH}
ExecStart=${WRAPPER_GW}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

as_root tee "${OMBOT_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Ombot single-client (Ombist)
Requires=ombist-openclaw-gateway.service
After=network-online.target ombist-openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=${OMBOT_USER}
Group=${OMBOT_GROUP}
EnvironmentFile=${OMBOT_ENV_PATH}
ExecStartPre=${WAIT_GATEWAY}
ExecStart=${WRAPPER_OMBOT}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${OMBOT_DATA_DIR} ${OMBOT_REPO_DIR} ${OMBOT_HOME}/.openclaw
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
fi

echo "ombist-provision-single-bot: Nginx..."
if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    ombist_root_apt_get update -y && ombist_root_apt_get install -y nginx
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y nginx
  else
    echo "ombist-provision-single-bot: nginx not found and no supported package manager to install it" >&2
    exit 21
  fi
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "ombist-provision-single-bot: nginx install step finished but nginx still unavailable" >&2
  exit 22
fi

as_root tee "${NGINX_SITE}" >/dev/null <<EOF
server {
    listen ${OMBIST_WSS_PORT} ssl;
    listen [::]:${OMBIST_WSS_PORT} ssl;
    server_name ${PUBHOST_TLS_AUTHORITY};
    ssl_certificate ${TLS_DIR}/server.crt;
    ssl_certificate_key ${TLS_DIR}/server.key;
    location = /health {
        default_type application/json;
        return 200 '{"ok":true}';
    }
    location /ws {
        proxy_pass http://127.0.0.1:${OMBOT_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_connect_timeout 60;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF
as_root ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/ombist-single-bot.conf
if ! as_root nginx -t; then
  echo "ombist-provision-single-bot: nginx configuration test failed" >&2
  exit 23
fi
as_root systemctl enable nginx.service
as_root systemctl restart nginx.service

as_root systemctl daemon-reload
if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
  echo "ombist-provision-single-bot: systemd restart (Hermes gateway then ombot)..."
  as_root systemctl enable ombist-hermes-gateway.service ombist-ombot.service
  as_root systemctl restart ombist-hermes-gateway.service
  ombist_wait_hermes_api || exit 32
  as_root systemctl restart ombist-ombot.service
  require_active_service "ombist-hermes-gateway.service"
  require_active_service "ombist-ombot.service"
  require_active_service "nginx.service"
  ombist_hermes_firewall_guard
  FW_MODE="${FW_MODE:-hermes_loopback}"
else
echo "ombist-provision-single-bot: systemd restart (gateway then ombot)..."
assert_openclaw_gateway_mode_local "${OPENCLAW_CONFIG_PATH}"
as_root systemctl enable ombist-openclaw-gateway.service ombist-ombot.service
as_root systemctl restart ombist-openclaw-gateway.service
sleep 2
as_root systemctl restart ombist-ombot.service
require_active_service "ombist-openclaw-gateway.service"
assert_gateway_port_listening "${OPENCLAW_GATEWAY_PORT}" 60
require_active_service "ombist-ombot.service"
require_active_service "nginx.service"

echo "ombist-provision-single-bot: firewall for gateway port..."
if command -v ufw >/dev/null 2>&1; then
  as_root ufw deny in proto tcp to any port "${OPENCLAW_GATEWAY_PORT}" >/dev/null 2>&1 || true
  FW_MODE="ufw"
elif command -v iptables >/dev/null 2>&1; then
  if ! as_root iptables -C INPUT -p tcp --dport "${OPENCLAW_GATEWAY_PORT}" ! -s 127.0.0.1 -j DROP >/dev/null 2>&1; then
    as_root iptables -I INPUT -p tcp --dport "${OPENCLAW_GATEWAY_PORT}" ! -s 127.0.0.1 -j DROP
  fi
  FW_MODE="iptables"
elif command -v nft >/dev/null 2>&1; then
  as_root nft add table inet ombist_fw >/dev/null 2>&1 || true
  as_root nft add chain inet ombist_fw input "{ type filter hook input priority 0; policy accept; }" >/dev/null 2>&1 || true
  as_root nft add rule inet ombist_fw input tcp dport "${OPENCLAW_GATEWAY_PORT}" ip saddr != 127.0.0.1 drop >/dev/null 2>&1 || true
  FW_MODE="nft"
else
  FW_WARNING="${FW_WARNING:+$FW_WARNING; }firewall_tool_missing"
fi
fi

if [[ "${OMBIST_AGENT_RUNTIME}" == "hermes" ]]; then
  HM_STATE="$(as_root systemctl is-active ombist-hermes-gateway.service || true)"
  OMBOT_STATE="$(as_root systemctl is-active ombist-ombot.service || true)"
  NGINX_STATE="$(command -v nginx >/dev/null && as_root systemctl is-active nginx.service 2>/dev/null || echo unknown)"
  API_OK="false"
  if run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/health'" 2>/dev/null \
    || run_as_ombot "curl -fsS -o /dev/null -H 'Authorization: Bearer ${HERMES_API_SERVER_KEY}' 'http://${HERMES_API_HOST}:${HERMES_API_PORT}/v1/models'" 2>/dev/null; then
    API_OK="true"
  fi
  ROOTCA_B64="$(as_root base64 -w0 "${TLS_DIR}/RootCA.crt" 2>/dev/null || as_root base64 "${TLS_DIR}/RootCA.crt" | tr -d '\n')"
  echo "PROVISION_SUMMARY_BEGIN"
  echo "mode=single_bot"
  echo "agent_runtime=hermes"
  echo "tls_public_host=${PUBHOST}"
  echo "wss_port=${OMBIST_WSS_PORT}"
  echo "ombot_loopback_port=${OMBOT_PORT}"
  echo "hermes_api_port=${HERMES_API_PORT}"
  echo "hermes_api_ok=${API_OK}"
  echo "hermes_gateway_active=${HM_STATE}"
  echo "hermes_gateway_state=${HM_STATE}"
  echo "ombot_state=${OMBOT_STATE}"
  echo "nginx_state=${NGINX_STATE}"
  echo "log_file=${LOG_FILE}"
  echo "firewall_mode=${FW_MODE}"
  if [[ -n "${FW_WARNING}" ]]; then
    echo "warning=${FW_WARNING}"
  fi
  echo "PROVISION_SUMMARY_END"
  echo "ROOTCA_PEM_B64_BEGIN"
  echo "${ROOTCA_B64}"
  echo "ROOTCA_PEM_B64_END"
  exit 0
fi

GW_STATE="$(as_root systemctl is-active ombist-openclaw-gateway.service || true)"
OMBOT_STATE="$(as_root systemctl is-active ombist-ombot.service || true)"
NGINX_STATE="$(command -v nginx >/dev/null && as_root systemctl is-active nginx.service 2>/dev/null || echo unknown)"

ROOTCA_B64="$(as_root base64 -w0 "${TLS_DIR}/RootCA.crt" 2>/dev/null || as_root base64 "${TLS_DIR}/RootCA.crt" | tr -d '\n')"

echo "PROVISION_SUMMARY_BEGIN"
echo "mode=single_bot"
echo "agent_runtime=openclaw"
echo "tls_public_host=${PUBHOST}"
echo "wss_port=${OMBIST_WSS_PORT}"
echo "ombot_loopback_port=${OMBOT_PORT}"
echo "gateway_port=${OPENCLAW_GATEWAY_PORT}"
echo "gateway_state=${GW_STATE}"
echo "ombot_state=${OMBOT_STATE}"
echo "nginx_state=${NGINX_STATE}"
echo "log_file=${LOG_FILE}"
echo "firewall_mode=${FW_MODE}"
if [[ -n "${FW_WARNING}" ]]; then
  echo "warning=${FW_WARNING}"
fi
echo "PROVISION_SUMMARY_END"

echo "ROOTCA_PEM_B64_BEGIN"
echo "${ROOTCA_B64}"
echo "ROOTCA_PEM_B64_END"
