# Ombot Runbook

## Service Controls

- Start: `sudo systemctl start ombot.service`
- Stop: `sudo systemctl stop ombot.service`
- Restart: `sudo systemctl restart ombot.service`
- Logs: `sudo journalctl -u ombot.service -f`

## Health Checks

- Liveness: `curl -fsS http://127.0.0.1:9090/healthz`
- Readiness: `curl -fsS http://127.0.0.1:9090/readyz`
- Metrics: `curl -fsS http://127.0.0.1:9090/metrics`

## Incident Steps

1. Confirm alert and scope.
2. Verify middleware connectivity.
3. Check `relay_errors_total` and disconnect spikes.
4. If impact persists, rollback with `tools/rollback.sh`.
5. Record timeline, root cause, and permanent fix items.

## Signature/Replay Alerts

- Default alert thresholds (5 min window):
  - `ombot_protocol_mismatch_total > 0` => warn
  - `ombot_capability_reject_total > 0` => warn
  - `ombot_signature_verify_fail_total >= 5` => critical
  - `ombot_replay_reject_total >= 3` => critical
- If `ombot_signature_verify_fail_total` increases:
  - Confirm client clock skew and `OPENCLAW_SIGNATURE_MAX_AGE_MS`.
  - Confirm client signs canonical payload (`type,id,method,params,timestamp,nonce`).
- If `ombot_replay_reject_total` increases:
  - Check duplicate/non-unique nonce generation on clients.
  - Validate no proxy retries are replaying the same signed frame.
- If `ombot_protocol_mismatch_total` increases:
  - Check client `protocolVersion` against `OPENCLAW_MIN_PROTOCOL_VERSION`.
  - Confirm `OPENCLAW_ALLOW_LEGACY_PROTOCOL` policy in current rollout stage.
- If `ombot_capability_reject_total` increases:
  - Compare client `capabilities` with `OPENCLAW_REQUIRED_CAPABILITIES`.

## Key Rotation Procedure

1. Add new key to front of `OPENCLAW_KEY_ENCRYPTION_KEYS` in `/etc/ombot/ombot.env`.
2. Restart service.
3. Run `npm run rotate:data-key` inside active release.
4. Validate normal traffic and audit log entries.
5. Remove old key after a safe observation window.

## Middleware TLS certificate rotation (outbound trust)

Ombot’s WebSocket client to middleware must use **`wss`** when `MIDDLEWARE_WS_URL` is `wss://…` (see application config). Trust is **Node/OS default CAs** unless you add a custom bundle.

**Public CA middleware cert**

- Monitor the middleware FQDN certificate `notAfter` like any other external dependency.
- Renew/replace on the middleware side; no Ombot change if the chain stays under public roots.

**Private CA / enterprise PKI**

- Maintain **one versioned CA bundle file** (full chain or root + intermediates) deployed with the Ombot release or config management—**do not** rely on ad hoc per-host `NODE_EXTRA_CA_CERTS` edits.
- Set `NODE_EXTRA_CA_CERTS=/path/to/ombot-middleware-ca.pem` consistently in `ombot.service` (or equivalent) for all instances.
- **Order of operations**: deploy the updated trust bundle (or update OS trust store) **before** the middleware starts presenting a chain that only validates under the new anchor. Doing the cert switch first will cause TLS handshake failures and relay disconnects.

**Validation**

```bash
# From the Ombot host: check chain and expiry against middleware FQDN
echo | openssl s_client -servername "${MIDDLEWARE_HOST}" -connect "${MIDDLEWARE_HOST}:443" 2>/dev/null \
  | openssl x509 -noout -dates -issuer -subject
```

**Incidents**

- Correlate `relay_errors` / disconnect spikes with middleware TLS changes; roll forward trust bundle or temporarily restore the previous middleware chain per rollback runbook.

**Client-side pinning note**

- iOS may pin the **relay** leaf separately from Ombot→middleware trust; coordinate ingress rotation with [docs/ios-pin-rotation-calendar.md](../../docs/ios-pin-rotation-calendar.md).

## Production WSS acceptance (Ombot ↔ Ombers)

Use this checklist after changing ingress or Ombot env. Ombers must present **TLS on the MACHINE listen** that Ombot reaches (Nginx in front of loopback Ombers, or `OMBERS_USE_TLS=1`). When using Nginx, the port in **`MIDDLEWARE_WS_URL`** is often the **TLS** front port (not the plain Ombers `LISTEN` port); match whatever you pass as **`MACHINE_PORT`** to provisioning.

1. **Ombers / ingress**
   - From a host that mirrors production routing: `curl -fsSI "https://${RELAY_HOST}:${MACHINE_PORT}/health"` (or the health path your Nginx exposes on that TLS port) succeeds with a valid chain for that hostname.
   - If the server uses a **private CA**, install trust on the Ombot host (OS store) or set **`MIDDLEWARE_TLS_CA_PATH`** (or `NODE_EXTRA_CA_CERTS` per above) so Node can verify the server certificate.

2. **Ombot**
   - `MIDDLEWARE_WS_URL=wss://${RELAY_HOST}:${MACHINE_PORT}/ws` and **`OPENCLAW_REQUIRE_MIDDLEWARE_TLS=1`** (or unset: anything other than `0` requires a `wss:` URL—see [README](../README.md)).
   - Process starts without **`middleware_tls_required`** exit.
   - Logs show successful middleware attach (e.g. **`middleware_connected`**).

3. **Negative test (must fail fast)**
   - Set **`MIDDLEWARE_WS_URL=ws://…`** while **`OPENCLAW_REQUIRE_MIDDLEWARE_TLS`** is **not** `0`. Ombot should **exit on startup** with `middleware_tls_required`. This confirms misconfiguration cannot silently downgrade to plaintext middleware.

## mTLS client identity (Ombot to Ombers Nginx)

When ingress requires **mutual TLS**, set **`MIDDLEWARE_TLS_CLIENT_CERT_PATH`** and **`MIDDLEWARE_TLS_CLIENT_KEY_PATH`** (and **`MIDDLEWARE_TLS_CA_PATH`** if the server chain is private CA). File permissions: prefer **`0400`** on the key; restrict directory listing. Rotate by deploying overlapping certs, restarting **`ombot.service`**, then validating **`middleware_connected`** before retiring old material.

Cross-cutting prep (staging `optional` → `on`, dual-port symmetry, iOS gating, synthetic `curl --cert/--key` probes): [docs/relay-nginx-mtls-prep.md](../../docs/relay-nginx-mtls-prep.md).
