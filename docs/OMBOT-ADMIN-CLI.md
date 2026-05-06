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
| `ombot-admin tls rotate --pub-host <host> [--client-root-ca-sha256 <hex>] --json` | Regenerate `/etc/ombot/tls` and reload nginx if valid |
| `ombot-admin tls show --json` | Inspect current server cert / SAN |
| `ombot-admin systemctl monitor --json` | Two services: for each role, uses **`ombist-ombot.service` / `ombist-openclaw-gateway.service`** when that unit appears in `systemctl list-unit-files`, otherwise falls back to **`ombot.service` / `openclaw-gateway@Ombist_IOS.service`** (manual/README install). Same JSON shape as before. |
| `ombot-admin ombrouter install [--pinned-ref <sha>] --json` | Clone/build OmbRouter and `openclaw plugins install` |
| `ombot-admin ombot health-port ensure-internal --json` | Restrict Ombot `HEALTH_PORT` to localhost + tailnet |

### TLS version fingerprint (`rootCaSha256Hex`)

- **Definition**: lowercase hex SHA-256 of the **exact on-disk bytes** of `/etc/ombot/tls/RootCA.crt` (same bytes as `data.tls.rootCaPemBase64` after Base64 decode).
- **Response**: `tls rotate` and `tls show` include `data.tls.rootCaSha256Hex` when the Root CA file exists and hashing succeeds.
- **Request (optional)**: `tls rotate --client-root-ca-sha256 <64-char hex>` sends the app’s last-known fingerprint. If a Root CA file already exists on the server and the fingerprint **does not match**, the command still completes rotate but adds a warning: `{ "code": "CLIENT_ROOT_CA_MISMATCH", "message": "..." }` in the `warnings` array (for drift visibility; not a hard error).

## iOS integration

Ombist_IOS calls the above via SSH + a small bash stub (`OmbotAdminCli`). If `ombot-admin` is missing, the app shows an error asking the operator to run **single-bot full reprovision** once so the tool is installed from the Ombot git checkout.

After changing `systemctl monitor` behavior, machines must run an **`ombot-admin` copy that includes the update** (redeploy from a current Ombot checkout, or copy updated files under `/opt/ombot/bin/ombot-admin-lib/`) so **「檢查遠端服務」** reports `ombist-*` units instead of legacy names on iOS-provisioned hosts.

First-time single-bot provision still emits the legacy `PROVISION_SUMMARY_*` / `ROOTCA_PEM_B64_*` markers for the bundled `provision-single-bot.sh` path.
