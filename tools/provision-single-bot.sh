#!/usr/bin/env bash
# Single-bot (no Ombers): OpenClaw + Ombot + OmbRouter + Nginx TLS (WSS) → loopback Ombot.
# Requires: Linux, root/sudo, openssl.
# Env:
#   OMBIST_TLS_PUBLIC_HOST — hostname or IP for server cert SAN (must match iOS connection host)
#   OMBIST_WSS_PORT        — Nginx TLS listen port (e.g. 443 or 8443)
#   OPENCLAW_MACHINE_SEED  — required
# Optional: OMBOT_PORT (default 8082), OMBOT_HEALTH_PORT, OMBOT_GIT_URL, OMBROUTER_GIT_URL, OPENCLAW_GATEWAY_PORT, etc.

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

OMBOT_PORT="${OMBOT_PORT:-8082}"
OMBOT_HEALTH_PORT="${OMBOT_HEALTH_PORT:-9090}"
OMBOT_GIT_URL="${OMBOT_GIT_URL:-https://github.com/Ombist/Ombot.git}"
OMBROUTER_GIT_URL="${OMBROUTER_GIT_URL:-https://github.com/Ombist/OmbRouter.git}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
NVM_VERSION="${NVM_VERSION:-v0.40.1}"

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
  state="$(as_root systemctl is-active "${svc}" 2>/dev/null || true)"
  if [[ "${state}" != "active" ]]; then
    echo "ombist-provision-single-bot: ${svc} not active (state=${state:-unknown})" >&2
    exit 20
  fi
}

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

echo "ombist-provision-single-bot: TLS (Root CA + server cert)..."
PUBHOST="${OMBIST_TLS_PUBLIC_HOST}"
# shellcheck source=/dev/null
source "${OMBOT_BIN_DIR}/ombot-admin-lib/tls.sh"
if ! ombist_tls_provision_initial "${PUBHOST}"; then
  echo "ombist-provision-single-bot: TLS generation failed" >&2
  exit 1
fi
echo "ombist-provision-single-bot: server.crt OK (leaf signed)"

echo "ombist-provision-single-bot: installing nvm/node/openclaw..."
run_as_ombot "mkdir -p '${NPM_PREFIX}'"
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; \
if [[ ! -s \"\${NVM_DIR}/nvm.sh\" ]]; then curl -fsSL 'https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh' | bash; fi; \
source \"\${NVM_DIR}/nvm.sh\"; \
if ! nvm use 22 >/dev/null 2>&1; then nvm install 22 >/dev/null; nvm alias default 22 >/dev/null; fi; \
nvm use 22 >/dev/null; \
export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
npm install -g openclaw@latest"

echo "ombist-provision-single-bot: updating Ombot dependencies (repo already cloned)..."
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; source \"\${NVM_DIR}/nvm.sh\"; nvm use 22 >/dev/null; npm --prefix '${OMBOT_REPO_DIR}' install --omit=dev"

echo "ombist-provision-single-bot: OmbRouter + plugin..."
if as_root test -d "${OMBROUTER_REPO_DIR}/.git"; then
  run_as_ombot "git -C '${OMBROUTER_REPO_DIR}' pull --ff-only"
else
  as_root rm -rf "${OMBROUTER_REPO_DIR}"
  run_as_ombot "git clone --depth 1 '${OMBROUTER_GIT_URL}' '${OMBROUTER_REPO_DIR}'"
fi
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; source \"\${NVM_DIR}/nvm.sh\"; nvm use 22 >/dev/null; \
export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
cd '${OMBROUTER_REPO_DIR}' && npm install && npm run build && npm install -g ."
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; source \"\${NVM_DIR}/nvm.sh\"; nvm use 22 >/dev/null; \
export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
cd '${OMBROUTER_REPO_DIR}' && \
if command -v timeout >/dev/null 2>&1; then \
  timeout 300 openclaw plugins install . --force || timeout 300 openclaw plugins install .; \
else \
  openclaw plugins install . --force || openclaw plugins install .; \
fi"

echo "ombist-provision-single-bot: OpenClaw config..."
as_root tee "${OPENCLAW_CONFIG_PATH}" >/dev/null <<EOF
{
  "gateway": {
    "bind": "loopback",
    "port": ${OPENCLAW_GATEWAY_PORT}
  }
}
EOF
as_root chown root:"${OMBOT_GROUP}" "${OPENCLAW_CONFIG_PATH}"
as_root chmod 640 "${OPENCLAW_CONFIG_PATH}"

{
  echo "PORT=${OMBOT_PORT}"
  echo "HEALTH_PORT=${OMBOT_HEALTH_PORT}"
  echo "OPENCLAW_WS_LISTEN_HOST=127.0.0.1"
  echo "OPENCLAW_SINGLE_CLIENT_MODE=1"
  echo "MIDDLEWARE_WS_URL=wss://127.0.0.1:9/ws"
  echo "OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0"
  echo "OPENCLAW_MACHINE_SEED=${OPENCLAW_MACHINE_SEED}"
  echo "OPENCLAW_DATA_DIR=${OMBOT_DATA_DIR}"
  if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
  fi
} | as_root tee "${OMBOT_ENV_PATH}" >/dev/null
as_root chown root:"${OMBOT_GROUP}" "${OMBOT_ENV_PATH}"
as_root chmod 640 "${OMBOT_ENV_PATH}"

WRAPPER_GW="${OMBOT_BIN_DIR}/run-openclaw-gateway.sh"
as_root tee "${WRAPPER_GW}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="${OMBOT_HOME}/.nvm"
source "\${NVM_DIR}/nvm.sh"
nvm use 22 >/dev/null
export NPM_CONFIG_PREFIX="${NPM_PREFIX}"
export PATH="\${NPM_CONFIG_PREFIX}/bin:\${PATH}"
exec openclaw gateway --config "${OPENCLAW_CONFIG_PATH}" --port ${OPENCLAW_GATEWAY_PORT}
EOF
as_root chown root:"${OMBOT_GROUP}" "${WRAPPER_GW}"
as_root chmod 750 "${WRAPPER_GW}"

WRAPPER_OMBOT="${OMBOT_BIN_DIR}/run-ombot.sh"
as_root tee "${WRAPPER_OMBOT}" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="${OMBOT_HOME}/.nvm"
source "\${NVM_DIR}/nvm.sh"
nvm use 22 >/dev/null
set -a
source "${OMBOT_ENV_PATH}"
set +a
cd "${OMBOT_REPO_DIR}"
exec node index.js
EOF
as_root chown root:"${OMBOT_GROUP}" "${WRAPPER_OMBOT}"
as_root chmod 750 "${WRAPPER_OMBOT}"

as_root tee "${GW_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (single-bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OMBOT_USER}
Group=${OMBOT_GROUP}
ExecStart=${WRAPPER_GW}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

as_root tee "${OMBOT_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Ombot single-client (Ombist)
After=network-online.target ombist-openclaw-gateway.service
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
ReadWritePaths=${OMBOT_DATA_DIR} ${OMBOT_REPO_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

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
    server_name ${PUBHOST};
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
        proxy_read_timeout 86400;
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

echo "ombist-provision-single-bot: systemd start..."
as_root systemctl daemon-reload
as_root systemctl enable ombist-openclaw-gateway.service ombist-ombot.service
as_root systemctl start ombist-openclaw-gateway.service
sleep 2
as_root systemctl start ombist-ombot.service
require_active_service "ombist-openclaw-gateway.service"
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

GW_STATE="$(as_root systemctl is-active ombist-openclaw-gateway.service || true)"
OMBOT_STATE="$(as_root systemctl is-active ombist-ombot.service || true)"
NGINX_STATE="$(command -v nginx >/dev/null && as_root systemctl is-active nginx.service 2>/dev/null || echo unknown)"

ROOTCA_B64="$(as_root base64 -w0 "${TLS_DIR}/RootCA.crt" 2>/dev/null || as_root base64 "${TLS_DIR}/RootCA.crt" | tr -d '\n')"

echo "PROVISION_SUMMARY_BEGIN"
echo "mode=single_bot"
echo "tls_public_host=${PUBHOST}"
echo "wss_port=${OMBIST_WSS_PORT}"
echo "ombot_loopback_port=${OMBOT_PORT}"
echo "gateway_port=${OPENCLAW_GATEWAY_PORT}"
echo "gateway_state=${GW_STATE}"
echo "ombot_state=${OMBOT_STATE}"
echo "nginx_state=${NGINX_STATE}"
echo "firewall_mode=${FW_MODE}"
if [[ -n "${FW_WARNING}" ]]; then
  echo "warning=${FW_WARNING}"
fi
echo "PROVISION_SUMMARY_END"

echo "ROOTCA_PEM_B64_BEGIN"
echo "${ROOTCA_B64}"
echo "ROOTCA_PEM_B64_END"
