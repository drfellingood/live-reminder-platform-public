# Security policy

## Supported code

Security fixes target the current default branch. Historical archives, deployment snapshots, and private operator modules are not supported release channels.

## Report a vulnerability

Use the repository's private security-advisory form when available. If it is not available, contact the maintainers through a private channel before publishing details. Do not place credentials, private URLs, recipient data, database content, or reproducible access tokens in a public issue.

Include the affected commit, minimal reproduction steps, impact, and a redacted proof. Rotate any credential that may have been exposed before sharing evidence.

## Secrets

- `ADMIN_PASSWORD_HASH` must be a generated scrypt hash; the plaintext password belongs only in a password manager.
- `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, and `OPERATOR_SECRET` must each contain at least 32 high-entropy characters and must not be reused. The observation credential can report status only; the operator credential can mutate recipients, credits, subscriptions, and ambiguous receipt resolutions and can query per-recipient evidence.
- `WECHAT_MINIPROGRAM_APP_SECRET` and `CLIENT_IDENTITY_SECRET` are server-only. The client-identity secret must contain at least 32 high-entropy characters, must be independent from every control secret, and must be backed up with `client-portal.sqlite`. Losing or changing it makes stored delivery identities unreadable.
- Loopback first-run mode stores generated values in `.data/local-secrets.json` and prints the administrator password once. Protect and back up that file with the database; file-mode hints do not replace operating-system access controls, especially on Windows.
- Delivery authorization headers, status URLs containing tokens, and private composition modules are secrets even when they are not named `password`.
- Store runtime values in a secret manager or ignored private environment file. Never commit them, print them in CI logs, add them to browser code, or expose them through client-prefixed variables.
- Rotate a disclosed secret, invalidate related sessions, and review observation, operator, and delivery records for abuse.

## Data minimization

Source files, fixtures, screenshots, issues, and pull requests must not contain data copied from a real deployment. Operators should collect only what the installation needs, restrict access, define retention and deletion rules, and follow the laws and service terms that apply to their deployment.

## Network boundary

The self-hosted server binds to loopback by default. Remote binding requires explicit opt-in, but that flag is not an authentication or encryption control. Put the service behind a maintained HTTPS reverse proxy, firewall the Node port, and keep secure cookies enabled.

Set proxy trust only when the immediate proxy discards client-supplied forwarding headers and writes its own validated client address. Login throttling is in process; its session and failure maps are expiry-pruned and bounded, but a public service still needs proxy-level rate limiting and redacted access logs.

Status reads and delivery webhooks require HTTPS by default. Plain HTTP is accepted only for explicitly enabled loopback development. Both adapters reject redirects. Status response bodies are capped at 64 KiB. Keep credentials out of URLs; a status source may name a private environment variable whose value is sent as a bearer header.

The optional browser-page detector attaches to an operator-owned visible Chromium through CDP. CDP is a privileged browser-control interface: its endpoint must remain on loopback and must never be exposed through a reverse proxy, port forward, tunnel, container publish rule, or public firewall rule. Use a dedicated browser profile, protect its files, and sign in manually. The adapter does not launch an anonymous fallback, solve verification, rotate proxies, evade fingerprinting, or convert a challenge into `offline`. Browser profiles, cookies, targets, screenshots, and raw page responses must remain outside Git and routine logs.

The public Mini Program API must be served only through HTTPS. Put proxy-level rate limits on `/api/v1/client/auth/wechat` and all client mutation routes; the built-in client handler does not provide distributed abuse protection. Prefer exposing only `/api/v1/client/*` publicly while keeping `/admin`, `/api/v1/observations`, and `/api/v1/operator/*` on separate restricted routes or networks.

The Mini Program must contain only the public API base URL. It must never contain AppSecret, `CLIENT_IDENTITY_SECRET`, `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, `OPERATOR_SECRET`, OpenID, database values, or private status-source details. A client-supplied recipient identifier is always rejected; identity comes only from the server-issued opaque session.

## Observation authentication

`POST /api/v1/observations` accepts either a bearer value equal to `OBSERVATION_SECRET` or an HMAC-SHA256 signature over the exact raw body:

```text
message   = <unix_timestamp_seconds> + "." + <exact_raw_body>
signature = "sha256=" + hex(HMAC_SHA256(OBSERVATION_SECRET, message))
```

Send the timestamp in `X-Live-Reminder-Timestamp` and the signature in `X-Live-Reminder-Signature`. Requests outside the five-minute tolerance or with altered whitespace/body bytes are rejected. Use synchronized clocks and prefer HMAC for machine-to-machine senders because it authenticates the exact payload.

Observation JSON also requires a unique `observationId` and an `observedAt` within the configured realtime window. Reusing one ID for a different status is a conflict. This prevents a future-dated or replayed observation from poisoning stable state.

## Operator authentication

`POST /api/v1/operator/commands` and `POST /api/v1/operator/queries` use the same Bearer/HMAC format but exclusively with `OPERATOR_SECRET`. They never accept `OBSERVATION_SECRET`. Operator queries expose per-recipient identifiers and receipts, so keep their bodies and responses out of routine access logs, screenshots, analytics, shell history, and public support material. Manual resolution requires a unique `resolutionId` and external evidence; it is idempotent and may target only an `ambiguous` receipt.

## Persistence and recovery

The included SQLite adapter uses WAL mode and full synchronous writes, but it is designed for one application process. The whole logical state is serialized into one row on each transaction. Do not expose the database file, run several application processes against it, or claim large-scale capacity without replacing the store and validating concurrency.

Use a SQLite-aware online backup or stop the application cleanly before copying databases. Never copy only a main file while writes are active. When the Mini Program is enabled, treat `live-reminder.sqlite`, `client-portal.sqlite`, `CLIENT_IDENTITY_SECRET`, the matching local-secret file, and other external secret-manager material as one recovery set. Encrypt backups, restrict access, define retention, and routinely restore into an isolated path. Inspect a restored core copy first with `SELF_HOSTED_READ_ONLY=1`; client routes are disabled in that recovery mode. An untested backup is not a recovery capability.

Use a dedicated data directory; the built-in runtime rejects the project root, filesystem root, and symbolic-link redirects as data targets. A new POSIX directory is created owner-only, while an existing POSIX directory must already be owner-only rather than being silently re-permissioned. On Windows, mode flags are not an ACL boundary: run under a dedicated account and explicitly restrict NTFS permissions on the data, config, environment, logs, and backups.

## Delivery evidence

An HTTP 2xx from the configured sender is recorded as `accepted`; it does not establish handset display. A request that may have started but lacks a definitive response is `ambiguous`, retains reserved accounting, and requires evidence before manual resolution. Do not replay ambiguous work with a new idempotency key merely to make a dashboard appear successful.

For WeChat subscribe messages, only an explicit provider `errcode: 0` is recorded as `accepted`. A network, timeout, malformed response, or uncertain HTTP outcome is `ambiguous`. The user must initiate the subscription-permission prompt; server credits and provider acceptance still do not prove that a phone displayed a message.

Every event stores a hard delivery deadline measured from server confirmation, not from a caller-controlled source timestamp. No new sender request starts at or after that deadline, including after restart, and expired reserved work is refunded. Only failures with provider evidence that the message was not accepted may use the bounded retry path inside the deadline. A sender request that began before the deadline but has no definitive result remains `ambiguous` and is never blindly retried.

The grant-completion endpoint records the Mini Program client's report of the permission prompt; it cannot independently prove provider permission. This report remains bounded by short-lived intents and credit caps, but public deployments must also rate-limit and monitor client endpoints. Provider authorization is still enforced when a message is sent.

## 中文摘要

启用微信小程序后，AppSecret 与 `CLIENT_IDENTITY_SECRET` 只能留在服务器，客户端只能保存公开 API 地址和不透明会话。客户端身份数据库必须与加密密钥一同备份；公网应只开放必要的 `/api/v1/client/*`，并在代理层增加限流，后台、观测和运维接口应继续受限。订阅授权必须由用户主动触发，微信接口 `errcode: 0` 也不代表手机一定已经显示。

真实密钥、状态地址、通知鉴权、数据库和备份都必须放在 Git 之外。源码、测试、截图、Issue 和 PR 不得包含真实部署数据；运营者应最小化收集并设置保留和删除规则。公网部署需要 HTTPS、反向代理、防火墙和额外限流。观察接口支持 Bearer 或对“时间戳 + 原始请求体”计算的 HMAC。SQLite 版本只按单进程使用；备份必须经过真实恢复测试。发送端接受请求不等于手机已经显示通知。
