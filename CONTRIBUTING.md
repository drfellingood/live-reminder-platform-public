# Contributing

Contributions are reviewed through issues and pull requests. No contributor needs
access to an operator's server, credentials, recipients, or private evidence.

## Start here

Read the [architecture](docs/ARCHITECTURE.md),
[configuration guide](docs/CONFIGURATION.md), [security policy](SECURITY.md),
and [source provenance](docs/SOURCE_PROVENANCE.md).

Use Node.js 22.13 or newer and install the locked dependency graph:

```powershell
npm ci
npm run check
```

## Design rules

- Keep `createReminderCore` independent from HTTP, storage engines, and sender SDKs.
- Add providers through a storage, delivery, or status-source adapter.
- Preserve the distinct `live`, `offline`, and `unknown` states.
- Preserve deterministic idempotency, frozen event denominators, per-recipient
  receipts, and exact credit accounting.
- Treat `accepted` as sender acceptance only. It is not proof of handset display.
- Keep transaction callbacks synchronous and free from external I/O.
- Reject unknown configuration fields rather than silently choosing a default.

## Test and review workflow

For a defect, first add a failing test at the public interface that demonstrates the
problem. Prefer controllable clocks and injected HTTP or filesystem boundaries over
assertions about private call order.

Before opening a pull request, run:

```powershell
npm ci
npm run check
git diff --check
```

Record the exact commands and results in the pull-request template. A local pass is
not evidence that a public deployment or a handset notification works.

Repository maintainers should protect the default branch, require the CI check and
at least one approving review, require resolved review conversations, and disable
force pushes and branch deletion. Give direct write access only to trusted
maintainers; everyone else can contribute from a fork.

## Public-data boundary

- Use fictional identifiers, domains, timestamps, and fixtures.
- Never submit credentials, real endpoints, recipient records, databases, browser
  profiles, logs, private screenshots, or deployment backups.
- Do not deploy or send a real notification from a pull request unless an operator
  authorizes that separate action.
- Keep changes focused and document interface, schema, configuration, and migration
  effects.
- Update English documentation first and keep the Chinese explanation equivalent.
- Disclose copied or adapted material and its license; retain every required notice.

## License

By submitting repository-owned code, you agree that your contribution may be
distributed under `AGPL-3.0-only`. You retain copyright in your contribution unless
a separate written agreement says otherwise. Third-party material keeps its own
license and must be recorded in [Third-party notices](THIRD_PARTY_NOTICES.md).

## 中文说明

协作应通过 Issue 和 Pull Request 进行，不需要接触任何人的真实服务器、密钥、
接收者资料或生产日志。测试数据必须明显虚构。修复缺陷时先补一条能够复现问题的
失败测试，然后运行 `npm ci`、`npm run check` 和 `git diff --check`。

发送端返回 `accepted` 只表示发送端接收了请求，不代表手机已经显示通知。未经
运营者另行授权，不得从 Pull Request 部署服务或发送真实通知。贡献者提交的原创
代码可按 `AGPL-3.0-only` 分发，但贡献者通常仍保留自己那部分代码的著作权。
