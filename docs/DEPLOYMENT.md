# Self-hosting and deployment

This repository provides a complete single-process composition root. It does not require a particular cloud vendor. Operators connect their own HTTPS status endpoint and choose either the included WeChat Mini Program subscribe-message path or their own HTTPS delivery webhook.

A local build or sender `2xx` response is not proof that every eligible recipient was processed or that a handset displayed a notification.

Read [Configuration](CONFIGURATION.md) and [Security policy](../SECURITY.md) before exposing the service.

## 1. Validate a clean checkout

Use Node.js 22.13 or newer:

```powershell
npm ci
npm run build
```

Record the source commit and lockfile hash. Stop if the checkout contains unexplained archives, databases, media, identities, account values, or secrets.

## 2. Understand demo versus self-hosting

The isolated demo is fictional and memory-only:

```powershell
npm run demo
```

The real self-hosted composition uses SQLite and a worker:

```powershell
npm start
```

On the first loopback start, it creates `.data/live-reminder.sqlite` and `.data/local-secrets.json`, then prints the administrator password once. Save that password immediately. Enabling the Mini Program client also creates `.data/client-portal.sqlite`. With no private config it has no recipients or status sources, and its local inbox cannot contact a real recipient.

## 3. Create private configuration

Copy the checked-in examples to ignored paths:

```powershell
Copy-Item server/self-hosted.env.example .env
Copy-Item config/self-hosted.example.json config/self-hosted.json
```

Both destinations are ignored by Git. Replace the fictional sample values with identifiers and endpoints you are authorized to use. Do not put credentials in the JSON file or URL query string.

For the included Mini Program, also copy `wechat-miniprogram/config.example.js` to the ignored `wechat-miniprogram/config.local.js`. Follow [WeChat Mini Program setup](WECHAT_MINIPROGRAM.md); do not put AppSecret or any server credential in the client directory.

Each status endpoint returns exactly one of these states:

```json
{ "status": "live" }
```

Allowed values are `live`, `offline`, and `unknown`. The default scheduler polls every 120 seconds. A possible `live` result is read again after 10 seconds before submission; `offline` and `unknown` transitions are submitted immediately. Network, parsing, redirect, timeout, or security-challenge failures become `unknown`, never fabricated `offline`.

The recipient bootstrap format is documented in [Configuration](CONFIGURATION.md). Initial credits apply only when a recipient is first created. Removing a subscription from JSON does not mutate an existing subscription.

## 4. Choose the delivery mode

`local-inbox` is the default and requires no external account:

```dotenv
DELIVERY_MODE=local-inbox
```

It is useful for local verification only. Messages live in process memory, while event receipts and accounting remain in SQLite.

For a real delivery integration, use an operator-owned HTTPS endpoint:

```dotenv
DELIVERY_MODE=webhook
DELIVERY_WEBHOOK_URL=https://notifications.example.invalid/live-reminder
DELIVERY_WEBHOOK_BEARER_TOKEN=replace-in-your-secret-manager
```

The adapter sends one JSON envelope per recipient with an `Idempotency-Key` header and rejects redirects. A `2xx` result becomes `accepted`; an explicit non-`2xx` response becomes `failed`; a timeout or uncertain network outcome becomes `ambiguous`. Ambiguous work is not blindly resent or refunded. Implement the exact body/response contract in [Configuration](CONFIGURATION.md#delivery-webhook-contract) before enabling real recipients.

Or use the included WeChat Mini Program path:

```dotenv
DELIVERY_MODE=wechat-subscribe
WECHAT_MINIPROGRAM_APP_ID=enter-in-your-secret-manager
WECHAT_MINIPROGRAM_APP_SECRET=enter-in-your-secret-manager
WECHAT_MINIPROGRAM_TEMPLATE_ID=enter-in-your-secret-manager
CLIENT_IDENTITY_SECRET=use-an-independent-generated-secret
```

This mode requires `client.enabled=true`, a public channel allowlist, matching template fields, the separate client database, and a user-driven subscription-permission flow. Back up `CLIENT_IDENTITY_SECRET` with the client database. WeChat `errcode: 0` is recorded as provider acceptance, not handset display.

## 5. Start locally and verify the flow

```powershell
npm start
```

Open `http://127.0.0.1:8787/admin` and sign in with the first-run password. Verify:

- configured recipients and subscriptions were loaded;
- the status endpoint can produce `offline`, confirmed `live`, and `unknown`;
- one confirmed live period creates one event and a frozen recipient denominator;
- the worker produces one receipt per eligible recipient;
- explicit failures refund once, accepted results consume once, and ambiguous results remain pending operator evidence;
- the deadline is anchored to server confirmation time, no new sender request starts at or after it, and only failures with evidence that the provider did not accept a message may retry inside it;
- restarting preserves SQLite events, receipts, credit grants, and accounting.

The signed observation endpoint is `POST /api/v1/observations`. It accepts a bearer secret or HMAC-SHA256 headers described in [Security policy](../SECURITY.md).

## 6. Remote exposure

Loopback is the safe default. Before using a non-loopback host:

1. run `npm run admin:secrets` and store all output in a secret manager;
2. populate `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, and the distinct `OPERATOR_SECRET` together; when the Mini Program is enabled, also provide its AppID, AppSecret, template ID, and independent `CLIENT_IDENTITY_SECRET`;
3. place the Node service behind an HTTPS reverse proxy;
4. block direct public access to the Node port;
5. set `ADMIN_COOKIE_SECURE=1`;
6. enable proxy trust only when the immediate proxy overwrites forwarding headers;
7. set `SELF_HOSTED_ALLOW_REMOTE=1` only after the preceding controls are in place.

The program refuses remote mode with auto-generated secrets. The opt-in flag does not provide TLS, firewalling, rate limiting, monitoring, or backups.

## 7. Password recovery

For a loopback-only local instance, losing the first-run password requires a credential reset:

1. stop the process;
2. move `.data/local-secrets.json` to a private backup location;
3. restart and save the newly printed password;
4. update every signed observation sender and every operator client because both control secrets also changed.

Do not delete the SQLite database. For a remote instance, generate and rotate explicit secrets through the deployment secret manager.

## 8. Capacity boundary

The reference SQLite store is deliberately single-process. The runtime creates an owner file named `runtime.lock` in the data directory and refuses a second writable process that targets the same directory. Do not remove the lock while a process may still be running. It serializes mutations and stores the complete domain state as JSON in one SQLite row. Delivery attempts use bounded in-process concurrency (8 by default); this is not a capacity or latency guarantee. Every event also stores a hard delivery deadline (120 seconds from server confirmation by default), so no new sender request starts after stale work expires and its reserved credit is refunded. A request that started before the deadline but has an uncertain outcome remains `ambiguous`. Before adding real users, measure the intended recipient/event volume, database growth, dashboard latency, worker latency, and restore time on the target hardware.

Do not run multiple service processes against this reference store or publish throughput/latency claims from unit tests. Horizontal scaling requires a different store adapter, distributed worker ownership, capacity tests, and recovery tests.

## 9. Backup and restore

Define an owner, schedule, retention, encryption, recovery point, and recovery time. Use a SQLite-aware backup mechanism while the process is running. The simplest consistent procedure is:

1. stop the process cleanly;
2. copy the closed core database, the client database when enabled, private JSON, `.data/local-secrets.json` (for loopback-managed credentials), and a recoverable reference to externally managed secrets including `CLIENT_IDENTITY_SECRET` into encrypted storage;
3. preserve an immutable backup copy, then restore a working copy into an isolated directory with outbound network blocked;
4. use the same tested source version and start the working copy with `SELF_HOSTED_READ_ONLY=1`; do not use normal mode for the first inspection (SQLite may create `-wal`/`-shm` coordination sidecars beside this disposable working copy);
5. query the dashboard and operator event views to reconcile denominators, receipts, ambiguous outcomes, and credits without bootstrap, polling, delivery, in-flight recovery, or credential generation;
6. only after the evidence review, stop the isolated copy and make a separate, explicit decision about a writable recovery rehearsal.

A backup that has never been restored is not a verified recovery capability.

## 10. Promotion gate

Before enabling real recipients, require all of the following:

- `npm ci` and `npm run build` pass from a clean checkout;
- the exact source, lockfile, Node version, config, and adapter versions are recorded;
- no placeholder, secret, private identifier, database, backup, or private media is in the release;
- HTTPS, firewall, secure cookies, proxy trust, rate limits, monitoring, and alerting match the design;
- status failures remain `unknown`;
- accepted, failed, timeout/ambiguous, idempotency, restart, and manual-resolution paths are tested;
- when using the Mini Program, Developer Tools compilation, client login, explicit subscription permission, server-side identity decryption, provider acceptance, and consenting handset observation are tested separately;
- the operator has published the privacy disclosures, support and deletion process, and other current platform materials required for their own Mini Program; any required consent gate runs before identity creation;
- the configured subscription-message template matches the client database binding; because the reference runtime has no in-place rotation tool, a production template change uses a coordinated migration that disables old recipients and obtains fresh user authorization rather than replacing only the client database;
- a backup restoration has succeeded;
- each event has a verifiable frozen denominator and matching per-recipient receipts;
- no unresolved ambiguous result or pending accounting is hidden.

Any failed item stops promotion.

## Acceptance boundary

A `terminal` event has finished processing and accounting, but it may still contain explicit failures. A system-level event passes only when its denominator is verifiable, receipt count matches, `failed = 0`, `accepted = denominator`, `ambiguous = 0`, `bookkeepingPending = 0`, counts are consistent, and timing is measured from a declared start point. Sender `accepted` still does not prove handset display; handset observations must be reported separately.

## 中文摘要

陌生人克隆后可以直接运行 `npm start`：首次只在本机生成 SQLite、本机密钥和一次性显示的后台密码。要接入微信小程序，需要自己的 AppID、AppSecret、订阅消息模板、HTTPS 域名、独立 `CLIENT_IDENTITY_SECRET`、公开频道白名单和合法获授权的状态接口；小程序客户端配置中只能放公开 API 地址。核心数据库、客户端数据库和对应密钥必须一起备份恢复。公网前必须配置 HTTPS 反向代理、防火墙、安全 Cookie、独立密钥、限流、监控和经过恢复演练的备份。SQLite 参考实现只支持单进程；微信接口接受请求不等于手机已经显示通知。
