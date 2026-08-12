# Live Reminder Platform / 直播提醒平台

A starter kit for one operator to run live-status monitoring and WeChat reminders for their users.

一位运营者部署一次直播状态监控和微信提醒服务，普通用户直接使用其小程序，不需要自己购买服务器。

[Download v1.2.0 / 下载 v1.2.0](https://github.com/drfellingood/live-reminder-platform-public/releases/tag/v1.2.0)

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

For real use, help me configure my own Mini Program, HTTPS server, notification template, and one authorized status source. If my target is a canonical Douyin profile, check whether the included visible-browser adapter is suitable; do not claim that every share or livestream URL works. Never request secrets or real user data, bypass verification, or publish/deploy without my approval.
正式使用时，帮我配置自己的小程序、HTTPS 服务器、通知模板和一个合法获授权的状态源。如果目标是规范的抖音用户主页，先判断内置的可视浏览器适配器是否适合；不要声称任意分享链接或直播链接都能使用。不要索取密钥或真实用户数据，不要绕过安全验证，未经我确认不要上传或部署。
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
3. One authorized status source: the optional visible-browser adapter for a canonical Douyin profile, or your own status API / 一个获授权的状态源：可选的抖音规范主页可视浏览器适配器，或你自己的状态接口

A normal page is not automatically a reliable status source. The included page adapter accepts only canonical `https://www.douyin.com/user/...` profiles, needs an operator-controlled signed-in visible Chromium browser, and returns `unknown` on verification, rate limits, identity mismatch, or incomplete evidence.

普通页面不能自动当作可靠状态源。内置页面适配器只接受规范的 `https://www.douyin.com/user/...` 用户主页，需要运营者自己的已登录可视 Chromium；遇到验证、限流、身份不符或证据不完整时只返回 `unknown`。

## Setup guides / 配置说明

[Page detector / 页面检测器](docs/DOUYIN_PAGE_DETECTOR.md) · [Mini Program / 小程序](docs/WECHAT_MINIPROGRAM.md) · [Configuration / 配置](docs/CONFIGURATION.md) · [Deployment & backups / 部署备份](docs/DEPLOYMENT.md) · [Security / 安全](SECURITY.md)

## Important limits / 重要边界

Users must approve reminders; sender `accepted` does not prove phone display. Test the real template, backups, security, and phone delivery before launch. / 用户需主动授权；接口接受不代表手机弹出，正式开放前请完成真实测试。

## License / 许可证

`AGPL-3.0-only`; dependencies retain their licenses. See [third-party notices / 第三方声明](THIRD_PARTY_NOTICES.md).
