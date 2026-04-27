# Ombot

WebSocket relay with ED25519. Sits between the client app and the Middleware.

**Architecture:**  
`Client App <-> Ombot (this, 0.0.0.0:8080) <-> Middleware <-> Phone`

同一台 BOT 可有多個 **Agent**，每個 Agent 在 WS 中為獨立「App」身份（各自金鑰與 Chatroom）。

---

## 與 OpenClaw 對接（同 BOT、多 Agent）

### 1. 如何定義「不同的 App」？

- **一個 App = 一個 Agent 身份**，用 **`agentId`**（或 `appId`）字串區分。
- 例如：`agent-1`、`support`、`assistant` 代表同一台 BOT 上的三種身份。
- 連線時在註冊訊息裡帶上 `agentId`，Machine 會把金鑰與對話存到 `data/agents/<agentId>/chatrooms/`，不同 Agent 互不共用。

### 2. 如何對接（同一 BOT、不同 Agent）？

**從 ClawChat（手機）**

- 同一台機器 = 同一組 host/port。
- 要跟「哪一個 Agent」講話：在該對話的連線設定裡填 **Agent ID**（選填）。
  - 不填或填 `default` = 預設 Agent。
  - 填 `support`、`agent-1` 等 = 對應到該 BOT 上的那個 Agent。
- 不同對話可設不同 Agent ID，就能和同 BOT 的不同 Agent 分別溝通。

**從 OpenClaw 或自建客戶端（本機 / 同網）**

1. 連到 Ombot（Machine 端）的 WS：本機／內網常見 `ws://<host>:8080/ws`（或直連 BOT 的 IP:port）；若對外終止 TLS 則用 `wss://…`。**連到 Ombers（Middleware）** 的生產預設為 **`wss://`**（見下方 `MIDDLEWARE_WS_URL`）。
2. 連上後送 **註冊**（金鑰交換），例如：

```json
{
  "type": "register_public_key",
  "publicKey": "<Ed25519 公鑰 hex，直連時可選>",
  "boxPublicKey": "<Box 公鑰 base64，E2E 必填>",
  "agentId": "support",
  "conversationId": "conv-001"
}
```

3. **`agentId`**：代表你要用／要對應的「哪一個 App（Agent）」；不送則為 `default`。
4. **`conversationId`**：代表該 Agent 底下的「哪一間 Chatroom」；不送則為 `default`。
5. Machine 回傳 `peer_public_key` 後，之後的應用層訊息用 Box 加密成 `{ type: 'encrypted', nonce, payload }` 傳送。

### 3. 可以自己建立 Chatroom 嗎？

**可以。** 每個 Agent 都可以有自己的多個 Chatroom。

- **Chatroom 的識別** = `(agentId, conversationId)`。
- **建立方式**：對某個 `agentId` 用一個**新的 `conversationId`** 送一次 `register_public_key`，Machine 就會為該 Agent 建立並維護這間 Chatroom（產生／載入金鑰、存對方公鑰）。
- 例如：
  - Agent `support` 的 Chatroom：`conversationId` 用 `user-alice`、`user-bob`。
  - Agent `assistant` 的 Chatroom：`conversationId` 用 `room-1`、`room-2`。
- 規律：**同一個 agentId + 新的 conversationId = 一間新的 Chatroom**，可自由命名或用 UUID。

### 4. 流程整理

| 角色 | 要做的事 |
|------|----------|
| **ClawChat** | 同一 BOT 不同 Agent：同一 host/port，不同對話設不同「Agent ID」；每個對話的 conversationId 由 App 管理。 |
| **OpenClaw / 自建客戶端** | 連上 WS → 送 `register_public_key` 帶 `agentId` + `conversationId` + `boxPublicKey` → 收 `peer_public_key` → 之後用 Box 加密通訊。要新 Chatroom 就換一個 `conversationId`（同 agentId 或換 agentId 皆可）。 |
| **Machine** | 依 `(agentId, conversationId)` 載入或建立金鑰，存於 `data/agents/<agentId>/chatrooms/<conversationId>.json`。 |

---

## Setup

```bash
cd Ombot
npm install
```

## Production (run as `ombot`)

先建立專用帳號 `ombot`，並只給 `Ombot` 服務需要的檔案權限：

```bash
# 1) 建立 system user/group（不可登入）
sudo useradd --system --create-home --home-dir /home/ombot --shell /usr/sbin/nologin ombot

# 2) 部署目錄（示例）
sudo mkdir -p /opt/ombot
sudo cp -R ./Ombot /opt/ombot/Ombot

# 3) 建立資料目錄（chatroom keys）
sudo mkdir -p /var/lib/ombot

# 4) 權限交給 ombot
sudo chown -R ombot:ombot /opt/ombot/Ombot /var/lib/ombot
sudo chmod 750 /opt/ombot/Ombot /var/lib/ombot
```

安裝並啟用 `systemd`（使用 repo 內 `ombot.service`）：

```bash
sudo cp /opt/ombot/Ombot/ombot.service /etc/systemd/system/ombot.service
sudo systemctl daemon-reload
sudo systemctl enable --now ombot.service
sudo systemctl status ombot.service
```

建立 `/etc/ombot/ombot.env`（權限 `600`）管理 secrets，避免明文散落：

```bash
sudo mkdir -p /etc/ombot
sudo sh -c 'cat > /etc/ombot/ombot.env <<EOF
OPENCLAW_MACHINE_SEED=replace-with-strong-seed
OPENCLAW_KEY_ENCRYPTION_KEYS=base64-32-byte-key-current,base64-32-byte-key-previous
OPENCLAW_MAX_MESSAGE_BYTES=16384
OPENCLAW_MAX_MSGS_PER_MINUTE=120
OPENCLAW_SHUTDOWN_TIMEOUT_MS=15000
EOF'
sudo chmod 600 /etc/ombot/ombot.env
```

### Generate Data Encryption Key

```bash
openssl rand -base64 32
```

`OPENCLAW_KEY_ENCRYPTION_KEYS` 使用「新鑰,舊鑰」順序。輪替時先把新鑰放前面，再執行：

```bash
npm run rotate:data-key
```

## Run

```bash
npm start
# or (defaults match index.js: wss + TLS required)
PORT=8080 MIDDLEWARE_WS_URL=wss://127.0.0.1:8081/ws OPENCLAW_MACHINE_SEED=my-secret node index.js
```

### 本機開發（Ombers 僅 plain `ws`、無 TLS）

僅限 **127.0.0.1 / 受信網路**。須同時關閉對 Middleware 的 TLS 強制，否則程序會以 `middleware_tls_required` 退出：

```bash
PORT=8080 MIDDLEWARE_WS_URL=ws://127.0.0.1:8081/ws OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0 OPENCLAW_MACHINE_SEED=my-secret node index.js
```

## Headless 佈署（Ombist iOS SSH，嚴格 18789 封鎖）

[tools/provision-headless.sh](tools/provision-headless.sh) 供 Ombist iOS「新增機器」經 SSH 在非互動環境安裝 **nvm + Node 22**、`openclaw@latest`、clone 本 repo，並切到 **system-level + ombot service user**：

- OpenClaw 設定寫入 `/etc/ombot/openclaw.json`（`gateway.bind: loopback`，僅 `127.0.0.1:18789`）。
- Ombot 環境寫入 `/etc/ombot/ombot.env`。
- 建立 `systemd` 單元：`ombist-openclaw-gateway.service`、`ombist-ombot.service`（皆以 `User=ombot` 執行）。
- 嘗試啟用主機防火牆（`ufw` / `iptables` / `nft`）封鎖外部入站 `tcp/18789`；若缺少工具，摘要會回 `warning=firewall_tool_missing`（降級安全模式）。
- 腳本會輸出 `PROVISION_SUMMARY_BEGIN/END` 區段，含 `gateway_bind_ok`、service 狀態、`firewall_mode`，供 iOS 顯示成功或警告。

必要環境變數：`RELAY_HOST`、`MACHINE_PORT`、`OPENCLAW_MACHINE_SEED`；可選 **`MIDDLEWARE_SCHEME`**（預設 **`wss`**；舊環境若 Ombers 前無 TLS，須明確設 `MIDDLEWARE_SCHEME=ws` 並確保 `OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0`）、`OMBOT_GIT_URL`、`MIDDLEWARE_AUTH_TOKEN`、`OPENCLAW_GATEWAY_TOKEN`。僅支援 **Linux**，且需 root 或 passwordless sudo。生產路徑請在 Ombers **MACHINE** 對外埠上 TLS（Nginx 終止或 `OMBERS_USE_TLS`），否則 `wss://` 無法握手。

## OpenClaw Gateway 橋接（可選，與 Ombot 同進程）

若要在**沒有**本機 ClawChat 客戶端連 `/ws` 的情況下，讓 **Phone（經 Ombers）↔ NaCl box** 與 **本機 OpenClaw Gateway（`127.0.0.1:18789`）** 互通，可啟用內建橋接模組：

1. 確保 `ombist-openclaw-gateway.service` 已啟動且 Gateway 可連（預設 `ws://127.0.0.1:18789`）。
2. 在 `/etc/ombot/ombot.env`（或 systemd `Environment=`）設定 **`OPENCLAW_GATEWAY_BRIDGE=1`**，並設定與手機端對話一致的 **`OPENCLAW_BRIDGE_AGENT_ID`**、`**OPENCLAW_BRIDGE_CONVERSATION_ID**`、`**OPENCLAW_BRIDGE_PARTICIPANT_ID**`（須與 App 內該對話的 `agentId` / `conversationId` / `participantId` 一致，否則 `sessionKey` 不同無法配對 Ombers）。
3. 若 Gateway 啟用 token，設定 **`OPENCLAW_GATEWAY_TOKEN`**（與 `openclaw.json` / Gateway 設定一致）。

行為摘要：Ombot 以 bridge 模式連上 Middleware；Phone 完成 box 握手後，解密得到的 `type: "req"` / `method: "agent"` / `params.message` 會轉成 Gateway 的 `req`（預設 `method` 為 `agent`，可由 `OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD` 覆寫）；每輪會帶 **`idempotencyKey`** 與 **`agentId`**（固定為 **`OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID`**；未設時等同 **`OPENCLAW_BRIDGE_AGENT_ID`**，預設 `default`）。`connect` 會送 **`scopes`**，預設 `operator.read` + `operator.write`，可經 `OPENCLAW_BRIDGE_OPERATOR_SCOPES` 覆寫為 JSON 陣列。預先於 `openclaw.json` 的 **`agents.list`** 為各 `agentId` 設定 model，無需在請求內覆寫 `provider`/`model`。Gateway 回傳的 `res` / `event` 會盡力抽出文字再以 `type: "res"` 加密回 Phone。**OpenClaw Gateway 協定版本差異**時請對照官方文件並鎖定 `openclaw` 版本；`connect.challenge` / device pairing 等進階流程可能需後續擴充。

Prometheus：`ombot_gateway_bridge_connected`、`ombot_gateway_bridge_errors_total`、`ombot_gateway_bridge_phone_to_gateway_total`、`ombot_gateway_bridge_gateway_to_phone_total`。

## Health and Metrics

- Health: `GET /healthz` on `HEALTH_PORT`
- Readiness: `GET /readyz` on `HEALTH_PORT`
- Prometheus metrics: `GET /metrics` on `HEALTH_PORT`

## Env

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | 8080 | WS server listen port |
| `HEALTH_PORT` | `PORT+1` | HTTP health/metrics port |
| `MIDDLEWARE_WS_URL` | wss://127.0.0.1:8081/ws | Middleware **基底**（須以 `/ws` 結尾）；多路時會再連線至 `…/ws/<sessionKey>` |
| `MIDDLEWARE_AUTH_TOKEN` | (empty) | 連到 Middleware 時的 Bearer token（優先走 `Authorization` header；失敗時可退回 query token） |
| `MIDDLEWARE_TLS_CLIENT_CERT_PATH` | (empty) | 若 ingress 要求 **mTLS**：指向 **client** 憑證 PEM（與 key 成對設定；見 monorepo `Ombers_Communicator/docs/nginx-mtls-ingress.md`） |
| `MIDDLEWARE_TLS_CLIENT_KEY_PATH` | (empty) | 若 ingress 要求 **mTLS**：指向 **client** 私鑰 PEM（檔案權限建議 `0400`，由 systemd `EnvironmentFile` 注入路徑） |
| `MIDDLEWARE_TLS_CA_PATH` | (empty) | 選用；額外信任的 **server** CA bundle（例如內部 CA；未設時使用 Node 預設 trust store 驗證伺服器鏈） |
| `OPENCLAW_MACHINE_SEED` | ombot-seed | Seed for server ED25519 key pair |
| `OPENCLAW_DATA_DIR` | ./data | 金鑰與 Chatroom 儲存目錄 |
| `OPENCLAW_KEY_ENCRYPTION_KEYS` | (empty) | Base64 32-byte keys, comma separated (`new,old`) for at-rest encryption |
| `OPENCLAW_MAX_MESSAGE_BYTES` | 16384 | Maximum inbound WS frame size |
| `OPENCLAW_MAX_MSGS_PER_MINUTE` | 120 | Per-client protocol message rate limit |
| `OPENCLAW_SHUTDOWN_TIMEOUT_MS` | 15000 | Graceful shutdown timeout |
| `OPENCLAW_AUDIT_LOG` | `<OPENCLAW_DATA_DIR>/audit.log` | Audit log file path |
| `OPENCLAW_REQUIRE_MIDDLEWARE_TLS` | `1` | Require `MIDDLEWARE_WS_URL` to use `wss://` |
| `OPENCLAW_PROTOCOL_VERSION` | `2` | Server protocol version advertised to clients |
| `OPENCLAW_MIN_PROTOCOL_VERSION` | `2` | Minimum supported client protocol version |
| `OPENCLAW_ALLOW_LEGACY_PROTOCOL` | `0` | Whether clients below server protocol are allowed |
| `OPENCLAW_REQUIRED_CAPABILITIES` | `signature,replay_guard` | Comma-separated client capabilities required at register time |
| `OPENCLAW_GATEWAY_BRIDGE` | (unset / off) | Set `1` or `true` to enable in-process OpenClaw Gateway WebSocket client bridge |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL for the bridge |
| `OPENCLAW_GATEWAY_TOKEN` | (empty) | Optional; sent as `connect.params.auth.token` |
| `OPENCLAW_BRIDGE_AGENT_ID` | `default` | Must match Phone conversation `agentId` for sessionKey |
| `OPENCLAW_BRIDGE_CONVERSATION_ID` | `default` | Must match Phone `conversationId` |
| `OPENCLAW_BRIDGE_PARTICIPANT_ID` | `default` | Must match Phone `participantId` |
| `OPENCLAW_BRIDGE_PHONE_METHOD` | `agent` | Phone `req.method` that carries user text |
| `OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD` | `agent` | Gateway `req.method` for a model turn |
| `OPENCLAW_BRIDGE_MIN_PROTOCOL` / `MAX_PROTOCOL` | `1` / `9` | Passed in `connect` params |
| `OPENCLAW_BRIDGE_ROLE` | `operator` | `connect.params.role` |
| `OPENCLAW_BRIDGE_OPERATOR_SCOPES` | (empty → `["operator.read","operator.write"]`) | JSON array of operator scopes on `connect` |
| `OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID` | same as `OPENCLAW_BRIDGE_AGENT_ID` | Gateway `agent` params `agentId` on each turn |
| `OPENCLAW_BRIDGE_REQ_TIMEOUT_MS` | `120000` | Per-turn timeout waiting for Gateway `res` |

中繼 Nginx（WSS / mTLS）整體準備與切換：[docs/relay-nginx-mtls-prep.md](../docs/relay-nginx-mtls-prep.md)（含 PKI、staging、`optional`→`on`、iOS 決策與 rollback）。

## Protocol

- Listens on `0.0.0.0:PORT/ws`.
- **App 直連（本地 OpenClaw）**：送 `{ type: 'register_public_key', publicKey: '<hex>', protocolVersion, capabilities }`；server 回 `{ type: 'registered', serverPublicKey: '<hex>', protocolVersion, capabilities }`。
- **經 Middleware（Phone E2E）**：Phone 與 Machine 須連到同一 **Middleware session**（URL `…/ws/<sessionKey>`，`sessionKey` 由 `agentId` + `conversationId` 算出；若帶 `participantId`，則改為三元組計算）。本地 OpenClaw 客戶端在 `register_public_key` 應帶 **`conversationId`**（及選填 `agentId`、`participantId`），Machine 才能連上對應 tunnel。Phone 送 `register_public_key` 含 `boxPublicKey` 等；Machine 回 `peer_public_key`；之後訊息以 `encrypted` 格式加解密。若客戶端未帶 `conversationId`／`chatroomId`，Machine 仍連 **legacy** `…/ws`（單對單）。
- App 送 `{ type: 'req', id, method: 'agent', protocolVersion, capabilities, params: { message, clientMessageId }, timestamp, nonce, signature }`；server 驗證後轉發。

## CI Quality Gates and Merge Policy

Required checks before merge:

1. `npm run ci:quality` must pass (`lint + test + verify-session-key`)
2. `npm run security:audit` must pass (no high/critical vulnerabilities)
3. SBOM must be generated (`npm run sbom`)
4. Container image scan (Trivy) must pass in CI

Policy: PRs with failed required checks are blocked from merge.

## SLO / Incident Targets

- Availability target: `99.95%` monthly
- Alerting thresholds:
  - `ombot_middleware_disconnects_total` sudden spike
  - `ombot_relay_errors_total` sustained increase
- Operational targets:
  - MTTD < 5 minutes
  - MTTR < 30 minutes

## Deploy and Rollback

```bash
# First time only
chmod +x tools/deploy.sh tools/rollback.sh

# Deploy current tree as new release
sudo ./tools/deploy.sh

# Roll back to previous release
sudo ./tools/rollback.sh
```

## GameDay Scenarios

Run quarterly drills:

1. Middleware disconnect storm
2. Disk full on `OPENCLAW_DATA_DIR`
3. Corrupted key file under `data/agents/*/chatrooms/*.json`
4. High concurrency message burst
