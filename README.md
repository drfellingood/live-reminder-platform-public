# Live Reminder Platform

A vendor-neutral, self-hosted reference implementation for detecting live-status changes, freezing an eligible-recipient denominator, and reconciling reminder attempts per recipient.

The repository does not require a particular cloud account or messaging provider. An operator supplies their own HTTPS status endpoint, delivery webhook, credentials, recipient data, and hosting environment.

## What is included

- A small reminder core with idempotent observations, frozen event denominators, credit reservation, and per-recipient receipts.
- In-memory and single-process SQLite storage adapters.
- A local inbox for tests and a generic HTTPS webhook delivery adapter.
- An HTTP JSON status source and a poll scheduler with a 120-second default interval and a 10-second live confirmation.
- A fail-closed self-hosted HTTP server and an English-first administration dashboard with a Chinese switch.
- A fictional, loopback-only demo that does not persist data or contact external services.

## Requirements

- Node.js 22.13 or newer.
- npm 10 or newer.

## Try the isolated demo

```powershell
npm ci
npm run demo
```

The terminal prints `http://127.0.0.1:8788/admin` and a temporary password. Demo records are fictional and remain in memory. This proves only that the local demo can run; it does not configure detection, persistence, delivery, or a public service.

## Validate a checkout

```powershell
npm run check
```

Local tests and builds are source-level evidence only. They do not prove that a deployed service is healthy, that every eligible recipient was processed, or that a handset displayed a notification.

## Start the self-hosted runtime locally

```powershell
npm start
```

On first loopback start, the runtime creates an ignored `.data/` directory, a SQLite database, and local secrets, then prints the one-time administrator password. With no private configuration it has no recipients or status sources and uses the in-memory local inbox; it cannot send a real notification.

## Configure a real self-hosted instance

The included composition root can connect the core to:

1. a protected SQLite file or another compatible store;
2. the operator's HTTPS delivery webhook;
3. the operator's HTTPS JSON status endpoint or signed observation sender;
4. a delivery-worker schedule and secret management.

Create private JSON/environment configuration outside Git and follow [Deployment](docs/DEPLOYMENT.md). The runtime binds to loopback by default; remote mode requires four explicit, independent server secrets. Advanced operators may bypass the default composition root and inject another compatible core module into `server/self-hosted-server.cjs`.

The expected status response is deliberately small:

```json
{ "status": "live" }
```

Allowed values are `live`, `offline`, and `unknown`. Network errors, oversized or malformed responses, redirects, and upstream security challenges become `unknown`; uncertainty must never be converted to `offline`.

A later `live` state creates a new event only after the core has observed `offline`. If the service misses an entire offline gap, a status-only source cannot distinguish a new session from the previous live session. Operators that need that guarantee must supply a session/generation identifier through a custom source design.

## Delivery boundary

`accepted` means only that the configured sender accepted the request. It is not proof of handset display. Timeouts after a request may have started remain `ambiguous` until an operator obtains evidence and resolves them with the separate operator credential. `terminal` means processing and accounting have ended; it does not mean the event succeeded. A system-level success additionally requires `failed = 0`, `accepted = denominator`, `bookkeepingPending = 0`, consistent counts, and no ambiguous outcome.

## Repository map

- `core/reminder-core.cjs` — domain state machine and reconciliation contract.
- `adapters/storage/` — in-memory and SQLite persistence.
- `adapters/delivery/` — local inbox and generic webhook delivery.
- `sources/` — HTTP JSON status reading and poll scheduling.
- `server/` — default composition root, demo, administrator, and self-hosted HTTP servers.
- `src/` — web interface.
- `tests/` — public-interface regression tests.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Admin dashboard](docs/ADMIN_DASHBOARD.md)
- [Source provenance](docs/SOURCE_PROVENANCE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Maintaining the repository on GitHub

The repository includes a read-only CI workflow, issue forms, and a pull-request
checklist. After creating the GitHub repository, invite only trusted maintainers with
write access and protect the default branch: require CI, at least one approving
review, resolved conversations, and disable force pushes and branch deletion. Other
contributors can work from forks. See [Contributing](CONTRIBUTING.md) before accepting
code or third-party material.

## 中文简介

这是一个厂商中立、可自行托管的直播状态提醒参考实现。默认演示只在本机运行，使用虚构内存数据，不会连接外部服务。真实使用时，部署者需要提供自己的 HTTPS 状态接口、通知 webhook、账号、密钥、订阅者数据和服务器。

项目把 `unknown` 当作不确定状态，不会把网络错误误判成下播。发送端返回 `accepted` 只代表请求被发送端接受，不代表手机已经显示通知。真实部署请先阅读[部署文档](docs/DEPLOYMENT.md)和[安全策略](SECURITY.md)。

## License

Repository-owned source code is licensed under `AGPL-3.0-only`. Dependencies remain under their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
