# Admin dashboard

The administration interface is English-first and includes a Chinese switch on the login and authenticated views.

## Isolated local demo

```powershell
npm ci
npm run demo
```

The command prints a loopback URL and temporary password. The demo:

- binds only to `127.0.0.1`;
- uses fictional in-memory records;
- does not instantiate the reminder core;
- does not persist data, poll status, or call a delivery endpoint;
- reuses the same authenticated HTTP and web-interface seam as self-hosted mode.

Demo counts are presentation fixtures, not operational evidence.

## Self-hosted dashboard

Build the web interface, configure the private runtime described in [Deployment](DEPLOYMENT.md), and open `/admin` through the protected service URL. The self-hosted root `/` redirects to `/admin`; it never serves the fictional client demo. The self-hosted server reads `core.read({ kind: 'dashboard' })`; the browser never reads the database directly.

The browser dashboard receives only a strict aggregate projection:

- totals for broadcasters, recipients, events, and receipts;
- pending, in-flight, accepted, failed, ambiguous, and bookkeeping-pending counts;
- stable status and observation freshness per broadcaster;
- event denominator and per-status receipt reconciliation.

The projection excludes the core's top-level recipient array, eligible-recipient identifiers, and per-recipient receipts. Future extra core fields are not passed through automatically. The total recipient count remains available in `summary.recipients` without exposing identities.

An event denominator is frozen when its live event is created. A current dashboard total must not be substituted for that event-specific denominator.

## Per-recipient reconciliation

Use `POST /api/v1/operator/queries` with the separate `OPERATOR_SECRET` when an authorised operator needs to inspect one event or recipient. An event query is the supported path for listing the frozen denominator and each recipient's receipt, including `ambiguous` outcomes. After checking external sender evidence, an ambiguous receipt may be resolved through `POST /api/v1/operator/commands` with a unique `resolutionId`, explicit outcome, and non-empty evidence code or provider reference.

Per-recipient query results are sensitive operational data. Keep them out of browser dashboards, shared screenshots, public issues, analytics, and ordinary application logs. Executable PowerShell and curl examples are in [Configuration](CONFIGURATION.md#operator-command-and-query-http-contracts).

## Authentication and browser boundary

- The server fails before listening if the administrator hash, session secret, observation secret, operator secret, or core is missing.
- Passwords must contain at least 12 characters before hashing. `npm run admin:secrets` creates a suitable one-time password, scrypt hash, session secret, observation secret, and distinct operator secret.
- `OBSERVATION_SECRET` is only for realtime status submissions. `OPERATOR_SECRET` grants recipient, credit, subscription, manual receipt-resolution, and sensitive query access; never reuse or distribute it to status collectors.
- The browser receives a signed `HttpOnly`, `SameSite=Strict` session cookie. Keep `Secure` enabled behind HTTPS.
- Login throttling allows five failed attempts per address in 15 minutes and is process-local. Add proxy-level limits for public exposure.
- API responses disable caching. Static responses include content-security, frame, referrer, and browser-permission restrictions.
- `ADMIN_TRUST_PROXY=1` is safe only when the immediate proxy replaces untrusted forwarding headers.
- The dashboard contract is aggregate-only. Recipient identifiers and receipt details are available only through the separately authenticated operator query contract.
- Set `SELF_HOSTED_READ_ONLY=1` during evidence preservation or maintenance to block observations and operator commands while retaining admin and operator-query reads.

## Evidence labels

`accepted` means the configured sender accepted a request. The core deliberately records handset display as unverified. `ambiguous` means a request may have started but no definitive sender outcome is known. Neither status may be rewritten as handset delivery.

The dashboard is useful for reconciliation, but production acceptance still needs the exact event, frozen eligible-recipient denominator, one receipt per recipient, consistent accounting, and separate handset observations when those are being claimed.

## Troubleshooting

- Login rejected immediately: confirm the plaintext password matches `ADMIN_PASSWORD_HASH`; never replace the hash with plaintext.
- Login works on loopback but not behind HTTPS: confirm secure-cookie and proxy routing settings.
- Repeated 429 responses: wait for the rate-limit window and inspect proxy client-address handling; do not disable authentication.
- Dashboard returns 502: the injected core/dashboard adapter failed. Inspect redacted server logs and database health without printing secrets or recipient records.
- Counts are not terminal: inspect pending, in-flight, failed, ambiguous, and bookkeeping-pending receipts. Do not replay or delete evidence to force a green total.
- Observation returns 400: confirm it has a non-empty `observationId` and valid `observedAt` inside the server realtime window; the public response deliberately does not reveal which time check failed.
- Operator endpoint returns 401: confirm it uses the distinct `OPERATOR_SECRET`, not `OBSERVATION_SECRET`, and that an HMAC was calculated over the exact bytes sent.
- Mutation returns 403 `READ_ONLY`: keep querying evidence or deliberately disable read-only mode after the maintenance gate; do not bypass the server through direct database edits.

## 中文说明

后台默认英文，可切换中文。本机演示使用虚构内存数据，不会连接状态接口或发送通知。真实自托管根路径只会跳转到 `/admin`，浏览器只接收汇总计数、状态源和事件，不返回逐接收者数组。需要对账时，授权运维人员必须使用独立的 `OPERATOR_SECRET` 查询指定事件或接收者，且不得泄露逐人回执。`accepted` 仅代表发送端接受，`ambiguous` 代表结果不确定，两者都不能当作手机已显示。人工处理 `ambiguous` 必须携带唯一 `resolutionId` 和可核验证据；只读模式下可以继续查看，但禁止新观测和所有运维写入。
