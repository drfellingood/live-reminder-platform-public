# Source provenance

## Public implementation boundary

This repository records the vendor-neutral public implementation prepared on 2026-08-10.

The supported public runtime is the code in:

- `core/`;
- `adapters/storage/`;
- `adapters/delivery/`;
- `sources/`;
- `server/`;
- `src/`;
- their public tests and documentation.

It is designed to run with operator-owned endpoints, accounts, secrets, recipient data, and infrastructure. No private account is required by the source distribution.

## Excluded material

Earlier private ZIP archives, private production trees, production databases, logs, browser state, credentials, backups, incident evidence, and infrastructure configuration are not included in this repository. They are not build, test, or runtime dependencies of the public implementation and must not be copied into a public release.

Public fixtures use fictional identifiers and neutral data. A contributor who introduces real or third-party material must document the source, permission, and applicable license before merge.

## What this statement does not claim

This file documents the repository boundary and the intended public implementation date. It is not legal advice and does not assert a court-tested clean-room process, exclusive ownership of general ideas, or the absence of every possible third-party right.

Do not describe this repository as legally “clean-room” solely because private archives are excluded. A legal conclusion would require a separately documented process, contributor evidence, and qualified review.

## Dependencies and licenses

Direct runtime and build dependencies are installed from the package registry rather than copied into this repository. Their licenses remain separate from the repository license. See [Third-party notices](../THIRD_PARTY_NOTICES.md) and the installed packages' own license files.

Repository-owned source is offered under `AGPL-3.0-only`. That license does not replace or relicense third-party code.

## Release review

Before a public release:

1. review `git ls-files` for archives, database files, backups, private media, names, account identifiers, and environment files;
2. scan tracked content and history for secrets and private URLs without printing discovered values;
3. confirm public fixtures are fictional;
4. run the full test/build gate and Markdown relative-link check;
5. compare dependency declarations with [Third-party notices](../THIRD_PARTY_NOTICES.md);
6. record the reviewed commit and do not infer anything about unreviewed branches or external artifacts.

## 中文说明

本仓库记录的是 2026-08-10 整理的厂商中立公开实现。旧的私有 ZIP、生产代码树、数据库、日志、密钥、备份和事故证据不在仓库内，也不是运行依赖。本说明只界定公开仓库范围，不构成法律上的“洁净室”结论或完整权利保证。第三方依赖继续使用各自许可证。
