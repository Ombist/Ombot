# BOT ready (golden path)

Use one command to confirm or restore a Linux SSH-provisioned host:

```bash
ombot-admin bot ensure-ready --json
```

## What it does

1. Requires Node.js **>= 22** on PATH
2. `tools install` — refresh `/opt/ombot/bin/ombot-admin`
3. `openclaw config repair-route` — compose fragments, restart gateway, wait for **127.0.0.1:18789** (unless `--skip-route`)
4. Restart `ombist-openclaw-gateway.service` and `ombist-ombot.service`
5. `curl http://127.0.0.1:${HEALTH_PORT:-9090}/readyz` — must return `"ready": true`

## Acceptance (operator)

```bash
node -v
ombot-admin bot ensure-ready --json
curl -fsS http://127.0.0.1:9090/readyz
ss -lntp | grep 18789
systemctl is-active ombist-openclaw-gateway ombist-ombot
```

## Exit / error codes (envelope `errors[].code`)

| Code | Meaning |
|------|---------|
| `NO_NODE` | Node not on PATH |
| `NODE_TOO_OLD` | Node major < 22 |
| `CLI_MISSING` | `/opt/ombot/Ombot` missing |
| `UNIT_MISSING` | systemd units not installed — run full provision |
| `TOOLS_INSTALL_FAILED` | Could not refresh ombot-admin |
| `REPAIR_ROUTE_FAILED` | OpenClaw repair-route failed |
| `GATEWAY_NOT_READY` | Port 18789 not listening |
| `OMBOT_NOT_READY` | `/readyz` not ready |

Provision scripts exit **14** when Node 22 cannot be installed; **28** when `openclaw-compose` fails; **29** when gateway agent merge fails.

## Legacy commands (still available)

| Instead of | Use |
|------------|-----|
| `tools install` + `repair-route` + manual restart + probe | `bot ensure-ready` |
| `scripts/ombist-post-upgrade-recover.sh` | same (script now execs `bot ensure-ready`) |
| iOS repair + health probe after route sync | `ensureBotReadyOnServer` → `bot ensure-ready` |

## OpenClaw 不回覆 / `runtime_missing` / compose 失败（ProtectHome）

`ombist-ombot.service` 使用 **`ProtectHome=true`**。若 **`OPENCLAW_RUNTIME_CONFIG_PATH`** 指向 `~ombot/.openclaw/openclaw.json`，在沙箱内 `existsSync` 常为 **false**，自愈 compose 报 `runtime not writable` / `runtime_missing`，Gateway 被判定未就绪，chat 只收到 `status: accepted` 而无正文。

**默认（新佈署）**：runtime 写在 **`/var/lib/ombot/openclaw.json`**（与 `OPENCLAW_DATA_DIR` 同目录，已在 `ReadWritePaths`）。`ombot.env` 与 `run-openclaw-gateway.sh` 使用同一 `OPENCLAW_RUNTIME_CONFIG_PATH`。

已有主机迁移：

```bash
grep OPENCLAW_RUNTIME_CONFIG_PATH /etc/ombot/ombot.env
sudo -u ombot test -r /var/lib/ombot/openclaw.json && echo ok
ombot-admin openclaw compose --json
sudo systemctl restart ombist-openclaw-gateway ombist-ombot
```

Agent 会话与 `auth-profiles.json` 仍在 `~ombot/.openclaw/agents/`（`ReadWritePaths` 保留该目录）。

## Gateway 401 `not authorized` (LKEAP / custom OpenAI-compatible)

OpenClaw reads **`auth-profiles.json` first**. If `"key"` is an HTTP URL (e.g. `https://api.lkeap.cloud.tencent.com/plan/v3`) instead of `sk-…`, the Gateway sends that URL as the Bearer token → **401**, not a model error.

| Field | Correct |
|-------|---------|
| `auth-profiles.json` → `profiles["<provider>:default"].key` | API secret (`sk-tp-…`) |
| Route **API base URL** / `OPENAI_BASE_URL` | `https://api.lkeap.cloud.tencent.com/plan/v3` |

Check:

```bash
sudo -u ombot jq '.profiles' ~ombot/.openclaw/agents/main/agent/auth-profiles.json
ombot-admin gateway config-drift --json   # drift may include auth_profile_key_is_http_url
```

Fix the key in App「代理路由設定」or edit the file, then `ombot-admin bot ensure-ready --json`.

## Diagnostics after ensure-ready fails

```bash
ombot-admin gateway loopback --json
ombot-admin gateway health-gates --json
ombot-admin gateway config-drift --json
journalctl -u ombist-openclaw-gateway -n 80 --no-pager
```
