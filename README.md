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

- **分域設定與單一有效檔**：佈署在 **`OPENCLAW_FRAGMENTS_DIR`**（預設 `/etc/ombot/openclaw.d`）建立排序後合併的 JSON 片段（例如 `10-gateway-transport.json`、`20-gateway-security.json`），由 **`tools/openclaw-compose.mjs`** 決定性 deep-merge（含 `plugins` 的 id 級合併）寫入 **`OPENCLAW_RUNTIME_CONFIG_PATH`**（預設 **`/var/lib/ombot/openclaw.json`**，供 `ProtectHome=true` 的 ombot 行程讀寫），並複製到 **`OPENCLAW_CONFIG_PATH`**（`/etc/ombot/openclaw.json`）。Gateway wrapper 將 **`OPENCLAW_CONFIG_PATH` 指到 runtime 檔**，行程仍只讀一份有效 JSON。**`tools/ensure-openclaw-gateway-agent.mjs`** 在有片段目錄時只更新 **`30-ombist-gateway-agent.json`**（`agents`）並再執行 compose，不直接改最終檔。
- **秘密與設定面**：Loopback Gateway token 等放在 **`20-gateway-security.json`** 片段（佈署時生成）；LLM 供應商金鑰優先經 **`ombot-admin route sync`** 的 `SYNC_OPENCLAW_AUTH_B64` 寫入 **`~/.openclaw/agents/<id>/agent/auth-profiles.json`**（不進 `openclaw.json`）；`OPENAI_*` 等亦可落在 **`ombot.env`**（**`ombot-admin openai env apply` 只改 `ombot.env`，不會改寫 runtime `openclaw.json`**；代理 **model** 仍由 `route sync` 的 agents patch 或片段／compose 決定）。同一 provider **建議只選一種落地**（auth-profile **或** env），避免雙份；`ombot-admin gateway config-drift` 可回報片段 hash、合成 hash 與磁碟是否一致、以及 env 與 auth profile 重疊等警告。
- Ombot 環境寫入 `/etc/ombot/ombot.env`（含 `OPENCLAW_FRAGMENTS_DIR` 等）。
- 建立 `systemd` 單元：`ombist-openclaw-gateway.service`、`ombist-ombot.service`（皆以 `User=ombot` 執行）。
- **BOT 網路隔離（與單 bot 對齊）**：`/etc/ombot/ombot.env` 寫入 **`OPENCLAW_WS_LISTEN_HOST=127.0.0.1`**（`/ws` 不對公網監聽；iOS 仍經 Ombers，不在 BOT 機上加 Nginx）。佈署會安裝 **`ombot-admin`**，對 **`PORT`（預設 8082）** 套用非 loopback 入站拒絕，並執行 **`ombot-admin ombot health-port ensure-internal`**（`HEALTH_PORT` 預設 9090：僅 localhost + Tailscale tailnet，拒絕公網）。
- 嘗試啟用主機防火牆（`ufw` / `iptables` / `nft`）封鎖外部入站 `tcp/18789`；若缺少工具，摘要會回 `warning=firewall_tool_missing`（降級安全模式）。
- 腳本會輸出 `PROVISION_SUMMARY_BEGIN/END` 區段，含 `gateway_bind_ok`、`ombot_ws_bind_ok`、`ombot_port_firewall_mode`、`health_port_firewall_mode`、service 狀態、`firewall_mode`，供 iOS 顯示成功或警告。
- 若修改核心佈署腳本，建議先跑 `tools/check-provision-sync.sh`，確認 `Ombot/tools` 與 `Ombist_IOS/Resources` 兩份核心腳本保持同步。

必要環境變數：`RELAY_HOST`、`MACHINE_PORT`、`OPENCLAW_MACHINE_SEED`；可選 **`MIDDLEWARE_SCHEME`**（預設 **`wss`**；舊環境若 Ombers 前無 TLS，須明確設 `MIDDLEWARE_SCHEME=ws` 並確保 `OPENCLAW_REQUIRE_MIDDLEWARE_TLS=0`）、`OMBOT_GIT_URL`、`MIDDLEWARE_AUTH_TOKEN`、`OPENCLAW_GATEWAY_TOKEN`。僅支援 **Linux**，且需 root 或 passwordless sudo。生產路徑請在 Ombers **MACHINE** 對外埠上 TLS（Nginx 終止或 `OMBERS_USE_TLS`），否則 `wss://` 無法握手。

## OpenClaw Gateway 橋接（可選，與 Ombot 同進程）

若要在**沒有**本機 ClawChat 客戶端連 `/ws` 的情況下，讓 **Phone（經 Ombers）↔ NaCl box** 與 **本機 OpenClaw Gateway（`127.0.0.1:18789`）** 互通，可啟用內建橋接模組：

1. 確保 `ombist-openclaw-gateway.service` 已啟動且 Gateway 可連（預設 `ws://127.0.0.1:18789`）。
2. 在 `/etc/ombot/ombot.env`（或 systemd `Environment=`）設定 **`OPENCLAW_GATEWAY_BRIDGE=1`**，並設定與手機端對話一致的 **`OPENCLAW_BRIDGE_AGENT_ID`**、`**OPENCLAW_BRIDGE_CONVERSATION_ID**`、`**OPENCLAW_BRIDGE_PARTICIPANT_ID**`（須與 App 內該對話的 `agentId` / `conversationId` / `participantId` 一致，否則 `sessionKey` 不同無法配對 Ombers）。
3. 若 Gateway 啟用 token，設定 **`OPENCLAW_GATEWAY_TOKEN`**（與 `openclaw.json` / Gateway 設定一致）。

行為摘要：Ombot 以 bridge 模式連上 Middleware；Phone 完成 box 握手後，解密得到的 `type: "req"` / `method: "agent"` / `params.message` 會轉成 Gateway 的 `req`（預設 `method` 為 `agent`，可由 `OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD` 覆寫）；每輪會帶 **`idempotencyKey`**、**`agentId`**（固定為 **`OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID`**；未設時等同 **`OPENCLAW_BRIDGE_AGENT_ID`**，預設 `default`）。**`scopes` 僅在 `connect` 送出**；若舊版 Gateway 仍要求每輪 `agent.params.scopes`，可設 **`OPENCLAW_BRIDGE_AGENT_INCLUDE_SCOPES=1`**。`connect` 的 **`scopes`** 可經 `OPENCLAW_BRIDGE_OPERATOR_SCOPES` 覆寫為 JSON 陣列。預先於 `openclaw.json` 的 **`agents.list`** 為各 `agentId` 設定 model，無需在請求內覆寫 `provider`/`model`。Gateway 回傳的 `res` / `event` 會盡力抽出文字再以 `type: "res"` 加密回 Phone。

**Gateway WebSocket 裝置身分（與 [官方協定](https://openclaw.cc/gateway/protocol) 對齊）**：連線開啟後會先等候 **`event: connect.challenge`**（nonce）；再以 **`connect.params.device`**（Ed25519、`v3` 簽名字串）完成握手。若 Gateway 只會在第一次 **`connect` 錯誤**裡回 nonce、而不發 event，可設 **`OPENCLAW_GATEWAY_LEGACY_BLIND_CONNECT=1`**。成功後若 **`hello-ok`** 含 **`auth.deviceToken`**，會與金鑰一併寫入 **`${OPENCLAW_DATA_DIR}/ombot-gateway-device.json`**（可用 **`OPENCLAW_GATEWAY_DEVICE_STATE_PATH`** 覆寫）。簽名演算法與 payload 欄位順序須與部署中的 **OpenClaw Gateway 版本**一致（見程式 `gatewayDeviceIdentity.js` 註解之上游路徑）。除錯可用 **`OPENCLAW_GATEWAY_DEVICE_INSECURE_SKIP=1`** 略過 `device`（Gateway 須允許不安全 Control UI／對應設定；**預設關閉**）。單一機上的 **`OPENCLAW_GATEWAY_TOKEN`** 與持久化的 **`deviceToken`** 會一併用於簽名時的 token 欄位（依協定）。預設 **`OPENCLAW_BRIDGE_MIN_PROTOCOL=3`**（與僅支援 protocol 3 的 Gateway 可重疊；僅連 v4+ 可設為 `4`。可用環境變數覆寫）。

Prometheus：`ombot_gateway_bridge_connected`、`ombot_gateway_bridge_errors_total`、`ombot_gateway_bridge_phone_to_gateway_total`、`ombot_gateway_bridge_gateway_to_phone_total`、`ombot_gateway_bridge_reject_total{phase,category,reason}`、`ombot_gateway_bridge_gate_state{gate}`、`ombot_gateway_bridge_fallback_total{source,reason}`。

## Hermes Agent 橋接（與 OpenClaw 互斥）

佈署時在 iOS **新增機器** 選 **Hermes Agent**，或設 `OMBIST_AGENT_RUNTIME=hermes` 執行 `provision-headless.sh` / `provision-single-bot.sh`。會安裝 Hermes CLI、`ombist-hermes-gateway.service`（`hermes gateway` + API Server on `127.0.0.1:8642`），並在 `/etc/ombot/ombot.env` 寫入 **`HERMES_AGENT_BRIDGE=1`**（**不要**同時設 `OPENCLAW_GATEWAY_BRIDGE=1`）。

Ombot 模組 `hermesAgentBridge.js` 依 [Hermes API Server 文件](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) 對齊：

- 預設 **`HERMES_BRIDGE_API_MODE=responses`**：`POST /v1/responses`，`conversation` + `input`（伺服器端多輪）
- 可改 **`chat_completions`**：`POST /v1/chat/completions`，Ombot 本地累積 `messages[]`（文件標為 stateless）
- Bearer `HERMES_API_SERVER_KEY`；`X-Hermes-Session-Id` + `X-Hermes-Session-Key` 分別對應 transcript / 長期記憶 scope
- `bridgeConnected` 探測 `GET /v1/health`（備援 `/v1/models`）

詳見 [`docs/hermes-agent-integration.md`](../docs/hermes-agent-integration.md)、[`docs/hermes-api-server-audit.md`](../docs/hermes-api-server-audit.md)。

| Env | Default | Description |
|-----|---------|-------------|
| `HERMES_AGENT_BRIDGE` | (unset) | `1` / `true` 啟用 Hermes 橋接 |
| `HERMES_API_SERVER_URL` | `http://127.0.0.1:8642/v1` | Hermes OpenAI-compatible API base |
| `HERMES_API_SERVER_KEY` | (from `hermes.env`) | Bearer token |
| `HERMES_BRIDGE_AGENT_ID` | `default` | 與 Ombers session 對齊 |
| `HERMES_BRIDGE_CONVERSATION_ID` | `default` | 與 Phone `conversationId` 對齊 |
| `HERMES_BRIDGE_PARTICIPANT_ID` | `default` | 與 Phone `participantId` 對齊 |
| `HERMES_BRIDGE_MODEL` | `hermes-agent` | Request `model` field (cosmetic per Hermes doc) |
| `HERMES_BRIDGE_API_MODE` | `responses` | `responses` or `chat_completions` |

Prometheus：`ombot_hermes_bridge_connected`、`ombot_hermes_bridge_errors_total`、`ombot_hermes_bridge_phone_to_hermes_total`、`ombot_hermes_bridge_hermes_to_phone_total`。

## Health and Metrics

- Health: `GET /healthz` on `HEALTH_PORT`
- Readiness: `GET /readyz` on `HEALTH_PORT`
- Prometheus metrics: `GET /metrics` on `HEALTH_PORT`

## Env

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | 8080 | WS server listen port |
| `OPENCLAW_WS_LISTEN_HOST` | `0.0.0.0` | Bind address for `/ws`；**headless / single-bot 佈署預設 `127.0.0.1`**（僅本機；公網經 Nginx 或 Ombers，不直連 Ombot） |
| `HEALTH_PORT` | `8082` | HTTP health/metrics port（headless/single-bot 佈署常用 **9090**；headless 佈署會以 `ombot-admin health-port ensure-internal` 限制入站為 localhost + tailnet） |
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
| `OPENCLAW_STRICT_PAIRING_PROFILE` | `1` | Fail-close pairing profile; unsupported message/challenge paths are rejected |
| `OPENCLAW_REQUIRE_DEVICE_ATTESTATION` | `1` | Legacy knob. Registration attestation requirement is now driven by client `register_public_key.appAttestationEnabled` (machine-level switch) |
| `OPENCLAW_REGISTER_CHALLENGE_TTL_MS` | `60000` | Registration challenge validity window |
| `OPENCLAW_ALLOW_UNVERIFIED_ATTESTATION` | `0` | Debug-only escape hatch: allow attestation without `verdict=ok` |
| `OPENCLAW_GATEWAY_BRIDGE` | (unset / off) | Set `1` or `true` to enable in-process OpenClaw Gateway WebSocket client bridge |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL for the bridge |
| `OPENCLAW_GATEWAY_TOKEN` | auto-generated at provision if unset | Sent as `connect.params.auth.token`; provision also sets `gateway.auth.mode=token` |
| `OPENCLAW_GATEWAY_DEVICE_STATE_PATH` | (empty → `$OPENCLAW_DATA_DIR/ombot-gateway-device.json`) | Ed25519 device keys + optional persisted `deviceToken` / `storedScopes` from `hello-ok` |
| `OPENCLAW_GATEWAY_DEVICE_INSECURE_SKIP` | `0` | Set `1`/`true` to omit `device` on `connect` (debug; Gateway must allow insecure device auth) |
| `OPENCLAW_GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS` | `15000` | Close connection if no `connect.challenge` event arrives in time (unless legacy blind connect is enabled) |
| `OPENCLAW_GATEWAY_LEGACY_BLIND_CONNECT` | `0` | Set `1` if Gateway does not emit challenge events and only returns a nonce in the first `connect` error payload |
| `OPENCLAW_BRIDGE_AGENT_ID` | `default` | **強烈建議設成** OpenClaw `agents.list` 裡真實的 **`id` 字串**（多數部署沒有 `default` 這個 agent）。Ombot 會在 Gateway `agent` 請求、以及 Phone 傳來佔位字串 **`default`／空白** 時，改以此變數（及 `OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID`）覆寫。僅改 iOS 或僅改程式但未 **重啟 Ombot 行程** 會看不到效果。 |
| `OPENCLAW_BRIDGE_CONVERSATION_ID` | `default` | Must match Phone `conversationId` |
| `OPENCLAW_BRIDGE_PARTICIPANT_ID` | `default` | Must match Phone `participantId` |
| `OPENCLAW_BRIDGE_PHONE_METHOD` | `agent` | Phone `req.method` that carries user text |
| `OPENCLAW_BRIDGE_GATEWAY_AGENT_METHOD` | `agent` | Gateway `req.method` for a model turn |
| `OPENCLAW_BRIDGE_AGENT_INCLUDE_SCOPES` | `0` | Set `1` to add `scopes` to each Gateway `agent` params（預設關閉；現行 Gateway schema 不允許根層 `scopes`，會報 `unexpected property "scopes"`） |
| `OPENCLAW_BRIDGE_MIN_PROTOCOL` / `MAX_PROTOCOL` | `3` / `9` | `connect.params.minProtocol` / `maxProtocol`；預設 **3** 起與 Gateway `expectedProtocol: 3` 相容（舊預設 4 會 protocol mismatch） |
| `OPENCLAW_BRIDGE_ROLE` | `operator` | `connect.params.role`；為相容較嚴格的 Gateway，若設成 `admin` 會在程式內自動降為 `operator` |
| `OPENCLAW_BRIDGE_CLIENT_ID` | `cli` | `connect.params.client.id`（須符合 Gateway schema；舊版曾用 `openclaw`） |
| `OPENCLAW_BRIDGE_CLIENT_PLATFORM` | auto (`linux`/`darwin`/`windows`) | `connect.params.client.platform` |
| `OPENCLAW_BRIDGE_CLIENT_MODE` | `cli` | `connect.params.client.mode`（僅能為 `webchat`/`cli`/`ui`/`backend`/`node`/`probe`/`test`；勿與 `role=operator` 混淆） |
| `OPENCLAW_BRIDGE_OPERATOR_SCOPES` | (empty → `["operator.read","operator.write"]`) | JSON array of operator scopes on `connect`；`operater.*` 會自動正規化為 `operator.*`。無論此變數如何設定，程式都會強制補齊 `operator.read`、`operator.write` 以避免 `missing scope` 類型錯誤。另相容 systemd `EnvironmentFile` 常見格式：`[operator.read,operator.write]`（無引號） |
| `OPENCLAW_BRIDGE_AUTO_FALLBACK` | `0` | Set `1` to enable provider-direct fallback when gateway path is rejected/unavailable (ignored when strict pairing profile is enabled) |
| `OPENCLAW_FALLBACK_OPENAI_MODEL` | `gpt-4.1-mini` | Model for fallback provider route (`OPENAI_API_KEY` required) |
| `OPENCLAW_FALLBACK_TIMEOUT_MS` | `45000` | Timeout for fallback provider completion call |
| `OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID` | same as `OPENCLAW_BRIDGE_AGENT_ID` | Gateway `agent` params `agentId` on each turn |
| `OPENCLAW_BRIDGE_REQ_TIMEOUT_MS` | `120000` | Per-turn timeout waiting for Gateway `res` |
| `OPENCLAW_SINGLE_CLIENT_MODE` | (unset) | `1` for direct Phone↔Ombot WSS (no Ombers middleware path) |
| `OPENCLAW_SELF_HEAL` | follows single-client or bridge | `1`/`true`: enable gateway watchdog; `0` disables even in single-client mode |
| `OPENCLAW_SELF_HEAL_COOLDOWN_MS` | `120000` | Minimum interval between full self-heal runs (except `force` / transport-triggered) |
| `OPENCLAW_SELF_HEAL_INTERVAL_MS` | `180000` | Periodic compose + port check; `0` disables periodic timer |
| `OPENCLAW_GATEWAY_WATCH_INTERVAL_MS` | `60000` | Light TCP watchdog interval (probe + restart only); `0` disables |
| `OPENCLAW_GATEWAY_CONNECT_WAIT_MS` | `45000` | Max wait for loopback port before WebSocket connect; `0` = single probe only |
| `OPENCLAW_SELF_HEAL_RESTART_GATEWAY` | `1` | `0` to only recompose runtime JSON without `sudo systemctl restart` |
| `OPENCLAW_READYZ_REQUIRE_GATEWAY` | `0` (provision: `1`) | `1`: `/readyz` returns 503 when loopback gateway port is not accepting TCP |

Prometheus: `ombot_gateway_loopback_reachable` (0/1) updated by watchdog and `/readyz`.

### OpenClaw Gateway 監察與自我修復

當 `OPENCLAW_SINGLE_CLIENT_MODE=1`、`OPENCLAW_GATEWAY_BRIDGE=1`，或明確 `OPENCLAW_SELF_HEAL=1` 時，Ombot 會：

1. **啟動時**：完整 self-heal（compose + 埠探測 + 必要時重啟 gateway）+ 啟動輕量 watchdog 與週期 compose。
2. **輕量 watchdog**（預設每 60 秒）：TCP 探測 `127.0.0.1:18789`，埠關閉則 `systemctl restart` gateway（不每次 compose）。
3. **週期性**（預設每 3 分鐘）：設定 drift 檢查 + compose + 埠檢查。
4. **Gateway `ECONNREFUSED` / 傳輸錯誤**：立即觸發 self-heal（不受 120s cooldown 限制）；WebSocket 連線前會先等待埠（`OPENCLAW_GATEWAY_CONNECT_WAIT_MS`）。
5. **使用者送訊但 Gateway WS 未就緒**：觸發修復嘗試。
6. **`GET /readyz`**：JSON 含 `selfHeal`；`OPENCLAW_READYZ_REQUIRE_GATEWAY=1` 時埠未開則 503。

佈署：`ombist-ombot.service` 使用 `ExecStartPre=/opt/ombot/bin/wait-gateway-loopback.sh` 與 `Requires=ombist-openclaw-gateway.service`。營運：`ombot-admin gateway loopback --json`。

重啟 Gateway 需要 **`ombot` 使用者能 `sudo -n systemctl restart ombist-openclaw-gateway.service`**。若無 sudo，仍會修好 runtime JSON，請手動重啟 gateway unit。

日誌關鍵字：`openclaw_self_heal_start`、`openclaw_self_heal_compose_ok`、`openclaw_self_heal_gateway_restarted`、`openclaw_self_heal_gateway_still_down`。

中繼 Nginx（WSS / mTLS）整體準備與切換：[docs/relay-nginx-mtls-prep.md](../docs/relay-nginx-mtls-prep.md)（含 PKI、staging、`optional`→`on`、iOS 決策與 rollback）。

## Protocol

- Listens on `OPENCLAW_WS_LISTEN_HOST:PORT/ws`（預設 `0.0.0.0`；**佈署預設 `127.0.0.1`**）。
- **App 直連（本地 OpenClaw）**：送 `{ type: 'register_public_key', publicKey: '<hex>', protocolVersion, capabilities, appAttestationEnabled }`；server 回 `{ type: 'registered', serverPublicKey: '<hex>', protocolVersion, capabilities }`。
- **經 Middleware（Phone E2E）**：Phone 與 Machine 須連到同一 **Middleware session**（URL `…/ws/<sessionKey>`，`sessionKey` 由 `agentId` + `conversationId` 算出；若帶 `participantId`，則改為三元組計算）。本地 OpenClaw 客戶端在 `register_public_key` 應帶 **`conversationId`**（及選填 `agentId`、`participantId`），Machine 才能連上對應 tunnel。Phone 送 `register_public_key` 含 `boxPublicKey` 等；Machine 回 `peer_public_key`；之後訊息以 `encrypted` 格式加解密。若客戶端未帶 `conversationId`／`chatroomId`，Machine 仍連 **legacy** `…/ws`（單對單）。
- App 送 `{ type: 'req', id, method: 'agent', protocolVersion, capabilities, params: { message, clientMessageId }, timestamp, nonce, signature }`；server 驗證後轉發。
- `register_public_key.appAttestationEnabled` 為機器層級開關：`true` 時 challenge 會回 `requireAttestation: true` 並要求 `register_challenge_response.attestation`；`false`（或未帶）時雙方跳過 attestation。

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
