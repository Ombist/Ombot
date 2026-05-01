#!/usr/bin/env bash
# Strict headless install (order):
# 1) OpenClaw CLI (global npm) + loopback gateway unit
# 2) Ombot repo + production deps
# 3) OmbRouter: clone, build, npm -g, openclaw plugins install (plugin runs inside gateway)
# 4) systemd: start gateway first, then Ombot (After= gateway)
# - host firewall guard for 18789

set -euo pipefail

: "${RELAY_HOST:?RELAY_HOST is required}"
: "${MACHINE_PORT:?MACHINE_PORT is required}"
: "${OPENCLAW_MACHINE_SEED:?OPENCLAW_MACHINE_SEED is required}"

# Default wss for production (TLS must terminate at Nginx or Ombers OMBERS_USE_TLS).
# For loopback + plain Ombers only, override: MIDDLEWARE_SCHEME=ws OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0
MIDDLEWARE_SCHEME="${MIDDLEWARE_SCHEME:-wss}"
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

OMBOT_ENV_PATH="${OMBOT_ENV_PATH:-/etc/ombot/ombot.env}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
GW_SERVICE_PATH="/etc/systemd/system/ombist-openclaw-gateway.service"
OMBOT_SERVICE_PATH="/etc/systemd/system/ombist-ombot.service"

FW_MODE="none"
FW_WARNING=""

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ombist-provision: Linux required (found: $(uname -s))" >&2
  exit 1
fi

if [[ "${MIDDLEWARE_SCHEME}" != "ws" && "${MIDDLEWARE_SCHEME}" != "wss" ]]; then
  echo "ombist-provision: MIDDLEWARE_SCHEME must be ws or wss" >&2
  exit 1
fi

if [[ -z "${OPENCLAW_REQUIRE_MIDDLEWARE_TLS+x}" ]]; then
  if [[ "${MIDDLEWARE_SCHEME}" == "wss" ]]; then
    OPENCLAW_REQUIRE_MIDDLEWARE_TLS="1"
  else
    OPENCLAW_REQUIRE_MIDDLEWARE_TLS="0"
  fi
fi

MW_URL="${MIDDLEWARE_SCHEME}://${RELAY_HOST}:${MACHINE_PORT}/ws"

if [[ "$(id -u)" -eq 0 ]]; then
  ROOT_PREFIX=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  ROOT_PREFIX=(sudo -n)
else
  echo "ombist-provision: root or passwordless sudo is required" >&2
  exit 1
fi

as_root() {
  "${ROOT_PREFIX[@]}" "$@"
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
    echo "ombist-provision: ${svc} not active (state=${state:-unknown})" >&2
    exit 20
  fi
}

echo "ombist-provision: preparing service account and directories..."
if ! getent group "${OMBOT_GROUP}" >/dev/null 2>&1; then
  as_root groupadd --system "${OMBOT_GROUP}"
fi
if ! id -u "${OMBOT_USER}" >/dev/null 2>&1; then
  as_root useradd --system --home-dir "${OMBOT_HOME}" --create-home --shell /usr/sbin/nologin --gid "${OMBOT_GROUP}" "${OMBOT_USER}"
fi

as_root mkdir -p "${INSTALL_ROOT}" "${OMBOT_REPO_DIR}" "${OMBOT_BIN_DIR}" "${OMBOT_DATA_DIR}" /etc/ombot
as_root chown -R "${OMBOT_USER}:${OMBOT_GROUP}" "${INSTALL_ROOT}" "${OMBOT_DATA_DIR}"
as_root chmod 750 "${INSTALL_ROOT}" "${OMBOT_DATA_DIR}"

echo "ombist-provision: installing nvm/node/openclaw for ${OMBOT_USER}..."
run_as_ombot "mkdir -p '${NPM_PREFIX}'"
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; \
if [[ ! -s \"\${NVM_DIR}/nvm.sh\" ]]; then curl -fsSL 'https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh' | bash; fi; \
source \"\${NVM_DIR}/nvm.sh\"; \
if ! nvm use 22 >/dev/null 2>&1; then nvm install 22 >/dev/null; nvm alias default 22 >/dev/null; fi; \
nvm use 22 >/dev/null; \
export NPM_CONFIG_PREFIX='${NPM_PREFIX}'; \
export PATH=\"\${NPM_CONFIG_PREFIX}/bin:\${PATH}\"; \
npm install -g openclaw@latest"

echo "ombist-provision: cloning/updating Ombot..."
if as_root test -d "${OMBOT_REPO_DIR}/.git"; then
  run_as_ombot "git -C '${OMBOT_REPO_DIR}' pull --ff-only"
else
  as_root rm -rf "${OMBOT_REPO_DIR}"
  run_as_ombot "git clone --depth 1 '${OMBOT_GIT_URL}' '${OMBOT_REPO_DIR}'"
fi
run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; source \"\${NVM_DIR}/nvm.sh\"; nvm use 22 >/dev/null; npm --prefix '${OMBOT_REPO_DIR}' install --omit=dev"

echo "ombist-provision: cloning/building OmbRouter and registering OpenClaw plugin..."
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

# Optional: seed OpenClaw agent workspace (*.md) from env OPENCLAW_WS_*_B64
OPENCLAW_WORKSPACE_DIR="${OMBOT_HOME}/.openclaw/workspace"
SEED_OPENCLAW_WORKSPACE=0
ws_write_decode() {
  local b64="$1"
  local fname="$2"
  [[ -z "${b64}" ]] && return 0
  if [[ "${SEED_OPENCLAW_WORKSPACE}" -eq 0 ]]; then
    SEED_OPENCLAW_WORKSPACE=1
    as_root mkdir -p "${OPENCLAW_WORKSPACE_DIR}"
  fi
  printf '%s' "${b64}" | base64 -d | as_root tee "${OPENCLAW_WORKSPACE_DIR}/${fname}" >/dev/null
  as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${OPENCLAW_WORKSPACE_DIR}/${fname}"
  as_root chmod 640 "${OPENCLAW_WORKSPACE_DIR}/${fname}"
}

echo "ombist-provision: optional OpenClaw workspace seed from app..."
ws_write_decode "${OPENCLAW_WS_IDENTITY_B64:-}" "IDENTITY.md"
ws_write_decode "${OPENCLAW_WS_SOUL_B64:-}" "SOUL.md"
ws_write_decode "${OPENCLAW_WS_USER_B64:-}" "USER.md"
ws_write_decode "${OPENCLAW_WS_AGENTS_B64:-}" "AGENTS.md"
ws_write_decode "${OPENCLAW_WS_TOOLS_B64:-}" "TOOLS.md"
ws_write_decode "${OPENCLAW_WS_HEARTBEAT_B64:-}" "HEARTBEAT.md"
ws_write_decode "${OPENCLAW_WS_BOOT_B64:-}" "BOOT.md"
ws_write_decode "${OPENCLAW_WS_BOOTSTRAP_B64:-}" "BOOTSTRAP.md"
ws_write_decode "${OPENCLAW_WS_MEMORY_B64:-}" "MEMORY.md"
if [[ "${SEED_OPENCLAW_WORKSPACE}" -eq 1 ]]; then
  as_root chown -R "${OMBOT_USER}:${OMBOT_GROUP}" "${OMBOT_HOME}/.openclaw"
  as_root chmod 750 "${OMBOT_HOME}/.openclaw"
  as_root chmod 750 "${OPENCLAW_WORKSPACE_DIR}"
fi

echo "ombist-provision: writing OpenClaw config and Ombot env..."
if [[ "${SEED_OPENCLAW_WORKSPACE}" -eq 1 ]]; then
  as_root tee "${OPENCLAW_CONFIG_PATH}" >/dev/null <<EOF
{
  "gateway": {
    "bind": "loopback",
    "port": ${OPENCLAW_GATEWAY_PORT}
  },
  "agent": {
    "workspace": "${OMBOT_HOME}/.openclaw/workspace",
    "skipBootstrap": true
  }
}
EOF
else
  as_root tee "${OPENCLAW_CONFIG_PATH}" >/dev/null <<EOF
{
  "gateway": {
    "bind": "loopback",
    "port": ${OPENCLAW_GATEWAY_PORT}
  }
}
EOF
fi
as_root chown root:"${OMBOT_GROUP}" "${OPENCLAW_CONFIG_PATH}"
as_root chmod 640 "${OPENCLAW_CONFIG_PATH}"

OMBIST_ROUTE_PATCH_B64="${OPENCLAW_ROUTE_PATCH_JSON_B64:-}"
if [[ -z "${OMBIST_ROUTE_PATCH_B64}" && -n "${OPENCLAW_AGENTS_DEFAULTS_MODEL_JSON_B64:-}" ]]; then
  OMBIST_ROUTE_PATCH_B64="${OPENCLAW_AGENTS_DEFAULTS_MODEL_JSON_B64}"
fi

if [[ -n "${OMBIST_ROUTE_PATCH_B64}" ]]; then
  echo "ombist-provision: merging OpenClaw agents route patch into config..."
  OMBIST_PATCH_JSON="/tmp/ombist-agents-model-patch-$$.json"
  OMBIST_MERGED_JSON="/tmp/ombist-agents-model-out-$$.json"
  OMBIST_MERGE_JS="/tmp/ombist-agents-model-merge-$$.js"
  printf '%s' "${OMBIST_ROUTE_PATCH_B64}" | base64 -d | as_root tee "${OMBIST_PATCH_JSON}" >/dev/null
  as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${OMBIST_PATCH_JSON}"
  as_root chmod 640 "${OMBIST_PATCH_JSON}"
  as_root rm -f "${OMBIST_MERGED_JSON}"
  as_root touch "${OMBIST_MERGED_JSON}"
  as_root chown "${OMBOT_USER}:${OMBOT_GROUP}" "${OMBIST_MERGED_JSON}"
  as_root chmod 640 "${OMBIST_MERGED_JSON}"
  as_root tee "${OMBIST_MERGE_JS}" >/dev/null <<'OMBIST_NODE_MERGE'
#!/usr/bin/env node
const fs = require('fs');
const cfgPath = process.argv[2];
const patchPath = process.argv[3];
const outPath = process.argv[4];
const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
function dm(t, s) {
  for (const k of Object.keys(s)) {
    const sv = s[k];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) t[k] = {};
      dm(t[k], sv);
    } else {
      t[k] = sv;
    }
  }
}
dm(cur, patch);
fs.writeFileSync(outPath, JSON.stringify(cur, null, 2) + '\n');
OMBIST_NODE_MERGE
  as_root chmod 644 "${OMBIST_MERGE_JS}"
  run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; source \"\${NVM_DIR}/nvm.sh\"; nvm use 22 >/dev/null; node '${OMBIST_MERGE_JS}' '${OPENCLAW_CONFIG_PATH}' '${OMBIST_PATCH_JSON}' '${OMBIST_MERGED_JSON}'"
  as_root cp "${OMBIST_MERGED_JSON}" "${OPENCLAW_CONFIG_PATH}"
  as_root chown root:"${OMBOT_GROUP}" "${OPENCLAW_CONFIG_PATH}"
  as_root chmod 640 "${OPENCLAW_CONFIG_PATH}"
  as_root rm -f "${OMBIST_MERGE_JS}" "${OMBIST_PATCH_JSON}" "${OMBIST_MERGED_JSON}"
fi

{
  echo "PORT=${OMBOT_PORT}"
  echo "HEALTH_PORT=${OMBOT_HEALTH_PORT}"
  echo "MIDDLEWARE_WS_URL=${MW_URL}"
  echo "OPENCLAW_MACHINE_SEED=${OPENCLAW_MACHINE_SEED}"
  echo "OPENCLAW_DATA_DIR=${OMBOT_DATA_DIR}"
  echo "OPENCLAW_REQUIRE_MIDDLEWARE_TLS=${OPENCLAW_REQUIRE_MIDDLEWARE_TLS}"
  if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
  fi
  if [[ -n "${MIDDLEWARE_AUTH_TOKEN:-}" ]]; then
    echo "MIDDLEWARE_AUTH_TOKEN=${MIDDLEWARE_AUTH_TOKEN}"
    echo "OMBERS_AUTH_TOKEN=${MIDDLEWARE_AUTH_TOKEN}"
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

echo "ombist-provision: writing systemd services..."
as_root tee "${GW_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (loopback, Ombist strict)
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
Description=Ombot relay (Ombist strict)
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

echo "ombist-provision: enabling services (start: OpenClaw gateway → Ombot; OmbRouter runs inside gateway)..."
as_root systemctl daemon-reload
as_root systemctl enable ombist-openclaw-gateway.service ombist-ombot.service
as_root systemctl start ombist-openclaw-gateway.service
GW_BOUND="false"
for _i in {1..45}; do
  if as_root systemctl is-active --quiet ombist-openclaw-gateway.service 2>/dev/null; then
    if as_root ss -ltn 2>/dev/null | grep -q "127.0.0.1:${OPENCLAW_GATEWAY_PORT}"; then
      GW_BOUND="true"
      break
    fi
  fi
  sleep 1
done
if [[ "${GW_BOUND}" != "true" ]]; then
  echo "ombist-provision: gateway did not bind to 127.0.0.1:${OPENCLAW_GATEWAY_PORT}" >&2
  exit 21
fi
as_root systemctl start ombist-ombot.service
require_active_service "ombist-openclaw-gateway.service"
require_active_service "ombist-ombot.service"

echo "ombist-provision: applying firewall guard for tcp/${OPENCLAW_GATEWAY_PORT}..."
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
  FW_WARNING="firewall_tool_missing"
fi

GW_STATE="$(as_root systemctl is-active ombist-openclaw-gateway.service || true)"
OMBOT_STATE="$(as_root systemctl is-active ombist-ombot.service || true)"
LISTEN_ROW="$(as_root ss -ltnp | awk '\$4 ~ /:'\"${OPENCLAW_GATEWAY_PORT}\"'$/ {print \$0; exit}')"
if [[ -n "${LISTEN_ROW}" && "${LISTEN_ROW}" == *"127.0.0.1:${OPENCLAW_GATEWAY_PORT}"* ]]; then
  BIND_OK="true"
else
  BIND_OK="false"
fi

echo "PROVISION_SUMMARY_BEGIN"
echo "gateway_port=${OPENCLAW_GATEWAY_PORT}"
echo "gateway_bind_ok=${BIND_OK}"
echo "gateway_state=${GW_STATE}"
echo "ombot_state=${OMBOT_STATE}"
echo "ombrouter_repo=${OMBROUTER_REPO_DIR}"
echo "middleware_ws_url=${MW_URL}"
echo "firewall_mode=${FW_MODE}"
if [[ -n "${FW_WARNING}" ]]; then
  echo "warning=${FW_WARNING}"
fi
if [[ -n "${LISTEN_ROW}" ]]; then
  echo "listen_row=${LISTEN_ROW}"
fi
echo "PROVISION_SUMMARY_END"
