# Public repository operating rules

Apply these rules before changing, testing, documenting, or releasing this repository.

1. Use Node.js 22.13 or newer. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, and `docs/SOURCE_PROVENANCE.md` before substantial work.
2. Keep the core vendor-neutral. Provider-specific behavior belongs behind status-source, storage, or delivery interfaces.
3. Preserve the status contract: `unknown` never changes stable state, creates an event, or consumes credit. Do not translate uncertainty into `offline`.
4. Preserve event idempotency, the frozen eligible-recipient denominator, per-recipient receipts, and explicit `accepted`/`failed`/`ambiguous` outcomes.
5. Never describe sender acceptance as handset display. Local tests, a build, or an HTTP 2xx response do not prove real delivery.
6. Treat the SQLite adapter as single-process storage. Do not claim horizontal scalability without a new store, distributed worker coordination, load evidence, and tests.
7. Keep real people, account identifiers, recipient data, production events, secrets, URLs, database files, backups, logs, and private infrastructure details out of Git.
8. Keep runtime composition and `.env` files under ignored private paths. Never expose server secrets through browser-prefixed environment variables or client code.
9. Bug fixes require a regression test through a public interface. Run `npm run check`, a secret/identity scan, a relative-link check, and `git diff --check` before a public push.
10. Do not deploy, contact real recipients, mutate a live database, or run a write-producing smoke test unless an operator explicitly authorizes that separate action.
11. Keep documentation English-first and preserve concise, accurate Chinese guidance where present.
12. Do not add historical archives, private source trees, forensic evidence, generated release bundles, or unsupported provenance claims to this repository.
