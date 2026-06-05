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

# Remove Ubuntu/Debian distro nodejs + libnode* before installing NodeSource nodejs (avoids
# "trying to overwrite /usr/include/node/common.gypi" from libnode-dev).
# Requires ombist_root_apt_get in the sourcing script.
ombist_apt_purge_distro_node_before_nodesource() {
  if [[ "$(ombist_detect_pkg_manager 2>/dev/null || printf '')" != "apt" ]]; then
    return 0
  fi
  if ! declare -F ombist_root_apt_get >/dev/null 2>&1; then
    echo "ombist-provision: ombist_apt_purge_distro_node_before_nodesource requires ombist_root_apt_get" >&2
    return 1
  fi
  if declare -F ombist_wait_for_apt_lock >/dev/null 2>&1; then
    ombist_wait_for_apt_lock || return 1
  fi
  echo "ombist-provision: purging distro nodejs/libnode packages before NodeSource install..."
  ombist_root_apt_get purge -y nodejs npm libnode-dev nodejs-doc 2>/dev/null || true
  local libnodes pkg
  libnodes="$(dpkg-query -W -f='${Package}\n' 'libnode*' 2>/dev/null | grep -v '^$' || true)"
  if [[ -n "${libnodes}" ]]; then
    while IFS= read -r pkg; do
      [[ -n "${pkg}" ]] || continue
      ombist_root_apt_get purge -y "${pkg}" 2>/dev/null || true
    done <<< "${libnodes}"
  fi
  ombist_root_apt_get autoremove -y || true
}

# Node.js major version for a binary (default: `node` on PATH). Prints 0 on failure.
ombist_node_major() {
  local node_bin="${1:-}"
  if [[ -z "${node_bin}" ]]; then
    command -v node >/dev/null 2>&1 || return 1
    node_bin="$(command -v node)"
  fi
  "${node_bin}" -p 'parseInt(process.versions.node.split(".")[0],10)' 2>/dev/null || printf '0\n'
}

# Resolve ombot-user nvm Node 22 binary (requires run_as_ombot, OMBOT_HOME).
ombist_ombot_nvm_node_bin() {
  local nvm_ver="${NVM_VERSION:-v0.40.1}"
  if ! declare -F run_as_ombot >/dev/null 2>&1; then
    return 1
  fi
  : "${OMBOT_HOME:?OMBOT_HOME required for ombot nvm}"
  run_as_ombot "export NVM_DIR='${OMBOT_HOME}/.nvm'; \
if [[ ! -s \"\${NVM_DIR}/nvm.sh\" ]]; then curl -fsSL 'https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_ver}/install.sh' | bash; fi; \
source \"\${NVM_DIR}/nvm.sh\"; \
if ! nvm use 22 >/dev/null 2>&1; then nvm install 22 >/dev/null; nvm alias default 22 >/dev/null; fi; \
nvm use 22 >/dev/null; command -v node" | head -n1 | tr -d '\r'
}

ombist_install_node22_via_apt_nodesource() {
  if ! declare -F as_root >/dev/null 2>&1 || ! declare -F ombist_root_apt_get >/dev/null 2>&1; then
    echo "ombist-provision: NodeSource install requires as_root and ombist_root_apt_get" >&2
    return 1
  fi
  ombist_root_apt_get update -y || return 1
  ombist_root_apt_get install -y ca-certificates curl gnupg || return 1
  ombist_apt_purge_distro_node_before_nodesource || return 1
  as_root mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | as_root gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | as_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  ombist_root_apt_get update -y || return 1
  ombist_root_apt_get install -y nodejs || return 1
}

# Install Node 22 under ombot via nvm; optionally symlink node/npm into /usr/local/bin for system tools.
ombist_install_node22_via_nvm_for_ombot() {
  local label="${OMBIST_PROVISION_LABEL:-ombist-provision}"
  local node_bin npm_bin
  if ! declare -F run_as_ombot >/dev/null 2>&1; then
    echo "${label}: nvm fallback requires run_as_ombot" >&2
    return 1
  fi
  : "${OMBOT_HOME:?OMBOT_HOME required}"
  echo "${label}: installing Node.js 22 via nvm for ${OMBOT_USER:-ombot}..."
  node_bin="$(ombist_ombot_nvm_node_bin)" || node_bin=""
  if [[ -z "${node_bin}" || ! -x "${node_bin}" ]]; then
    echo "${label}: nvm node binary not found after install" >&2
    return 1
  fi
  if declare -F as_root >/dev/null 2>&1; then
    as_root mkdir -p /usr/local/bin
    as_root ln -sf "${node_bin}" /usr/local/bin/node
    npm_bin="$(dirname "${node_bin}")/npm"
    if [[ -x "${npm_bin}" ]]; then
      as_root ln -sf "${npm_bin}" /usr/local/bin/npm
    fi
  fi
}

# Ensure Node >= 22 on PATH (system) or via ombot nvm. Exit 14 on failure.
ombist_ensure_node22() {
  local label="${OMBIST_PROVISION_LABEL:-ombist-provision}"
  local major=0
  local node_bin=""

  if command -v node >/dev/null 2>&1; then
    major="$(ombist_node_major 2>/dev/null || echo 0)"
    if [[ "${major}" -ge 22 ]]; then
      return 0
    fi
    echo "${label}: current node v$(node -v 2>/dev/null || echo unknown) < 22; upgrading..."
  else
    echo "${label}: node not found; installing >= 22..."
  fi

  if command -v apt-get >/dev/null 2>&1 && declare -F ombist_install_node22_via_apt_nodesource >/dev/null 2>&1; then
    echo "${label}: trying NodeSource (apt)..."
    if ombist_install_node22_via_apt_nodesource; then
      hash -r 2>/dev/null || true
    else
      echo "${label}: NodeSource (apt) failed; trying nvm fallback..." >&2
    fi
  elif command -v dnf >/dev/null 2>&1 && declare -F as_root >/dev/null 2>&1; then
    as_root dnf install -y nodejs npm 2>/dev/null || as_root dnf install -y nodejs 2>/dev/null || true
  elif command -v yum >/dev/null 2>&1 && declare -F as_root >/dev/null 2>&1; then
    as_root yum install -y nodejs npm 2>/dev/null || as_root yum install -y nodejs 2>/dev/null || true
  fi

  if command -v node >/dev/null 2>&1; then
    major="$(ombist_node_major 2>/dev/null || echo 0)"
    if [[ "${major}" -ge 22 ]]; then
      return 0
    fi
  fi

  if declare -F ombist_install_node22_via_nvm_for_ombot >/dev/null 2>&1; then
    if ombist_install_node22_via_nvm_for_ombot; then
      hash -r 2>/dev/null || true
      if command -v node >/dev/null 2>&1; then
        major="$(ombist_node_major 2>/dev/null || echo 0)"
        if [[ "${major}" -ge 22 ]]; then
          return 0
        fi
      fi
      node_bin="$(ombist_ombot_nvm_node_bin 2>/dev/null || true)"
      if [[ -n "${node_bin}" && -x "${node_bin}" ]]; then
        major="$(ombist_node_major "${node_bin}" 2>/dev/null || echo 0)"
        if [[ "${major}" -ge 22 ]]; then
          return 0
        fi
      fi
    fi
  fi

  echo "${label}: node version too old or missing (found $(node -v 2>/dev/null || echo none), require >= 22)" >&2
  exit 14
}

# Install ombot-admin CLI from a cloned Ombot repo (requires as_root).
ombist_install_ombot_admin_from_repo() {
  local repo_dir="${1:?}"
  local bin_dir="${2:?}"
  if [[ ! -f "${repo_dir}/tools/ombot-admin" ]]; then
    return 1
  fi
  if ! declare -F as_root >/dev/null 2>&1; then
    return 1
  fi
  as_root install -m 0755 "${repo_dir}/tools/ombot-admin" "${bin_dir}/ombot-admin"
  as_root rm -rf "${bin_dir}/ombot-admin-lib"
  as_root mkdir -p "${bin_dir}/ombot-admin-lib"
  as_root cp -a "${repo_dir}/tools/ombot-admin-lib/." "${bin_dir}/ombot-admin-lib/"
  as_root chown -R root:root "${bin_dir}/ombot-admin" "${bin_dir}/ombot-admin-lib"
  return 0
}

# Deny inbound TCP to <port> from non-loopback. Prints: ufw|iptables|nft|missing
ombist_firewall_deny_non_loopback_tcp() {
  local port="${1:-}"
  if [[ -z "${port}" || ! "${port}" =~ ^[0-9]+$ ]]; then
    echo "missing"
    return 1
  fi
  if ! declare -F as_root >/dev/null 2>&1; then
    echo "missing"
    return 1
  fi
  if command -v ufw >/dev/null 2>&1; then
    as_root ufw deny in proto tcp to any port "${port}" >/dev/null 2>&1 || true
    echo "ufw"
    return 0
  fi
  if command -v iptables >/dev/null 2>&1; then
    if ! as_root iptables -C INPUT -p tcp --dport "${port}" ! -s 127.0.0.1 -j DROP >/dev/null 2>&1; then
      as_root iptables -I INPUT -p tcp --dport "${port}" ! -s 127.0.0.1 -j DROP
    fi
    echo "iptables"
    return 0
  fi
  if command -v nft >/dev/null 2>&1; then
    as_root nft add table inet ombist_fw >/dev/null 2>&1 || true
    as_root nft add chain inet ombist_fw input "{ type filter hook input priority 0; policy accept; }" >/dev/null 2>&1 || true
    as_root nft add rule inet ombist_fw input tcp dport "${port}" ip saddr != 127.0.0.1 drop >/dev/null 2>&1 || true
    echo "nft"
    return 0
  fi
  echo "missing"
  return 1
}

# After ombot.service is up: WS loopback firewall, health-port ensure-internal, bind check.
# Expects: OMBOT_PORT, OMBOT_HEALTH_PORT, OMBOT_BIN_DIR; optional FW_WARNING (append).
# Sets: OMBIST_OMBOT_WS_BIND_OK, OMBIST_OMBOT_PORT_FW_MODE, OMBIST_HEALTH_PORT_FW_MODE
ombist_apply_ombot_network_isolation() {
  local port="${OMBOT_PORT:-8082}"
  local health_port="${OMBOT_HEALTH_PORT:-9090}"
  local bin_dir="${OMBOT_BIN_DIR:-}"

  OMBIST_OMBOT_PORT_FW_MODE="$(ombist_firewall_deny_non_loopback_tcp "${port}")"
  OMBIST_HEALTH_PORT_FW_MODE=""
  OMBIST_OMBOT_WS_BIND_OK="false"

  if [[ -x "${bin_dir}/ombot-admin" ]] && declare -F as_root >/dev/null 2>&1; then
    local hp_line hp_ok
    hp_line="$(as_root env OMBIST_HP="${health_port}" "${bin_dir}/ombot-admin" ombot health-port ensure-internal 2>/dev/null | tail -n1 || true)"
    hp_ok="false"
    if [[ "${hp_line}" == *'"ok":true'* ]] || [[ "${hp_line}" == *'"ok": true'* ]]; then
      hp_ok="true"
      OMBIST_HEALTH_PORT_FW_MODE="$(printf '%s' "${hp_line}" | sed -n 's/.*"mode":"\([^"]*\)".*/\1/p' | head -n1)"
    fi
    if [[ "${hp_ok}" != "true" ]]; then
      if [[ -n "${FW_WARNING:-}" ]]; then
        FW_WARNING="${FW_WARNING}; health_port_firewall_failed"
      else
        FW_WARNING="health_port_firewall_failed"
      fi
    fi
  else
    if [[ -n "${FW_WARNING:-}" ]]; then
      FW_WARNING="${FW_WARNING}; ombot_admin_missing"
    else
      FW_WARNING="ombot_admin_missing"
    fi
  fi

  if [[ "${OMBIST_OMBOT_PORT_FW_MODE}" == "missing" ]]; then
    if [[ -n "${FW_WARNING:-}" ]]; then
      FW_WARNING="${FW_WARNING}; ombot_port_firewall_tool_missing"
    else
      FW_WARNING="ombot_port_firewall_tool_missing"
    fi
  fi

  if declare -F as_root >/dev/null 2>&1; then
    local listen_row
    listen_row="$(as_root ss -ltn 2>/dev/null | awk -v p=":${port}\$" '\$4 ~ p {print; exit}' || true)"
    if [[ -n "${listen_row}" && "${listen_row}" == *"127.0.0.1:${port}"* ]]; then
      OMBIST_OMBOT_WS_BIND_OK="true"
    fi
  fi
}
