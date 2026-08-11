# Security policy

## Supported code

Security fixes target the current default branch. Historical archives, deployment snapshots, and private operator modules are not supported release channels.

## Report a vulnerability

Use the repository's private security-advisory form when available. If it is not available, contact the maintainers through a private channel before publishing details. Do not place credentials, private URLs, recipient data, database content, or reproducible access tokens in a public issue.

Include the affected commit, minimal reproduction steps, impact, and a redacted proof. Rotate any credential that may have been exposed before sharing evidence.

## Secrets

- `ADMIN_PASSWORD_HASH` must be a generated scrypt hash; the plaintext password belongs only in a password manager.
- `ADMIN_SESSION_SECRET`, `OBSERVATION_SECRET`, and `OPERATOR_SECRET` must each contain at least 32 high-entropy characters and must not be reused. The observation credential can report status only; the operator credential can mutate recipients, credits, subscriptions, and ambiguous receipt resolutions and can query per-recipient evidence.
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

Use a SQLite-aware online backup or stop the application cleanly before copying the database. Never copy only the main file while writes are active. Back up the matching local-secret file or external secret-manager material. Encrypt backups, restrict access, define retention, and routinely restore into an isolated path. Inspect a restored copy first with `SELF_HOSTED_READ_ONLY=1`, which disables bootstrap, observation mutation, polling, delivery work, and in-flight recovery. An untested backup is not a recovery capability.

Use a dedicated data directory; the built-in runtime rejects the project root, filesystem root, and symbolic-link redirects as data targets. A new POSIX directory is created owner-only, while an existing POSIX directory must already be owner-only rather than being silently re-permissioned. On Windows, mode flags are not an ACL boundary: run under a dedicated account and explicitly restrict NTFS permissions on the data, config, environment, logs, and backups.

## Delivery evidence

An HTTP 2xx from the configured sender is recorded as `accepted`; it does not establish handset display. A request that may have started but lacks a definitive response is `ambiguous`, retains reserved accounting, and requires evidence before manual resolution. Do not replay ambiguous work with a new idempotency key merely to make a dashboard appear successful.

## 中文摘要

真实密钥、状态地址、通知鉴权、数据库和备份都必须放在 Git 之外。源码、测试、截图、Issue 和 PR 不得包含真实部署数据；运营者应最小化收集并设置保留和删除规则。公网部署需要 HTTPS、反向代理、防火墙和额外限流。观察接口支持 Bearer 或对“时间戳 + 原始请求体”计算的 HMAC。SQLite 版本只按单进程使用；备份必须经过真实恢复测试。发送端接受请求不等于手机已经显示通知。
