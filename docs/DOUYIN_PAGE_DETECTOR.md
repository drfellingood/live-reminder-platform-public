# Optional Douyin page detector / 可选抖音页面检测器

This adapter is for an operator who is permitted to automate checks of a target profile. It is not a Douyin Open Platform API, is not endorsed by Douyin, and is not a promise that every public or shared URL works.

该适配器供有权对目标主页进行自动检查的运营者使用。它不是抖音开放平台接口，不代表抖音官方认可，也不承诺任意公开链接或分享链接都能使用。

## What it does / 它做什么

- attaches to your own visible, already signed-in Chromium browser through loopback CDP;
- accepts only a canonical `https://www.douyin.com/user/<identity>` profile;
- checks fresh profile evidence for the expected identity and a valid live-room ID;
- returns only `live`, `offline`, or `unknown` to the reminder core;
- requires two matching readings for either a live or offline transition.

- 通过本机 CDP 连接你自己的、可视且已登录的 Chromium 浏览器；
- 只接受规范的 `https://www.douyin.com/user/<身份标识>` 用户主页；
- 用当次新鲜资料同时核对目标身份、开播状态和有效直播间 ID；
- 只向提醒核心返回 `live`、`offline` 或 `unknown`；
- 开播和下播变化都必须连续两次结果一致。

Verification pages, rate limits, browser disconnection, redirects, identity mismatch, missing fields, conflicting room data, timeout, and unclassified errors all become `unknown`. `unknown` never creates a reminder or consumes a credit. The adapter does not solve or bypass verification.

验证页面、限流、浏览器断开、跳转、身份不符、字段缺失、直播间证据冲突、超时和未分类错误都会变成 `unknown`。`unknown` 不会创建提醒或消耗额度；适配器不会破解或绕过验证。

## Minimal setup / 最少配置

1. Copy `config/douyin-page.example.json` to the ignored `config/self-hosted.json`.
2. Replace `sample_identity`, the URL, channel ID, and display text with a canonical profile you are authorized to monitor. The final URL path and `expectedIdentity` must match exactly.
3. Start a dedicated visible Chrome, Chromium, or Edge profile with remote debugging bound to loopback port `9222`. Sign in manually in that browser. Do not use your everyday browser profile.
4. Set this server-only value in the ignored `.env` file:

```dotenv
STATUS_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
```

5. Run `npm start`. Keep the visible browser running. If a verification page appears, handle it manually or stop monitoring; never add automated bypass code.

This example verifies detection only: it deliberately keeps `client.enabled` off and uses no phone delivery. For real WeChat reminders, merge its `browser` and `statusSources` blocks into your private Mini Program configuration and complete [the Mini Program setup](WECHAT_MINIPROGRAM.md), including `DELIVERY_MODE=wechat-subscribe` and your own WeChat values.

这个示例只验证检测：它故意关闭 `client.enabled`，也不会向手机发送通知。要发送真实微信提醒，请把其中的 `browser` 和 `statusSources` 配置合并到你的小程序私有配置，并完成[小程序设置](WECHAT_MINIPROGRAM.md)，包括 `DELIVERY_MODE=wechat-subscribe` 和你自己的微信配置。

1. 把 `config/douyin-page.example.json` 复制为已被 Git 忽略的 `config/self-hosted.json`。
2. 将 `sample_identity`、主页 URL、频道 ID 和显示文字替换成你有权监控的规范主页；URL 最后一段必须与 `expectedIdentity` 完全一致。
3. 使用独立资料目录启动一份只绑定本机 `9222` 端口的可视 Chrome、Chromium 或 Edge，并由你亲自登录；不要使用日常浏览器资料。
4. 在被忽略的 `.env` 中设置上面的 `STATUS_BROWSER_CDP_ENDPOINT`。
5. 运行 `npm start` 并保持浏览器开启。出现验证页面时只能人工处理或停止监控，不要加入自动绕过功能。

The repository deliberately does not include a browser profile, cookies, account values, target identity, or a command that weakens browser security. Keep the dedicated profile outside the repository (preferred) or under the ignored `.data/browser-profile/` directory. Ask an AI assistant to help with the exact browser-launch command for your operating system, but do not send it passwords, cookies, tokens, private browser files, or real user data.

仓库不会提供浏览器资料、Cookie、账号值、真实目标身份或削弱浏览器安全的启动命令。你可以让 AI 根据操作系统给出具体启动命令，但不要把密码、Cookie、Token、私有浏览器文件或真实用户数据发给 AI。

## Security and reliability boundary / 安全与可靠性边界

- Never expose, proxy, or tunnel the CDP port. Anyone who can reach it can control the signed-in browser.
- Use a dedicated operating-system account or browser profile and restrict its files.
- Do not add proxy rotation, fingerprint evasion, CAPTCHA solving, or challenge bypass.
- The page contract is not a stable public API and may change without notice. Treat sustained `unknown` as an operator alert, not as offline.
- The runtime serializes page reads and applies a minimum spacing. It rejects configurations whose declared worst-case batch cannot fit inside the shortest poll interval.
- The reference runtime is single-process and has no built-in browser restart service, distributed scheduler, or challenge alert channel.

- 绝不能公开、反向代理或穿透 CDP 端口；能访问该端口的人可以控制已登录浏览器。
- 使用专用系统账号或浏览器资料，并限制文件访问权限。
- 不要加入代理轮换、指纹规避、验证码破解或安全验证绕过。
- 页面契约不是稳定的公开接口，可能随时变化；持续 `unknown` 应视作需要运营者处理，不能当作下播。
- 运行时会串行读取并保留最小间隔；如果配置的最坏批次无法放进最短轮询周期，会拒绝启动。
- 参考运行时是单进程，不内置浏览器重启服务、分布式调度器或验证码告警通道。

Before real use, review the current platform terms and obtain any permission your use requires. The code has local fake-driver tests only; a real account, real page, platform review, Mini Program send, and handset display are not verified by this repository.

正式使用前，请查看平台当前规则并取得你的使用场景所需许可。仓库只完成本地假驱动测试；真实账号、真实页面、平台许可、小程序发送和手机显示均不由这些测试证明。

Where you qualify for an official authorized live-status callback or SDK, prefer that stable route and expose its result through the existing `http-json` adapter. Review the current [Douyin developer documentation](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/douyin-live-sdk/douyin-live-sdk/interface-and-function) and [service agreement](https://www.douyin.com/agreements/?id=6773906068725565448) rather than assuming that a public page grants automation permission.

如果你的账号符合官方授权回调或 SDK 的条件，应优先使用更稳定的官方路径，再通过现有 `http-json` 适配器接入。请查看当前的[抖音开发者文档](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/douyin-live-sdk/douyin-live-sdk/interface-and-function)和[服务协议](https://www.douyin.com/agreements/?id=6773906068725565448)，不要把“页面公开可见”等同于“允许自动化访问”。
