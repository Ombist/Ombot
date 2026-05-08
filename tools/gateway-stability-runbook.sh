#!/usr/bin/env bash
set -euo pipefail

OMBOT_ADMIN_BIN="${OMBOT_ADMIN_BIN:-/opt/ombot/bin/ombot-admin}"

usage() {
  cat <<'EOF'
Usage:
  gateway-stability-runbook.sh diagnose
  gateway-stability-runbook.sh fallback-on
  gateway-stability-runbook.sh fallback-off

Commands:
  diagnose     Run health-gates + config-drift diagnostics (read-only)
  fallback-on  Print env patch for provider fallback route
  fallback-off Print rollback env patch for primary route
EOF
}

diagnose() {
  echo "# 1) system units"
  "${OMBOT_ADMIN_BIN}" systemctl monitor --json || true
  echo
  echo "# 2) gate health"
  "${OMBOT_ADMIN_BIN}" gateway health-gates --json || true
  echo
  echo "# 3) config drift"
  "${OMBOT_ADMIN_BIN}" gateway config-drift --json || true
}

fallback_on() {
  cat <<'EOF'
# Enable auto provider fallback (recommended for write-scope incidents)
sudo tee /etc/systemd/system/ombist-ombot.service.d/20-fallback.conf >/dev/null <<'EOC'
[Service]
Environment="OPENCLAW_BRIDGE_AUTO_FALLBACK=1"
Environment="OPENCLAW_FALLBACK_OPENAI_MODEL=gpt-4.1-mini"
EOC
sudo systemctl daemon-reload
sudo systemctl restart ombist-ombot.service
EOF
}

fallback_off() {
  cat <<'EOF'
# Disable auto provider fallback (back to primary gateway-only path)
sudo rm -f /etc/systemd/system/ombist-ombot.service.d/20-fallback.conf
sudo systemctl daemon-reload
sudo systemctl restart ombist-ombot.service
EOF
}

main() {
  local cmd="${1:-}"
  case "${cmd}" in
    diagnose) diagnose ;;
    fallback-on) fallback_on ;;
    fallback-off) fallback_off ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
