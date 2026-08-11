# Live Reminder Platform

A self-hosted app that watches a live status and requests one reminder for each subscribed user.

## Ask AI to guide you / 让 AI 带你操作

**One step only:** copy the entire box below and send it to an AI assistant, such as Doubao or DeepSeek. The project address is already included.

**只需一步：** 复制下面整个文本框，发给任意 AI 助手（例如豆包或 DeepSeek）。项目地址已经包含在里面，不需要另外发送。

```text
Please help me set up this public project.
请帮我配置这个公开项目。

Project / 项目地址：
https://github.com/drfellingood/live-reminder-platform-public

Reply in the language I use.
请使用我当前使用的语言回复。

First confirm whether you can open and read the project link.
先确认你能否打开并读取项目链接。

If you cannot, ask me to paste the public README. Do not guess.
如果不能，请让我粘贴公开的 README，不要猜测项目内容。

Ask whether I use Windows, macOS, or Linux, and whether I want to
run the demo or self-host the project for real use.
先问我使用 Windows、macOS 还是 Linux，以及我想运行演示，
还是正式自托管。

Give me only one step and one command at a time. Explain the step,
then wait for my result before continuing.
每次只给我一个步骤和一条命令，解释作用，等我回复结果后再继续。

Never ask me to share passwords, tokens, private URLs, database files,
private configuration, or real user data.
不要让我提供密码、Token、私有网址、数据库、私有配置或真实用户资料。

Do not delete files, expose a service publicly, change firewall settings,
or deploy a real service without my explicit approval. I will complete
every sign-in and authorization step myself.
未经我明确同意，不要删除文件、开放公网、修改防火墙或正式部署。
所有登录和授权必须由我自己完成。

A working demo is not proof of real notification delivery. Before real use,
remind me to check configuration, backups, security, and end-to-end results.
演示成功不代表真实通知成功。正式使用前，提醒我检查配置、备份、
安全和端到端通知结果。
```

Product names are examples only; this project is not affiliated with these services. / 以上名称仅为举例，本项目与这些服务没有隶属或合作关系。

[中文说明](#中文说明)

> **Start here:** The demo works immediately. Real phone notifications do not. For real use, you must connect your own status API and notification service.

## Try the demo in 3 steps

### 1. Install Node.js

Install [Node.js 22.13 or newer](https://nodejs.org/en/download). npm is included with Node.js.

### 2. Download this project

[Download version 1.0.2](https://github.com/drfellingood/live-reminder-platform-public/archive/refs/tags/v1.0.2.zip), extract it, and open a terminal in the extracted folder.

You can also use Git:

```powershell
git clone https://github.com/drfellingood/live-reminder-platform-public.git
cd live-reminder-platform-public
```

### 3. Start the demo

```powershell
npm ci
npm run demo
```

If Windows PowerShell blocks `npm`, use `npm.cmd` instead.

The terminal shows:

- an address: `http://127.0.0.1:8788/admin`
- a temporary password

Open the address and enter the password. The demo uses fictional data and never sends a real notification. Press `Ctrl+C` to stop it.

## Use it for real

This is technical setup, not a no-code step. Ask a developer or server administrator for help if you do not already operate the services below.

You need both of these before real reminders can work:

1. an HTTPS status URL that returns JSON such as `{"status":"live"}`;
2. an HTTPS notification webhook that sends the reminder to your users.

This repository does not include either service or a mobile app.

Copy the example settings:

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

1. Add your channels, users, subscriptions, and status URL to `config/self-hosted.json`.
2. In `.env`, set `DELIVERY_MODE=webhook` and add your `DELIVERY_WEBHOOK_URL`.
3. Run `npm ci`, then `npm start`.
4. Save the password shown in the terminal and open `http://127.0.0.1:8787/admin`.

For the first check, make the status URL return `{"status":"offline"}` and confirm it in the dashboard. Then change it to `{"status":"live"}`. By default, detection can take one 120-second polling cycle plus a 10-second confirmation.

Keep passwords, tokens, private URLs, databases, and real user data out of Git.

## Important limits

- A webhook response saying “accepted” does not prove that a phone displayed the notification.
- A network or parsing error remains `unknown`; the app does not pretend the channel is offline.
- The included SQLite setup is for one running app process.

Before using real users or opening the server to the internet, read:

- [Configuration](docs/CONFIGURATION.md)
- [Deployment and backups](docs/DEPLOYMENT.md)
- [Admin dashboard help](docs/ADMIN_DASHBOARD.md)
- [Security policy](SECURITY.md)

## Update safely

Stop the app and back up the database, `.env`, private configuration, and secrets before updating. Follow the [deployment guide](docs/DEPLOYMENT.md) before replacing a running version.

## License

Project source is licensed under `AGPL-3.0-only`. Dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

---

## 中文说明

这是一个需要自行托管的直播状态提醒源码项目，不是手机安装包。

> **先看这里：** 演示版下载后可以直接运行。要给真实用户发送手机提醒，还必须接入你自己的状态接口和通知服务。

## 3 步运行演示

### 1. 安装 Node.js

安装 [Node.js 22.13 或更高版本](https://nodejs.org/en/download)。npm 会一起安装。

### 2. 下载项目

[点击下载 1.0.2 版本](https://github.com/drfellingood/live-reminder-platform-public/archive/refs/tags/v1.0.2.zip)，解压后在该文件夹打开终端。

也可以使用 Git：

```powershell
git clone https://github.com/drfellingood/live-reminder-platform-public.git
cd live-reminder-platform-public
```

### 3. 启动演示

```powershell
npm ci
npm run demo
```

如果 Windows PowerShell 不允许运行 `npm`，请改用 `npm.cmd`。

终端会显示：

- 后台地址：`http://127.0.0.1:8788/admin`
- 一个临时密码

打开地址并输入密码即可。演示只使用虚构数据，不会发送真实通知。按 `Ctrl+C` 停止。

## 正式使用

下面不是“无代码”操作。如果你还没有自己的接口和服务器，请让开发或运维人员协助。

你必须先准备好：

1. 一个 HTTPS 状态接口，返回 `{"status":"live"}` 这样的 JSON；
2. 一个 HTTPS 通知 webhook，负责把提醒发送给你的用户。

这个仓库不附带这两个服务，也不附带手机 App。

复制示例配置：

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

然后：

1. 在 `config/self-hosted.json` 填写主播、用户、订阅关系和状态接口。
2. 在 `.env` 设置 `DELIVERY_MODE=webhook`，并填写 `DELIVERY_WEBHOOK_URL`。
3. 运行 `npm ci`，再运行 `npm start`。
4. 保存终端显示的后台密码，再打开 `http://127.0.0.1:8787/admin`。

第一次测试时，先让状态接口返回 `{"status":"offline"}` 并在后台确认；再改为 `{"status":"live"}`。默认检测最多可能需要一个 120 秒轮询周期，再加 10 秒复核。

密码、token、私有网址、数据库和真实用户资料都不能上传到 Git。

## 重要限制

- 通知服务返回“已接受”，不等于手机一定显示了通知。
- 网络或解析错误会保持为 `unknown`，不会被假装成下播。
- 自带的 SQLite 版本只适合运行一个程序进程。

接入真实用户或把服务开放到公网前，请阅读：

- [配置说明](docs/CONFIGURATION.md)
- [部署与备份](docs/DEPLOYMENT.md)
- [后台使用与故障排查](docs/ADMIN_DASHBOARD.md)
- [安全说明](SECURITY.md)

## 安全更新

更新前先停止程序，并备份数据库、`.env`、私有配置和密钥。替换正在运行的版本前，请按[部署说明](docs/DEPLOYMENT.md)操作。

## 开源许可

项目源码使用 `AGPL-3.0-only` 许可。第三方依赖保留各自许可，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
