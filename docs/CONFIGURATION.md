# Configuration

This document describes the vendor-neutral self-hosted runtime. It is a configuration contract, not evidence that an environment has been deployed.

## Runtime requirements

- Node.js 22.13 or newer. The SQLite adapter uses the built-in `node:sqlite` module.
- A private configuration path ignored by Git.
- An operator-owned HTTPS status endpoint for automatic detection.
- An operator-owned HTTPS delivery webhook for real notifications.

The repository contains no production account, endpoint, recipient, or secret defaults.

## Quick local start

```powershell
npm start
```

With the default loopback bind and no explicit secrets, the runtime creates `.data/local-secrets.json` and `.data/live-reminder.sqlite`. It prints the one-time administrator password only when the secret file is first created. With no private JSON configuration, there are no recipients or status sources and delivery uses the in-memory local inbox.

This mode is useful for local evaluation. The local inbox accepts into process memory and cannot send a real notification.

## Built-in runtime environment

`server/start.cjs` reads these variables:

| Variable | Required | Default | Boundary |
| --- | --- | --- | --- |
| `SELF_HOSTED_HOST` | No | `127.0.0.1` | A non-loopback value is rejected unless remote exposure is explicitly enabled. |
| `SELF_HOSTED_PORT` | No | `8787` | Integer from 1 through 65535. |
| `SELF_HOSTED_ALLOW_REMOTE` | No | `0` | Only `1` allows a non-loopback bind. This is not TLS, authentication, or firewall protection. |
| `SELF_HOSTED_DATA_DIR` | No | `.data` | A dedicated, non-symlink directory for SQLite and optional generated local secrets. The project root and filesystem root are rejected; an existing POSIX directory must already be owner-only. Keep it private and backed up. |
| `SELF_HOSTED_DATABASE` | No | `live-reminder.sqlite` | Filename resolved under the data directory. |
| `SELF_HOSTED_CONFIG` | No | `config/self-hosted.json` | JSON path resolved from the working directory. Prefer an ignored path such as `private/self-hosted.json`. |
| `SELF_HOSTED_WORKER_INTERVAL_MS` | No | `1000` | Positive interval for draining pending receipts. This is not a throughput promise. |
| `ADMIN_PASSWORD_HASH` | Remote: yes | generated locally when all four secrets are absent | A scrypt hash, never the plaintext password. |
| `ADMIN_SESSION_SECRET` | Remote: yes | generated locally when all four secrets are absent | At least 32 high-entropy characters. |
| `OBSERVATION_SECRET` | Remote: yes | generated locally when all four secrets are absent | At least 32 high-entropy characters for the low-privilege observation endpoint only. |
| `OPERATOR_SECRET` | Remote: yes | generated locally when all four secrets are absent | A distinct, at least 32-character high-entropy secret for recipient, credit, subscription, receipt-resolution, and per-recipient query operations. Never give it to a status collector. |
| `OBSERVATION_TIME_TOLERANCE_MS` | No | `300000` | Observation time may differ from server time by at most this value. It can be narrowed to 0 but cannot exceed five minutes. |
| `SELF_HOSTED_READ_ONLY` | No | `0` | Set `1` to reject observations and operator commands while leaving the admin dashboard and operator queries readable. |
| `ADMIN_COOKIE_SECURE` | No | enabled; the built-in loopback composition selects `0` | Only `0` disables `Secure`; use `0` solely for deliberate loopback HTTP. |
| `ADMIN_TRUST_PROXY` | No | `0` | Set `1` only when the immediate proxy overwrites client-supplied forwarding headers. |
| `ADMIN_SESSION_TTL_MS` | No | 8 hours | Use a positive millisecond duration. |
| `DELIVERY_MODE` | No | `local-inbox` | `local-inbox` is process-memory evaluation; `webhook` is the real generic adapter. |
| `DELIVERY_WEBHOOK_URL` | When mode is `webhook` | none | HTTPS endpoint owned by the operator. |
| `DELIVERY_WEBHOOK_BEARER_TOKEN` | No | none | Added as an `Authorization: Bearer` header; keep private. |
| `DELIVERY_WEBHOOK_TIMEOUT_MS` | No | `5000` | Positive request timeout. A timeout becomes `ambiguous`. |
| `DELIVERY_WEBHOOK_ALLOW_LOOPBACK_HTTP` | No | `0` | Only `1` permits plain HTTP to a loopback webhook for development. |

Provide all four server secrets together or none. Partial explicit secret configuration fails closed. Remote mode never auto-generates them. `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, and `OPERATOR_SECRET` must be pairwise different because a status collector must never gain session, credit, or receipt-resolution authority. A generated `local-secrets.json` may contain only these four named fields; malformed, extra, or reused values are rejected before SQLite is opened.

Generate explicit material locally:

```powershell
npm run admin:secrets
```

The command prints a one-time administrator password, its hash, a session secret, an observation secret, and a separate operator secret. Store them in a password manager. Do not paste any output into issues or logs.

## Private JSON configuration

Copy `config/self-hosted.example.json` to an ignored location and set `SELF_HOSTED_CONFIG` to that path. The top-level contract is:

```json
{
  "workerBatchSize": 100,
  "policy": {
    "creditCost": 1,
    "defaultDeliveryLimit": 100
  },
  "recipients": [],
  "statusSources": []
}
```

The file must be a JSON object no larger than 1 MiB. Unknown fields are rejected at the top level and inside policy, recipient, and status-source records so that misspellings cannot silently disable detection or change accounting. The loader accepts at most 100,000 recipient entries and 1,000 status-source entries; those parser limits are not supported-capacity claims.

### Recipients

```json
{
  "id": "private-recipient-id",
  "credits": 10,
  "enabled": true,
  "subscriptions": ["private-channel-id"]
}
```

`id` and every subscription must be non-empty strings of at most 200 characters. `enabled`, when present, must be a JSON boolean rather than a string. Credits are a non-negative integer. Recipient configuration is bootstrap input:

- a new recipient starts with the configured credits;
- restarting does not reset credits for an existing recipient;
- listed subscriptions are created or reactivated;
- removing a subscription from JSON does not automatically unsubscribe an existing record.

After bootstrap, use the separately authenticated operator command endpoint described below. Do not edit the database directly.

### Status sources

```json
{
  "id": "primary-status-source",
  "broadcasterId": "private-channel-id",
  "url": "https://status.example.invalid/channel",
  "bearerTokenEnvironment": "STATUS_SOURCE_PRIMARY_TOKEN",
  "timeoutMs": 5000,
  "pollIntervalMs": 120000,
  "confirmationIntervalMs": 10000
}
```

The endpoint must return a JSON body no larger than 64 KiB containing `status` equal to `live`, `offline`, or `unknown`. Oversized bodies become `unknown` and are not retained. HTTPS is required. Set `allowLoopbackHttp` to `true` only for deliberate loopback development. When authentication is required, set `bearerTokenEnvironment` to the name of an environment variable; the secret value stays out of JSON and evidence. Credentials embedded as URL username/password are rejected, redirects are rejected, and recorded evidence omits the query string.

The built-in scheduler accepts exactly one status-source definition per `broadcasterId`. Multiple independent sources need an explicit arbitration adapter; configuring two directly is rejected because conflicting `live`/`offline` readings could otherwise create false transitions.

The scheduler polls immediately and at `pollIntervalMs`. A possible `live` result needs a second `live` after `confirmationIntervalMs`; `offline` and `unknown` changes are submitted immediately. Repeated identical readings are forwarded as freshness heartbeats without transition IDs, so they update the latest reading without creating another event or an unbounded idempotency record.

A new live event is re-armed only after an observed `offline`. If the process is down, or polling misses the complete offline interval between two sessions, a status-only endpoint cannot prove that the second `live` is a new session.

### Policy and worker

`policy.creditCost` must be a positive safe integer. `policy.defaultDeliveryLimit` and `workerBatchSize` are bounded to 1 through 1,000. `policy.maxObservationFutureSkewMs` defaults to 300000 and is bounded from 0 through 86400000 for direct core callers; the realtime HTTP endpoint keeps the stricter five-minute maximum. Timer values may not exceed 2147483647 milliseconds because larger Node.js timers are unsafe. A single runtime prevents overlapping delivery work in process.

## Delivery webhook contract

The webhook adapter sends one request per frozen eligible recipient. It does not send a bulk recipient list. The request is `POST`, redirects are rejected, `Content-Type` is `application/json`, and `Idempotency-Key` contains the same deterministic value as the JSON field:

```json
{
  "idempotencyKey": "event-id:private-recipient-id",
  "eventId": "event-id",
  "broadcasterId": "private-channel-id",
  "recipientId": "private-recipient-id",
  "occurredAt": "2035-01-15T12:00:00.000Z",
  "source": "primary-status-source",
  "attempt": 1
}
```

Return any `2xx` only after the sender has accepted responsibility for that idempotency key. A non-`2xx` response is an explicit failure. If supplied, response header `X-Request-Id` is stored as the provider reference. A timeout or network exception is `ambiguous`, because the request may already have reached the sender. The adapter never interprets acceptance as handset display.

## Observation HTTP contract

The self-hosted endpoint accepts `POST /api/v1/observations` with `Content-Type: application/json` and a body up to 64 KiB:

```json
{
  "broadcasterId": "private-channel-id",
  "status": "live",
  "observationId": "unique-observation-id",
  "observedAt": "2035-01-15T12:00:00.000Z",
  "source": "operator-status-service",
  "evidence": {
    "httpStatus": 200,
    "confirmationIntervalMs": 10000
  }
}
```

Evidence is optional and must be a bounded plain object of scalar values. Nested objects and unbounded strings are rejected. Authenticate with `Authorization: Bearer <OBSERVATION_SECRET>` or the HMAC headers defined in [Security policy](../SECURITY.md). HMAC uses the exact raw body, so serialization and whitespace must not change after signing.

`observationId` and `observedAt` are mandatory. `observationId` is the caller's stable idempotency key. `observedAt` must be a valid timestamp within the server's configured realtime window; the default and maximum window is five minutes in either direction. Missing, invalid, stale, or future values receive the same `400 INVALID_OBSERVATION` response and are never sent to the core.

PowerShell bearer example:

```powershell
$baseUrl = "https://reminder.example.invalid"
$headers = @{ Authorization = "Bearer $env:OBSERVATION_SECRET" }
$body = @{
  broadcasterId = "private-channel-id"
  status = "live"
  observationId = "observation-$([guid]::NewGuid())"
  observedAt = (Get-Date).ToUniversalTime().ToString("o")
  source = "operator-status-service"
} | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v1/observations" -Headers $headers -ContentType "application/json" -Body $body
```

curl bearer example:

```bash
BASE_URL='https://reminder.example.invalid'
BODY="$(printf '{\"broadcasterId\":\"private-channel-id\",\"status\":\"live\",\"observationId\":\"observation-%s\",\"observedAt\":\"%s\"}' "$(date +%s)-$$" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")"
curl --fail-with-body -X POST "$BASE_URL/api/v1/observations" \
  -H "Authorization: Bearer $OBSERVATION_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary "$BODY"
```

## Operator command and query HTTP contracts

`POST /api/v1/operator/commands` accepts only these strictly projected command shapes:

```json
{"kind":"register-recipient","recipientId":"private-recipient-id","credits":0,"enabled":true}
{"kind":"grant-credits","grantId":"unique-grant-id","recipientId":"private-recipient-id","credits":5}
{"kind":"subscribe","broadcasterId":"private-channel-id","recipientId":"private-recipient-id","active":true}
{"kind":"resolve-delivery","resolutionId":"unique-resolution-id","eventId":"event-id","recipientId":"private-recipient-id","outcome":"accepted","providerReference":"provider-evidence-id","code":"operator-verified"}
```

Extra fields and every other command kind, including `observe` and `deliver-pending`, are rejected. A resolution requires a unique `resolutionId`, an `accepted` or `failed` outcome, and at least one non-empty `code` or `providerReference`. Only an `ambiguous` receipt can be resolved; never guess an outcome merely to make counts terminal.

`POST /api/v1/operator/queries` accepts only:

```json
{"kind":"event","eventId":"event-id"}
{"kind":"recipient","recipientId":"private-recipient-id"}
```

An event query returns its frozen eligible-recipient identifiers and per-recipient receipts. A recipient query returns that recipient's current accounting view. These responses contain sensitive identifiers and delivery evidence: restrict access, disable shared terminal history, redact support attachments, and never publish query output.

Both operator endpoints accept `Authorization: Bearer <OPERATOR_SECRET>` or HMAC over the exact raw body. They never accept `OBSERVATION_SECRET`. For HMAC, use `OPERATOR_SECRET` with the same timestamp and signature headers as the observation endpoint.

PowerShell reconciliation example:

```powershell
$baseUrl = "https://reminder.example.invalid"
$headers = @{ Authorization = "Bearer $env:OPERATOR_SECRET" }
$queryBody = @{ kind = "event"; eventId = "event-id" } | ConvertTo-Json -Compress
$event = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v1/operator/queries" -Headers $headers -ContentType "application/json" -Body $queryBody
$event.data.receipts | Where-Object deliveryStatus -eq "ambiguous"

$resolveBody = @{
  kind = "resolve-delivery"
  resolutionId = "resolution-$([guid]::NewGuid())"
  eventId = "event-id"
  recipientId = "private-recipient-id"
  outcome = "accepted"
  providerReference = "provider-evidence-id"
  code = "operator-verified"
} | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v1/operator/commands" -Headers $headers -ContentType "application/json" -Body $resolveBody
```

curl query example:

```bash
BASE_URL='https://reminder.example.invalid'
curl --fail-with-body -X POST "$BASE_URL/api/v1/operator/queries" \
  -H "Authorization: Bearer $OPERATOR_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"kind":"event","eventId":"event-id"}'
```

When `SELF_HOSTED_READ_ONLY=1`, authenticated observations and operator commands return `403 READ_ONLY`; operator queries and the authenticated admin dashboard remain available for evidence preservation. SQLite may create `-wal` and `-shm` coordination sidecars beside the isolated inspection copy even though the main database and secret contents remain unchanged, so always inspect a disposable restored copy rather than the only backup.

## Advanced module configuration

The modules can be composed directly:

- `createReminderCore({ store, delivery, clock, policy, readOnly })`
- `createSqliteStore({ filename, readOnly })`
- `createWebhookDelivery({ url, timeoutMs, headers, allowInsecureLoopback })`
- `createHttpJsonStatusSource({ id, url, timeoutMs, allowLoopbackHttp, bearerToken })`
- `createPollScheduler({ broadcasterId, statusSource, onObservation, pollIntervalMs, confirmationIntervalMs, onError })`

When `server/self-hosted-server.cjs` is run directly instead of through `server/start.cjs`, `SELF_HOSTED_CORE_MODULE` is required. Its path is resolved from the process working directory and it must export a core object, `createCore`, or `coreFactory`.

## Demo environment

| Variable | Required | Default | Boundary |
| --- | --- | --- | --- |
| `DEMO_PORT` | No | `8788` | The demo always binds to `127.0.0.1`. |
| `DEMO_PASSWORD` | No | random temporary value | Optional for local automation; at least 12 characters. |

The demo ignores self-hosted database, status, recipient, and delivery configuration.

## 中文摘要

运行 `npm start` 可以启动本机自托管版本：首次会在被忽略的 `.data` 目录生成 SQLite 和本机密钥，并只打印一次管理员密码。默认没有真实用户或状态来源，发送方式也是内存收件箱，不能发真实通知。真实部署要把 JSON 配置放在私有路径，设置自己的 HTTPS 状态接口和 webhook；远程模式必须显式提供管理员密码哈希、会话密钥、观测密钥和独立运维密钥，并配置 HTTPS 反向代理。观测接口必须带非空 `observationId` 和服务器时间前后五分钟内的 `observedAt`。逐人回执只能通过运维查询接口读取，属于敏感数据；人工处理不确定回执必须带唯一 `resolutionId` 和外部证据。`SELF_HOSTED_READ_ONLY=1` 会禁止观测和运维写入，但仍允许后台与运维只读查询。
