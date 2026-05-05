# ombot-admin CLI (single-bot maintenance)

Installed to `/opt/ombot/bin/ombot-admin` with libraries under `/opt/ombot/bin/ombot-admin-lib/` by `tools/provision-single-bot.sh` (after cloning the Ombot repo).

## Requirements

- Linux host
- `sudo -n` (passwordless sudo) for subcommands that mutate TLS, firewall, or read `systemctl` as non-root
- `ombrouter install` is invoked **without** sudo by the iOS app so `${HOME}` is the SSH deploy user

## Output contract

Every invocation prints **one JSON object** to stdout (no `PROVISION_SUMMARY_*` markers). Shape:

```json
{
  "ok": true,
  "mode": "single_bot_tls_rotate",
  "summary": "human readable",
  "data": { },
  "warnings": [],
  "errors": []
}
```

On failure: `ok: false` and `errors: [{ "code": "NO_SUDO", "message": "..." }]`. Common codes: `CLI_MISSING`, `NO_SUDO`, `NO_OPENSSL`, `NO_FIREWALL_TOOL`, `TLS_FAILED`, `NO_SYSTEMCTL`.

## Commands

| Command | Purpose |
|--------|---------|
| `ombot-admin --version` | Version and capability list |
| `ombot-admin preflight --json` | OS / tools / network reachability probe |
| `ombot-admin tls rotate --pub-host <host> --json` | Regenerate `/etc/ombot/tls` and reload nginx if valid |
| `ombot-admin tls show --json` | Inspect current server cert / SAN |
| `ombot-admin systemctl monitor --json` | `ombot.service` + `openclaw-gateway@Ombist_IOS.service` status JSON |
| `ombot-admin ombrouter install [--pinned-ref <sha>] --json` | Clone/build OmbRouter and `openclaw plugins install` |
| `ombot-admin ombot health-port ensure-internal --json` | Restrict Ombot `HEALTH_PORT` to localhost + tailnet |

## iOS integration

Ombist_IOS calls the above via SSH + a small bash stub (`OmbotAdminCli`). If `ombot-admin` is missing, the app shows an error asking the operator to run **single-bot full reprovision** once so the tool is installed from the Ombot git checkout.

First-time single-bot provision still emits the legacy `PROVISION_SUMMARY_*` / `ROOTCA_PEM_B64_*` markers for the bundled `provision-single-bot.sh` path.
