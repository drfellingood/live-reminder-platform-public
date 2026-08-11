# Live Reminder Platform

A vendor-neutral, self-hosted source release for monitoring live-status changes and sending one auditable reminder request per eligible recipient.

This release includes no cloud account, messaging account, real recipient data, private endpoint, or mobile client. The local demo works immediately. Real reminders require an operator-owned HTTPS status endpoint, HTTPS delivery webhook, server, and credentials.

## Download

Choose either method:

1. Open the repository on GitHub, select **Code → Download ZIP**, extract it, and open a terminal in the extracted folder; or
2. clone it with Git:

```powershell
git clone https://github.com/drfellingood/live-reminder-platform-public.git
cd live-reminder-platform-public
```

## Requirements

- Node.js 22.13 or newer.
- npm 10 or newer.

Confirm the installed versions:

```powershell
node --version
npm --version
```

## Five-minute local demo

Install the locked dependencies and start the isolated demo:

```powershell
npm ci
npm run demo
```

The terminal prints `http://127.0.0.1:8788/admin` and a temporary password. Open that address and sign in. Demo records are fictional, remain in memory, and never poll an external status source or send a real notification. Press `Ctrl+C` in the terminal to stop it.

## Start the self-hosted runtime locally

After `npm ci`, run:

```powershell
npm start
```

The first loopback-only start creates `.data/live-reminder.sqlite` and `.data/local-secrets.json`, then prints the administrator password once. Save that password immediately and open `http://127.0.0.1:8787/admin`.

Without private configuration, the runtime has no recipients or status sources and uses a process-memory local inbox. It cannot notify a phone.

## Configure real detection and delivery

Copy the supplied examples to the ignored private paths.

Windows PowerShell:

```powershell
Copy-Item server/self-hosted.env.example .env
Copy-Item config/self-hosted.example.json config/self-hosted.json
```

macOS or Linux:

```bash
cp server/self-hosted.env.example .env
cp config/self-hosted.example.json config/self-hosted.json
```

Then:

1. Put authorised recipient identifiers, subscriptions, and your HTTPS status endpoint in `config/self-hosted.json`.
2. For real delivery, set `DELIVERY_MODE=webhook` and provide your HTTPS webhook settings in `.env`.
3. Keep all tokens and generated secrets outside JSON and outside Git.
4. Run `npm start`, sign in to `/admin`, and verify status, denominator, receipt, failure, ambiguous, restart, and backup behaviour before enabling real recipients.

The status endpoint must return exactly one supported state:

```json
{ "status": "live" }
```

Allowed values are `live`, `offline`, and `unknown`. Network, timeout, parsing, redirect, or security-challenge failures become `unknown`; uncertainty is never converted to `offline`.

The delivery webhook receives one request per eligible recipient with a deterministic `Idempotency-Key`. A sender `2xx` response means only that the sender accepted responsibility for the request. It does not prove that a handset displayed a notification.

Follow these guides before using real data or exposing the server:

- [Configuration and integration contracts](docs/CONFIGURATION.md)
- [Deployment, backup, recovery, and upgrades](docs/DEPLOYMENT.md)
- [Admin dashboard and troubleshooting](docs/ADMIN_DASHBOARD.md)
- [Security policy](SECURITY.md)

## Build check

To confirm that the downloaded source compiles on the current machine:

```powershell
npm run build
```

A successful build proves only that this checkout compiled. It does not prove a deployment is healthy or that a phone displayed a notification.

## Updating

Before changing versions, stop the process and back up the closed SQLite database, `.data/local-secrets.json` or externally managed secrets, `.env`, and private JSON configuration. Install the new source in a clean folder, run `npm ci` and `npm run build`, read the deployment notes, then connect a disposable restored copy in read-only mode before replacing a running instance. Never overwrite the only database or secret copy.

## License

Repository-owned source is licensed under `AGPL-3.0-only`. Network operators who modify and deploy it must preserve the corresponding-source obligations of that license. Dependencies retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

---

## 中文使用说明

这是一个厂商中立、可自行托管的直播状态提醒源码版本。它不附带任何云账号、消息账号、真实用户、私有接口或手机端。虚构演示可以直接运行；如果要发送真实提醒，使用者必须接入自己有权使用的 HTTPS 状态接口、HTTPS 通知 webhook、服务器和密钥。

### 1. 下载

可以在 GitHub 页面点击 **Code → Download ZIP**，解压后在该文件夹打开终端；也可以运行：

```powershell
git clone https://github.com/drfellingood/live-reminder-platform-public.git
cd live-reminder-platform-public
```

需要 Node.js 22.13 或更高版本、npm 10 或更高版本。

### 2. 先运行安全演示

```powershell
npm ci
npm run demo
```

终端会显示 `http://127.0.0.1:8788/admin` 和临时密码。演示只使用虚构内存数据，不连接状态接口，也不发送真实通知。按 `Ctrl+C` 停止。

### 3. 启动本机自托管版本

```powershell
npm start
```

首次启动会生成 `.data/live-reminder.sqlite`、本机密钥，并只显示一次后台密码。请立即保存密码，然后打开 `http://127.0.0.1:8787/admin`。没有私有配置时，系统没有接收者和状态来源，只使用内存收件箱，不能通知手机。

### 4. 接入真实状态和通知

Windows PowerShell：

```powershell
Copy-Item server/self-hosted.env.example .env
Copy-Item config/self-hosted.example.json config/self-hosted.json
```

macOS 或 Linux：

```bash
cp server/self-hosted.env.example .env
cp config/self-hosted.example.json config/self-hosted.json
```

在 `config/self-hosted.json` 填写自己有权使用的接收者、订阅关系和 HTTPS 状态接口；在 `.env` 把发送方式设为 `webhook`，并填写自己的 HTTPS 通知端配置。密钥和 token 不得写进 Git。

状态接口只能返回 `live`、`offline` 或 `unknown`。网络错误必须保持 `unknown`，不能假装成下播。发送端返回 `2xx` 只代表它接受了请求，不代表手机一定显示了通知。

真实使用前请阅读：

- [配置与接口说明](docs/CONFIGURATION.md)
- [部署、备份、恢复和升级](docs/DEPLOYMENT.md)
- [后台与故障排查](docs/ADMIN_DASHBOARD.md)
- [安全策略](SECURITY.md)

更新版本前必须停止程序并备份数据库、密钥、`.env` 和私有 JSON。先在新目录执行 `npm ci` 与 `npm run build`，使用只读恢复副本验证后，再替换正在运行的版本。
