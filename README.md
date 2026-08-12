# Live Reminder Platform / 直播提醒平台

A starter kit for one operator to run live-status monitoring and WeChat reminders for their users.

一位运营者部署一次直播状态监控和微信提醒服务，普通用户直接使用其小程序，不需要自己购买服务器。

[Download v1.1.0 / 下载 v1.1.0](https://github.com/drfellingood/live-reminder-platform-public/releases/tag/v1.1.0)

> [!IMPORTANT]
> This is source code and a reusable template, not a ready-made online service. / 这是源码模板，不是下载后立即可用的在线服务。

## Ask AI to help / 让 AI 帮你配置

Replace the target link, then send the whole block to any AI assistant. / 替换目标链接，再把整段发给任意 AI 助手。

<details>
<summary><strong>Need help? Copy this prompt / 不会配置？点击复制提示词</strong></summary>

```text
Please guide me through this project step by step. 请一步一步帮我配置这个项目。

Repository / 项目地址：
https://github.com/drfellingood/live-reminder-platform-public

Target page / 我想监控的公开页面：
[PASTE THE PUBLIC PAGE URL HERE / 在这里粘贴链接]

First confirm that you can read the repository. If not, ask me to upload the public source ZIP or needed public guide; do not guess. Ask whether I want the demo or real deployment, and which operating system I use. Give me one step at a time.
先确认你能读取仓库；如果不能，让我上传公开源码 ZIP 或所需说明，不要猜测。询问我是体验演示还是真实部署，以及使用什么系统。每次只给我一个步骤。

For real use, help me configure my own Mini Program, HTTPS server, notification template, and authorized status API or adapter. An ordinary page URL cannot be monitored directly. Never request secrets or real user data, and do not publish or deploy without my approval.
正式使用时，帮我配置自己的小程序、HTTPS 服务器、通知模板和合法获授权的状态接口或适配器；普通页面链接不能直接监控。不要索取密钥或真实用户数据，未经我确认不要上传或部署。
```

</details>

## Quick demo / 快速体验

Uses fictional data and sends no real notifications. Install [Node.js 22.13+](https://nodejs.org/en/download), download the source, then run: / 使用虚构数据且不发送通知；安装 Node.js 并下载源码后运行：

```powershell
npm ci
npm run demo
```

Open the local address and use the temporary password shown in the terminal. / 打开终端显示的本机地址并使用临时密码；Windows 如阻止 `npm`，可改用 `npm.cmd`。

## Real use needs / 正式使用需要

1. Your own WeChat Mini Program and subscription-message template / 自己的小程序和订阅消息模板
2. One HTTPS server and accepted domain / 一台带 HTTPS 域名的服务器
3. An authorized status API or adapter returning `live`, `offline`, or `unknown` / 合法获授权的开播状态接口或适配器

A normal livestream page is only the monitoring target; it is not automatically a status API.

普通直播页面只是监控目标，不能直接当作可靠状态接口。

## Setup guides / 配置说明

[Mini Program / 小程序](docs/WECHAT_MINIPROGRAM.md) · [Configuration / 配置](docs/CONFIGURATION.md) · [Deployment & backups / 部署备份](docs/DEPLOYMENT.md) · [Security / 安全](SECURITY.md)

## Important limits / 重要边界

Users must approve reminders; sender `accepted` does not prove phone display. Test the real template, backups, security, and phone delivery before launch. / 用户需主动授权；接口接受不代表手机弹出，正式开放前请完成真实测试。

## License / 许可证

`AGPL-3.0-only`; dependencies retain their licenses. See [third-party notices / 第三方声明](THIRD_PARTY_NOTICES.md).
