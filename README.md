# Live Reminder Platform / 直播提醒平台

A self-hosted reminder server, admin dashboard, and WeChat Mini Program template.

一位运营者搭建一个服务和一个小程序，提供给所有普通用户使用。普通用户只需打开小程序、选择目标并主动授权提醒；**不需要**自己购买服务器或申请小程序。

> [!TIP]
> **Don't know how to set it up? / 不会配置？**
>
> Replace the target link below, then copy the **whole prompt once** to an AI assistant, such as Doubao or DeepSeek. Link-reading ability varies by version, so the prompt tells the AI to check first.
>
> 把下面的目标链接换成你想监控的公开页面，再把**整段提示词一次性**发给 AI，例如豆包或 DeepSeek。不同版本读取链接的能力不同，所以提示词会先让 AI 确认。

```text
Help me set up this public project one step at a time:
请一步一步帮我配置这个公开项目：

https://github.com/drfellingood/live-reminder-platform-public

The public page I want to monitor is / 我想监控的公开页面是：
[PASTE THE PUBLIC PAGE URL HERE / 在这里粘贴公开页面链接]

First confirm that you can read the repository. If not, ask me to upload the
public source ZIP or paste the public README and any needed public guide; do
not guess files, commands, or features. Ask whether I want only the
demo or a real Mini Program for my users, and ask whether I use Windows,
macOS, or Linux. Then give me only one step and one command at a time.
先确认你能读取仓库；如果不能，让我上传公开源码 ZIP，或按需粘贴公开 README 和说明文档，
不要猜测文件、命令或功能。再问我是只运行演示，
还是给用户搭建真实小程序，并询问我使用
Windows、macOS 还是 Linux。之后每次只给我一个步骤和一条命令，等我回复后再继续。

For real use, help me configure my own Mini Program, HTTPS server/domain,
subscription-message template, and an authorized status API or adapter that
returns live, offline, or unknown. The page URL above is only the monitoring
target; do not claim this project can monitor an ordinary page URL directly.
正式使用时，帮我配置自己的小程序、HTTPS 服务器和域名、订阅消息模板，以及合法获授权、
能返回 live、offline 或 unknown 的状态接口或适配器。上面的页面链接只是监控目标，
不要声称本项目能直接监控普通页面链接。

Never ask me to paste passwords, AppSecret, tokens, private URLs, databases,
private configuration, or real user data into chat. Show me where to enter
secrets locally. I must complete sign-in and authorization myself. Do not
upload, publish, open public ports, or deploy a real service without my clear
approval. A successful demo is not proof that a phone received a notification.
不要让我在聊天中粘贴密码、AppSecret、Token、私有网址、数据库、私有配置或真实用户资料。
只告诉我应在本机哪里填写；登录和授权由我自己完成。没有我的明确同意，不要上传小程序、
正式发布、开放公网端口或部署真实服务。演示成功不代表手机已经收到通知。
```

AI product names are examples only. This project is not affiliated with any AI assistant or livestream platform.

AI 或平台名称仅用于举例，本项目与它们没有隶属或合作关系。

## Quick demo / 快速体验

The demo uses fictional data and sends no real notification.

演示只使用虚构数据，不会发送真实通知。

1. Install [Node.js 22.13 or newer](https://nodejs.org/en/download).
2. [Download and extract the source](https://github.com/drfellingood/live-reminder-platform-public/archive/refs/heads/main.zip).
3. Open a terminal in that folder and run:

```powershell
npm ci
npm run demo
```

Open the local address printed by the terminal and use its temporary password. On Windows, use `npm.cmd` if PowerShell blocks `npm`. Press `Ctrl+C` to stop.

安装 Node.js，下载并解压源码，在该目录运行上面的两条命令。终端会显示本机后台地址和临时密码。

## Real use / 正式使用

The operator needs only these three external pieces:

1. their own WeChat Mini Program and subscription-message template;
2. one HTTPS server and accepted domain;
3. an authorized status API or adapter that reports `live`, `offline`, or `unknown`.

运营者需要准备三样外部资源：自己的微信小程序和订阅消息模板、带 HTTPS 域名的服务器，以及合法获授权的开播状态接口或适配器。服务器、后台和小程序代码都已包含在本仓库中。

Use the AI prompt above for guided setup. The detailed references are:

- [Mini Program setup / 小程序接入](docs/WECHAT_MINIPROGRAM.md)
- [Configuration / 配置](docs/CONFIGURATION.md)
- [Deployment and backups / 部署与备份](docs/DEPLOYMENT.md)
- [Security / 安全](SECURITY.md)

## Important / 重要

- A normal livestream page URL is not a reliable status API.
- Users must actively approve subscription reminders in the Mini Program.
- Sender `accepted` means only that the provider accepted the API request; it does not prove handset display.
- Test the real template, consenting test accounts, backups, security, and phone delivery before inviting users.

- 普通直播页面链接不能直接当作可靠状态接口。
- 用户必须在小程序中主动授权订阅提醒。
- `accepted` 只代表发送接口接受请求，不证明手机已经弹出通知。
- 邀请真实用户前，必须验证真实模板、测试账号、备份、安全和手机实际到达。

## License / 许可证

Project source is licensed under `AGPL-3.0-only`. Dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

项目源码使用 `AGPL-3.0-only` 许可证；依赖保留各自许可证，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
