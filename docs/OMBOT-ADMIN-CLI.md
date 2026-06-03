# ombot-admin CLI (single-bot maintenance)

Installed to `/opt/ombot/bin/ombot-admin` with libraries under `/opt/ombot/bin/ombot-admin-lib/` by `tools/provision-single-bot.sh` (after cloning the Ombot repo).

## Requirements

- Linux host
- `sudo -n` (passwordless sudo) for subcommands that mutate TLS, firewall, or read `systemctl` as non-root
- `ombot-admin router install` is invoked **without** sudo by the iOS app so `${HOME}` is the SSH deploy user

## OmbRouter: official vs OMB (Ombist iOS)

- **Official / single-bot default**: use `ombot-admin router probe` and `ombot-admin router install` below (requires `ombot-admin` installed under `/opt/ombot/bin/`).
- **OMB mode**: Ombist iOS may run `scripts/ombist-remote-probe.sh` and `scripts/ombist-remote-install.sh` from an OmbRouter git checkout instead, so OmbRouter maintenance does not depend on `ombot-admin`. Same JSON envelope; see [OmbRouter/docs/ombist-remote-maintenance.md](../../OmbRouter/docs/ombist-remote-maintenance.md).

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

On failure: `ok: false` and `errors: [{ "code": "NO_SUDO", "message": "..." }]`. Common codes: `CLI_MISSING`, `NO_SUDO`, `NO_OPENSSL`, `NO_FIREWALL_TOOL`, `TLS_FAILED`, `NO_SYSTEMCTL`, `NO_NODE`, `MERGE_FAILED`, `AUTH_SYNC_FAILED`, `COMPOSE_LOCKED`, `STRICT_KEYS_VIOLATION`, `UNKNOWN_COMMAND`.

### `NO_NODE` (Node resolution)

Subcommands that run Node helpers (`route sync`, `openclaw compose`, `router probe`, `gateway config-drift`, `openai env apply`, etc.) resolve the Node binary via shared logic in `ombot-admin-lib/node-resolve.sh` (also mirrored in OmbRouter `scripts/ombist-remote-probe.sh` for OMB mode). Resolution order:

1. Standard PATH prefix (`/snap/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/ombot/npm-global/bin`, …)
2. `command -v node` / `command -v nodejs` (must pass `node -e 'process.exit(0)'`)
3. Fixed paths: `/snap/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, `/usr/bin/nodejs`, `/opt/ombot/npm-global/bin/node`
4. **Headless nvm**: `OMBOT_HOME` (default `/home/ombot`) → `~/.nvm/nvm.sh` + `nvm use 22`, or newest `~/.nvm/versions/node/*/bin/node`

If preflight reports `HAS_NODE=1` but a command still returns `NO_NODE`, update `/opt/ombot/bin/ombot-admin-lib/` from a current Ombot checkout (full reprovision or copy lib files). Non-login SSH often lacks nvm on PATH until this resolver runs.

## Commands

| Command | Purpose |
|--------|---------|
| `ombot-admin --version` | Version and capability list (`capabilities.openclaw_compose`, etc.) |
| `ombot-admin preflight --json` | OS / tools / network reachability probe |
| `ombot-admin tls rotate --pub-host <host> [--client-root-ca-sha256 <hex>] --json` | Regenerate `/etc/ombot/tls` and reload nginx if valid |
| `ombot-admin tls show --json` | Inspect current server cert / SAN |
| `ombot-admin systemctl monitor --json` | Two services: for each role, prefers **`ombist-ombot.service` / `ombist-openclaw-gateway.service`** when the matching file exists under **`/etc/systemd/system/`** (Ombist_IOS provision layout), else if `systemctl cat <unit>` succeeds, else falls back to **`ombot.service` / `openclaw-gateway@Ombist_IOS.service`** (manual/README install). `--no-pager` on `systemctl` calls. Same JSON shape as before. |
| `ombot-admin route sync --json` | Apply route payloads from env (`SYNC_OPENCLAW_PATCH_B64`, optional `SYNC_COST_CONFIG_JSON_B64` + `SYNC_COST_CONFIG_PATH`, optional `SYNC_OPENCLAW_AUTH_B64`) and restart gateway unit when present. **`SYNC_OPENCLAW_PATCH_TARGET`** controls OpenClaw patch application when a patch is present: **`merged`** deep-merges into the effective `openclaw.json`; **`fragment`** merges into `openclaw.d/40-route-sync-patch.json` then runs **`openclaw-compose`**. **When unset:** if `OPENCLAW_FRAGMENTS_DIR` (default `/etc/ombot/openclaw.d`) is a directory containing **`10-gateway-transport.json` or `20-gateway-security.json`** (headless fragment layout), the default is **`fragment`**; otherwise **`merged`**. Set `SYNC_OPENCLAW_PATCH_TARGET` explicitly to override. **Before** writing `40-route-sync-patch.json`, merged patch is validated/repaired; invalid patch → **`MERGE_FAILED`**. After merge/compose, runtime + `/etc/ombot/openclaw.json` + fragment are repaired again. When `didPatch=true`, success requires **`data.gatewayListening=true`** (loopback **`OPENCLAW_GATEWAY_PORT`**, default `18789`); otherwise **`ok:false`** with **`GATEWAY_NOT_READY`**. `data` also includes `gatewayRestart`, `openclawPatchTarget`, `openclawPatchTargetInferredFragment`. |
| `ombot-admin openclaw config repair-route --json` | One-shot recovery: optional restore from `openclaw.json.last-good`, repair all `openclaw.d/*.json` + runtime, `openclaw-compose`, restart gateway, wait for loopback port. Use when Gateway crash-loops after bad route-sync. |
| `ombot-admin tools install --json` | Refresh `/opt/ombot/bin/ombot-admin` + `ombot-admin-lib` from **`OMBOT_REPO_DIR`** (default `/opt/ombot/Ombot`) without full reprovision. |
| `ombot-admin openclaw config ensure-local --json` | Ensure `/etc/ombot/openclaw.json` has `gateway.mode=local` |
| `ombot-admin openclaw compose [--dry-run] [--rollback] [--strict-keys] [--no-flock] --json` | Merge **`OPENCLAW_FRAGMENTS_DIR`** (`*.json`, sorted) into **`OPENCLAW_RUNTIME_CONFIG_PATH`** (+ optional **`OPENCLAW_CONFIG_PATH`**); atomic write with **`.bak`** backup; optional lock under **`.compose.lock`**. **`--dry-run`** prints fragment SHA256s, `composedHash`, and whether runtime on-disk matches (secrets are not echoed in structured paths beyond existing redaction rules). **`--rollback`** restores from **`${OPENCLAW_RUNTIME_CONFIG_PATH}.bak`**. Exit codes: **`2`** = compose lock timeout (`COMPOSE_LOCKED`), **`3`** = **`STRICT_KEYS_VIOLATION`**. |
| `ombot-admin openai env apply --json` | Apply `OPENAI_API_KEY` / `OPENAI_BASE_URL` into `/etc/ombot/ombot.env` from env (`OMB_OPENAI_KEY`, `OMB_OPENAI_BASE_URL`) and restart gateway/ombot units. **Does not** read or write `openclaw.json` / `~ombot/.openclaw/openclaw.json`—agent `model` / `agents` live there and are updated by **`route sync`** (patch + optional `openclaw-compose`) or manual edits to fragments / runtime config. |
| `ombot-admin router probe --json` | Probe OmbRouter (official path; **OMB mode** may use OmbRouter `scripts/ombist-remote-probe.sh` instead). Env: `OMBIST_PROBE_PROXY_B64`, `OMBIST_MIN_VERSION_B64`. |
| `ombot-admin router install [--pinned-ref <sha>] --json` | Clone/build OmbRouter and `npm install -g .` (official path; **OMB mode** may use `scripts/ombist-remote-install.sh`). Best-effort gateway unit restart. |
| `ombot-admin ombot health-port ensure-internal --json` | Restrict Ombot `HEALTH_PORT` to localhost + tailnet |
| `ombot-admin gateway health-gates --json` | Evaluate Pairing / Scope / Provider gates from recent Ombot + Gateway logs (default window `10 min ago`) |
| `ombot-admin gateway config-drift --json` | Compare `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_BRIDGE_OPERATOR_SCOPES` across env/runtime/systemd sources; when **`OPENCLAW_FRAGMENTS_DIR`** is present, also merges **`ombist-openclaw-drift.mjs`** output (per-fragment SHA256, composed vs runtime hash, optional bridge agent id vs `agents.list`, optional **`llm_secret_env_and_auth_profiles_overlap`** warning). Drift codes may include `composed_runtime_vs_fragments_mismatch`, `bridge_agent_id_vs_agents_list`, `llm_secret_env_and_auth_profiles_overlap`. |
| `ombot-admin gateway loopback --json` | TCP probe of `OPENCLAW_GATEWAY_URL` (default `127.0.0.1:18789`), plus gateway systemd unit active state |
| `ombot-admin bot ensure-ready [--skip-route] --json` | **Golden path:** refresh `ombot-admin`, `openclaw config repair-route` (unless `--skip-route`), restart `ombist-openclaw-gateway` + `ombist-ombot`, wait for loopback gateway, verify `GET /readyz`. Optional config-drift warnings. Prefer this over ad-hoc repair + probe. |

### TLS version fingerprint (`rootCaSha256Hex`)

- **Definition**: lowercase hex SHA-256 of the **exact on-disk bytes** of `/etc/ombot/tls/RootCA.crt` (same bytes as `data.tls.rootCaPemBase64` after Base64 decode).
- **Response**: `tls rotate` and `tls show` include `data.tls.rootCaSha256Hex` when the Root CA file exists and hashing succeeds.
- **Request (optional)**: `tls rotate --client-root-ca-sha256 <64-char hex>` sends the app’s last-known fingerprint. If a Root CA file already exists on the server and the fingerprint **does not match**, the command still completes rotate but adds a warning: `{ "code": "CLIENT_ROOT_CA_MISMATCH", "message": "..." }` in the `warnings` array (for drift visibility; not a hard error).

## iOS integration

Ombist_IOS calls the above via SSH + a small bash stub (`OmbotAdminCli`). If `ombot-admin` is missing, the app shows an error asking the operator to run **single-bot full reprovision** once so the tool is installed from the Ombot git checkout.

After changing `systemctl monitor` behavior, machines must run an **`ombot-admin` copy that includes the update** (redeploy from a current Ombot checkout, or copy updated files under `/opt/ombot/bin/ombot-admin-lib/`) so **「檢查遠端服務」** reports `ombist-*` units instead of legacy names on iOS-provisioned hosts.

## Gateway stability workflow

When BOT is degraded after provision or route apply, run **`ombot-admin bot ensure-ready --json`** first.

When `NOT_PAIRED`, `missing scope: operator.write`, and provider 401 appear in mixed waves, run:

1. `ombot-admin gateway loopback --json` when users see `gateway_error: connect ECONNREFUSED 127.0.0.1:18789` (port not listening).
2. `ombot-admin gateway health-gates --json` to detect which gate is currently failing.
3. `ombot-admin gateway config-drift --json` to catch token/scope drift among `/etc/ombot/ombot.env`, runtime `openclaw.json`, `systemctl` env, and (when fragments are used) composed-config vs on-disk drift from `openclaw.d`.
3. `tools/gateway-stability-runbook.sh fallback-on` to print reversible fallback env commands (provider direct fallback while gateway write path is degraded).

First-time single-bot provision still emits the legacy `PROVISION_SUMMARY_*` / `ROOTCA_PEM_B64_*` markers for the bundled `provision-single-bot.sh` path.
