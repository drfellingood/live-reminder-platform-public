# Configuration

This document describes the vendor-neutral self-hosted runtime. It is a configuration contract, not evidence that an environment has been deployed.

## Runtime requirements

- Node.js 22.13 or newer. The SQLite adapter uses the built-in `node:sqlite` module.
- A private configuration path ignored by Git.
- One operator-authorized status source: an HTTPS JSON endpoint or the optional visible-browser Douyin profile adapter.
- An operator-owned delivery integration: either the included WeChat subscribe-message adapter or an HTTPS webhook.

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
| `SELF_HOSTED_CLIENT_DATABASE` | When client is enabled | `client-portal.sqlite` | Separate SQLite filename for client sessions, encrypted external identity, and grant intents. Back it up with the core database. |
| `SELF_HOSTED_CONFIG` | No | `config/self-hosted.json` | JSON path resolved from the working directory. Prefer an ignored path such as `private/self-hosted.json`. |
| `SELF_HOSTED_WORKER_INTERVAL_MS` | No | `1000` | Positive interval for draining pending receipts. This is not a throughput promise. |
| `ADMIN_PASSWORD_HASH` | Remote: yes | generated locally when all four secrets are absent | A scrypt hash, never the plaintext password. |
| `ADMIN_SESSION_SECRET` | Remote: yes | generated locally when all four secrets are absent | At least 32 high-entropy characters. |
| `OBSERVATION_SECRET` | Remote: yes | generated locally when all four secrets are absent | At least 32 high-entropy characters for the low-privilege observation endpoint only. |
| `OPERATOR_SECRET` | Remote: yes | generated locally when all four secrets are absent | A distinct, at least 32-character high-entropy secret for recipient, credit, subscription, receipt-resolution, and per-recipient query operations. Never give it to a status collector. |
| `OBSERVATION_TIME_TOLERANCE_MS` | No | `300000` | Observation time may differ from server time by at most this value. It can be narrowed to 0 but cannot exceed five minutes. |
| `SELF_HOSTED_READ_ONLY` | No | `0` | Set `1` to reject observations and operator commands while leaving the admin dashboard and operator queries readable. The client portal is not started in this recovery mode. |
| `ADMIN_COOKIE_SECURE` | No | enabled; the built-in loopback composition selects `0` | Only `0` disables `Secure`; use `0` solely for deliberate loopback HTTP. |
| `ADMIN_TRUST_PROXY` | No | `0` | Set `1` only when the immediate proxy overwrites client-supplied forwarding headers. |
| `ADMIN_SESSION_TTL_MS` | No | 8 hours | Use a positive millisecond duration. |
| `DELIVERY_MODE` | No | `local-inbox` | `local-inbox` is evaluation only; real adapters are `webhook` and `wechat-subscribe`. |
| `DELIVERY_WEBHOOK_URL` | When mode is `webhook` | none | HTTPS endpoint owned by the operator. |
| `DELIVERY_WEBHOOK_BEARER_TOKEN` | No | none | Added as an `Authorization: Bearer` header; keep private. |
| `DELIVERY_WEBHOOK_TIMEOUT_MS` | No | `5000` | Positive request timeout. A timeout becomes `ambiguous`. |
| `DELIVERY_WEBHOOK_ALLOW_LOOPBACK_HTTP` | No | `0` | Only `1` permits plain HTTP to a loopback webhook for development. |
| `WECHAT_MINIPROGRAM_APP_ID` | When client is enabled | none | Operator-owned Mini Program AppID. It is not a secret, but it must match the AppID selected in Developer Tools and the Mini Program that owns the template. |
| `WECHAT_MINIPROGRAM_APP_SECRET` | When client is enabled | none | Operator-owned AppSecret. Never expose it to the Mini Program. |
| `WECHAT_MINIPROGRAM_TEMPLATE_ID` | When client is enabled | none | Subscription-message template used both by the client grant flow and sender. |
| `CLIENT_IDENTITY_SECRET` | When client is enabled | none | At least 32 characters. Encrypts the external delivery identity in the client database; back it up and never reuse another credential. |
| `WECHAT_API_TIMEOUT_MS` | No | `5000` | Timeout for WeChat identity and send requests. |
| `STATUS_BROWSER_CDP_ENDPOINT` | When a `douyin-page` source is configured | none | Credential-free loopback CDP URL for an operator-owned visible Chromium, for example `http://127.0.0.1:9222`. Never expose this endpoint. |

Provide all four server secrets together or none. Partial explicit secret configuration fails closed. Remote mode never auto-generates them. `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, and `OPERATOR_SECRET` must be pairwise different because a status collector must never gain session, credit, or receipt-resolution authority. A generated `local-secrets.json` may contain only these four named fields; malformed, extra, or reused values are rejected before SQLite is opened.

Generate explicit material locally:

```powershell
npm run admin:secrets
```

The command prints a one-time administrator password, its hash, a session secret, an observation secret, a separate operator secret, and a separate client-identity encryption secret. Store them in a password manager. Do not paste any output into issues or logs.

## Private JSON configuration

Copy `config/self-hosted.example.json` to an ignored location and set `SELF_HOSTED_CONFIG` to that path. The top-level contract is:

```json
{
  "workerBatchSize": 100,
  "policy": {
    "creditCost": 1,
    "defaultDeliveryLimit": 100,
    "deliveryConcurrency": 8,
    "deliveryDeadlineMs": 120000,
    "deliveryRetryDelayMs": 5000
  },
  "client": { "enabled": false },
  "channels": [],
  "recipients": [],
  "statusSources": []
}
```

The file must be a JSON object no larger than 1 MiB. Unknown fields are rejected at every supported level so that misspellings cannot silently disable detection, client access, or accounting. The loader accepts at most 100,000 recipient entries, 1,000 status-source entries, and 1,000 public channels; those parser limits are not supported-capacity claims.

### Mini Program client and public channels

The public client is disabled unless `client.enabled` is exactly `true`. When enabled outside recovery mode, the runtime also requires `DELIVERY_MODE=wechat-subscribe`; it refuses local-inbox or generic webhook delivery rather than recording an acceptance that cannot reach the Mini Program user. `client.template` and the server-side WeChat environment variables are required. Public clients can see only enabled entries from `channels`; they never receive the private status URL, bearer token, OpenID, internal recipient ID, or operator credentials.

```json
{
  "client": {
    "enabled": true,
    "sessionTtlMs": 2592000000,
    "maxSessionsPerIdentity": 5,
    "grantIntentTtlMs": 300000,
    "maxCredits": 200,
    "template": {
      "page": "pages/monitor/monitor",
      "state": "developer",
      "language": "zh_CN",
      "fields": {
        "thing1": { "source": "broadcasterId", "maxLength": 20 },
        "time2": { "source": "occurredAt", "maxLength": 32 }
      }
    }
  },
  "channels": [
    {
      "id": "public-channel-id",
      "displayName": "Public display name",
      "platform": "Authorized source label",
      "description": "Optional public description",
      "enabled": true,
      "sort": 10,
      "staleAfterMs": 360000
    }
  ]
}
```

Each channel `id` is also the broadcaster ID used by its status source. Public login uses a one-time `wx.login` code. The server maps it to a random internal recipient, encrypts the external delivery identity with `CLIENT_IDENTITY_SECRET`, returns only an opaque session token, and limits each identity to the configured active-session count.

Reminder permission uses two steps: the server creates a short-lived intent, then the user actively invokes the WeChat subscription prompt, and the client completes the intent with `accept`, `reject`, or `ban`. One accepted intent grants one idempotent credit. This completion is a client-reported result, not cryptographic proof that WeChat granted permission; the provider remains the final send gate. Keep the built-in caps and add rate limits and anomaly monitoring at the public proxy. Provider acceptance of a later send still does not prove handset display.

The client database is fail-closed to one subscription-message template ID. Changing `WECHAT_MINIPROGRAM_TEMPLATE_ID` while reusing that database refuses startup so that credits granted for one template cannot be spent on another. The reference runtime does not provide an in-place template migration: replacing only the client database would leave enabled core recipients that no longer have a delivery identity. For testing, use a fully isolated new data directory containing fresh core and client databases. A production rotation needs a coordinated migration that disables old recipients and requires fresh user authorization. Never delete only the client database to bypass the check.

The client endpoints are under `/api/v1/client/`. They authenticate only with the opaque client bearer session and never accept `OPERATOR_SECRET` or a client-supplied recipient ID. See [WeChat Mini Program setup](WECHAT_MINIPROGRAM.md).

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

Every source uses the same deep contract: `read()` returns only `live`, `offline`, or `unknown`. `kind` selects one of two built-in adapters. Omitting `kind` keeps backward compatibility with `http-json`.

```json
{
  "kind": "http-json",
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

The optional page adapter accepts only a canonical Douyin user profile and attaches to an operator-owned, already signed-in visible Chromium browser:

```json
{
  "browser": {
    "kind": "chromium-cdp",
    "endpointEnvironment": "STATUS_BROWSER_CDP_ENDPOINT",
    "connectTimeoutMs": 10000,
    "minimumReadSpacingMs": 12000
  },
  "statusSources": [
    {
      "kind": "douyin-page",
      "id": "authorized-page-source",
      "broadcasterId": "public-channel-id",
      "url": "https://www.douyin.com/user/sample_identity",
      "expectedIdentity": "sample_identity",
      "timeoutMs": 30000,
      "pollIntervalMs": 120000,
      "confirmationIntervalMs": 10000
    }
  ]
}
```

The URL must equal `https://www.douyin.com/user/<expectedIdentity>` exactly. The CDP endpoint is read from the named server environment variable and is restricted to loopback. The runtime attaches to a visible browser; it does not launch an anonymous fallback or own/close the external browser. Page reads are serialized across all configured page targets. Startup rejects a declared worst-case page batch that cannot fit within the shortest page poll interval.

Fresh identity, explicit status, and live-room evidence must agree. Verification, rate limits, browser failure, timeout, redirects, identity mismatch, missing fields, or conflicting room evidence become `unknown`; raw page data, cookies, and target identity are not stored in observation evidence. See [Optional Douyin page detector](DOUYIN_PAGE_DETECTOR.md).

The built-in scheduler accepts exactly one status-source definition per `broadcasterId`. Multiple independent sources need an explicit arbitration adapter; configuring two directly is rejected because conflicting `live`/`offline` readings could otherwise create false transitions.

The scheduler polls immediately and at `pollIntervalMs`. Any explicit transition to `live` or `offline` needs a second matching reading after `confirmationIntervalMs`. A disagreement is submitted as `unknown`, and any `unknown` interrupts confirmation. Repeated identical explicit readings are forwarded as freshness heartbeats without transition IDs, so they update the latest reading without creating another event or an unbounded idempotency record.

A new live event is re-armed only after an observed `offline`. If the process is down, or polling misses the complete offline interval between two sessions, a status-only endpoint cannot prove that the second `live` is a new session.

### Policy and worker

`policy.creditCost` must be a positive safe integer. `policy.defaultDeliveryLimit` and `workerBatchSize` are bounded to 1 through 1,000. `policy.deliveryConcurrency` defaults to 8 and is bounded to 1 through 100; it limits simultaneous delivery attempts inside one worker and is not a throughput or latency promise. `policy.deliveryDeadlineMs` defaults to 120000 and is bounded from 1000 through 900000. The deadline starts from the server's event-confirmation clock, not the source-provided `observedAt`, and is persisted on every event. A future source timestamp therefore cannot extend the delivery window. Pending work that reaches the deadline is failed without starting a new sender request and its reserved credit is refunded, so a restart cannot send a stale reminder. A sender request that began before the deadline but has no definitive result remains `ambiguous`. `policy.deliveryRetryDelayMs` defaults to 5000 and is bounded from 100 through 60000; it applies only when provider evidence proves the message was not accepted, such as an access-token request failing or an explicit invalid-token response followed by refresh failure. `policy.maxObservationFutureSkewMs` defaults to 300000 and is bounded from 0 through 86400000 for direct core callers; the realtime HTTP endpoint keeps the stricter five-minute maximum. Timer values may not exceed 2147483647 milliseconds because larger Node.js timers are unsafe. A single runtime prevents overlapping delivery work in process.

## WeChat subscribe-message delivery

Set `DELIVERY_MODE=wechat-subscribe` only with an enabled client and complete server-only WeChat configuration. The adapter resolves the authenticated recipient's encrypted WeChat identity, caches the provider access token, and sends one projected template message per frozen eligible recipient. Template text can come only from the configured safe sources: `broadcasterId`, `eventId`, `occurredAt`, and `source`.

An explicit WeChat send response with `errcode: 0` becomes `accepted`; an explicit nonzero send response becomes `failed`. Access-token acquisition happens before any message send, so a network, HTTP, malformed-body, or structured nonzero token response remains reserved and may retry only inside the persisted event deadline. The adapter checks the deadline again after token acquisition and before every provider send. A send timeout, network error, invalid response, or uncertain HTTP outcome becomes `ambiguous` and is not blindly retried.

The external identity and AppSecret are never returned by client or admin APIs. `CLIENT_IDENTITY_SECRET` is required to decrypt the delivery destination and must be restored together with `client-portal.sqlite`. See [WeChat Mini Program setup](WECHAT_MINIPROGRAM.md).

## Delivery webhook contract

The webhook adapter sends one request per frozen eligible recipient. It does not send a bulk recipient list. The request is `POST`, redirects are rejected, `Content-Type` is `application/json`, and `Idempotency-Key` contains the same deterministic value as the JSON field:

```json
{
  "idempotencyKey": "event-id:private-recipient-id",
  "eventId": "event-id",
  "broadcasterId": "private-channel-id",
  "recipientId": "private-recipient-id",
  "occurredAt": "2035-01-15T12:00:00.000Z",
  "deliveryDeadlineAt": "2035-01-15T12:02:00.000Z",
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
- `createDouyinPageStatusSource({ id, url, expectedIdentity, timeoutMs, driver })`
- `createPlaywrightCdpDouyinDriver({ endpoint, connectTimeoutMs, minimumReadSpacingMs })`
- `createStatusSourceRuntime({ definitions, browser, createBrowserDriver })`
- `createPollScheduler({ broadcasterId, statusSource, onObservation, pollIntervalMs, confirmationIntervalMs, onError })`

The status-source runtime owns the shared CDP transport. Call `await runtime.start()` before scheduling reads and `await runtime.close()` after every scheduler has drained; callers still see only the narrow `{ id, read() }` source interface.

When `server/self-hosted-server.cjs` is run directly instead of through `server/start.cjs`, `SELF_HOSTED_CORE_MODULE` is required. Its path is resolved from the process working directory and it must export a core object, `createCore`, or `coreFactory`.

## Demo environment

| Variable | Required | Default | Boundary |
| --- | --- | --- | --- |
| `DEMO_PORT` | No | `8788` | The demo always binds to `127.0.0.1`. |
| `DEMO_PASSWORD` | No | random temporary value | Optional for local automation; at least 12 characters. |

The demo ignores self-hosted database, status, recipient, and delivery configuration.

## 中文摘要

启用小程序客户端时，需要在私有 JSON 中设置 `client.enabled=true`、公开频道和模板字段，并在服务器 `.env` 中填写自己的 AppID、AppSecret、模板 ID 与独立的 `CLIENT_IDENTITY_SECRET`。小程序只获得公开频道和当前登录用户自己的状态；OpenID、内部接收者 ID、状态源地址和管理密钥不会返回客户端。微信订阅授权必须由用户主动触发，一次接受只增加一次幂等提醒额度。真实部署应选择一个获授权的状态源（自己的 HTTPS JSON 接口，或规范抖音主页的可视浏览器适配器），并选择微信订阅消息或自有 webhook 投递；启用内置小程序时只能使用微信订阅消息投递。`accepted` 仍然只代表发送接口接受，不代表手机已经显示。

运行 `npm start` 可以启动本机自托管版本：首次会在被忽略的 `.data` 目录生成 SQLite 和本机密钥，并只打印一次管理员密码。默认没有真实用户或状态来源，发送方式也是内存收件箱，不能发真实通知。真实部署要把 JSON 配置放在私有路径，选择一个获授权的状态源和已配置的投递方式；远程模式必须显式提供管理员密码哈希、会话密钥、观测密钥和独立运维密钥，并配置 HTTPS 反向代理。页面检测器只能连接本机可视浏览器，不能公开 CDP 端口或绕过验证。观测接口必须带非空 `observationId` 和服务器时间前后五分钟内的 `observedAt`。逐人回执只能通过运维查询接口读取，属于敏感数据；人工处理不确定回执必须带唯一 `resolutionId` 和外部证据。`SELF_HOSTED_READ_ONLY=1` 会禁止观测和运维写入，但仍允许后台与运维只读查询。
