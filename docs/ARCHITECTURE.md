# Architecture

The project is a vendor-neutral self-hosted pipeline. The core knows only domain commands, queries, a transactional store, and a delivery port.

```text
operator-owned HTTPS status endpoint
                 |
      HTTP JSON source + poll scheduler
                 |
        observation composition seam
                 v
signed HTTP endpoint ------> reminder core <------ admin dashboard
                                  |
                      +-----------+-----------+
                      |                       |
              transactional store       delivery adapter
              (memory or SQLite)       (local or webhook)
```

## Core

`core/reminder-core.cjs` exports `createReminderCore({ store, delivery, clock, policy, readOnly })`. Its public object has three operations:

- `execute(command)` changes state;
- `read(query)` returns a dashboard, event, or recipient view;
- `close()` closes owned adapters.

Supported commands register recipients, grant idempotent credits, subscribe recipients, observe status, drain pending delivery work, and resolve an ambiguous outcome. External I/O never runs inside a store transaction.

### State semantics

- Valid observations are `live`, `offline`, and `unknown`.
- `unknown` records uncertainty but does not change stable state, create an event, reserve credit, or notify anyone.
- A transition to `live` freezes the eligible-recipient IDs and denominator at that event's creation time.
- Each event/recipient pair has one deterministic idempotency key and one receipt.
- Credit is reserved when the receipt is created, consumed after sender acceptance, and refunded after an explicit failure.
- An outcome that may have started but cannot be proven remains `ambiguous`; its credit stays reserved.
- A process restart converts abandoned `in-flight` receipts to `ambiguous` rather than guessing success or failure.
- Delivery work claims, sends, and settles one recipient at a time. A crash can therefore make only the attempt that actually started ambiguous; untouched recipients remain pending.
- `terminal` is a processing/accounting state. A successful event is stricter: every frozen recipient must be accepted, no receipt may be failed or ambiguous, and no bookkeeping may remain.

## Storage adapters

`adapters/storage/memory-store.cjs` is disposable and intended for tests or short-lived composition experiments.

`adapters/storage/sqlite-store.cjs` stores the complete versioned core state in one SQLite row. It serializes operations in process, uses `BEGIN IMMEDIATE`, WAL mode, full synchronous writes, and a five-second busy timeout. This design favors a clear atomic boundary over scale.

The SQLite adapter is a single-process reference store. Every transaction parses and rewrites the full logical state, so latency and file size grow with recipients, events, observations, and receipts. It has no built-in retention, partitioning, replication, or distributed worker lease. Operators must benchmark realistic data, define retention, and replace the store before horizontal or high-volume use.

## Delivery adapters

`adapters/delivery/local-inbox.cjs` keeps accepted envelopes in memory and deduplicates by `idempotencyKey`. It is a test tool, not a real sender.

`adapters/delivery/webhook.cjs` posts JSON to an operator-owned endpoint. It sends the idempotency key in the `Idempotency-Key` header, classifies 2xx as `accepted`, explicit non-2xx as `failed`, and network/timeout uncertainty as `ambiguous`. Custom headers allow operator-controlled authentication.

`accepted` describes the sender boundary only. All persisted receipts keep handset display as unverified.

## Status source and scheduler

`sources/http-json-status-source.cjs` reads an operator-owned endpoint returning `{ "status": "live|offline|unknown" }`. HTTPS is required except for explicitly enabled loopback development. Redirects, non-2xx responses, timeouts, network errors, invalid JSON, and invalid status values become `unknown`. Evidence excludes query strings.

`sources/poll-scheduler.cjs` polls immediately and then every 120 seconds by default. A possible `live` state is read again after 10 seconds before submission. Transitions receive idempotency IDs; repeated identical readings are forwarded as bounded heartbeats without transition IDs so freshness stays current without unbounded observation records. Confirmed-live evidence is flattened into scalar fields accepted by the core. These intervals are configurable composition inputs, not latency promises.

The three-state contract re-arms only after an observed `offline`. If polling or downtime misses a complete offline gap, the next `live` cannot prove that a new session began. A deployment needing stronger session identity must extend the source/core contract rather than infer it from status alone.

## HTTP and dashboard servers

`server/admin-server.cjs` owns login, signed sessions, security headers, static files, rate limiting, and the dashboard HTTP contract. It requires an injected `loadDashboard` function and does not know any storage or sender provider.

`server/self-hosted-server.cjs` adds the low-privilege observation endpoint plus separately authenticated operator command/query endpoints. The observation secret cannot mutate recipients, credits, subscriptions, or receipt resolutions. The aggregate browser dashboard omits per-recipient data; an operator query with the distinct operator secret is required for reconciliation. Read-only mode rejects every mutation. The server binds to loopback unless remote exposure is explicitly enabled.

`server/demo-server.cjs` injects fictional in-memory dashboard data. It shares the administration HTTP/UI seam but does not instantiate the core, persist records, read a status source, or deliver messages.

## Composition root

`server/start.cjs` is the default composition root. It validates configuration before consuming the first-run password, opens SQLite, chooses local-inbox or webhook delivery, bootstraps recipients/subscriptions, creates one scheduler per configured status source, drains pending work independently of polling, starts the server, and closes resources on process signals. Loopback first-run mode generates local secrets under the ignored data directory and prints the administrator password before listening. Read-only recovery mode opens the existing database without bootstrap, recovery mutation, polling, delivery work, or credential generation.

Recipient JSON is bootstrap input, not a declarative synchronization engine: restarting does not reset an existing recipient's credits, and removing a subscription from JSON does not automatically unsubscribe an existing record.

Advanced operators may compose the modules themselves or load a compatible core through `server/self-hosted-server.cjs`. That seam is appropriate when replacing storage, account management, worker coordination, or deployment lifecycle behavior.

No composition path hard-codes operator accounts or endpoints. Keep private JSON, environment values, custom modules, structured logs, and metrics outside Git when they contain real identifiers or credentials.

## Trust and evidence boundaries

- Status evidence can justify a state observation; it cannot prove sender or handset behavior.
- A sender response can justify `accepted` or `failed`; it cannot prove handset display.
- Dashboard totals are derived from persisted event and receipt records. They are not a substitute for external user experience evidence.
- Local tests prove behavior of the checkout under test. They do not prove deployment, availability, capacity, or universal delivery.

## 中文摘要

项目把状态来源、轮询、核心事务、存储、发送和管理后台分开。核心只处理领域命令，不依赖具体厂商。`unknown` 不改变稳定状态；开播事件会冻结有效接收者分母；每位接收者都有独立回执。SQLite 适配器只按单进程、小规模参考实现使用，真实高并发需要替换存储并重新验证。
