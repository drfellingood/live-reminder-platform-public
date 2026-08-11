# WeChat Mini Program setup

This guide is for the operator who creates one Mini Program for their users. Ordinary subscribers do not deploy the project themselves.

这份说明面向小程序运营者。普通用户不需要自己部署服务器，也不需要自己申请小程序。

## 1. What is included

The repository contains:

- a self-hosted status and reminder server;
- an admin dashboard;
- a four-tab, English-first Mini Program client with Chinese switching;
- server-side WeChat login and subscribe-message adapters;
- SQLite storage for reminder state and encrypted external identity data.

It does not include a WeChat account, AppID, AppSecret, message template, domain, TLS certificate, server account, or an adapter for a particular livestream page. Every operator supplies their own.

仓库已经包含服务器、后台和双语小程序模板，但不包含任何人的微信账号、AppID、AppSecret、消息模板、域名、证书、云账号或特定直播平台适配器。这些都必须由运营者自己准备。

## 2. Prepare your own services

Before real use, prepare:

1. a WeChat Mini Program account you control;
2. one subscription-message template approved for that Mini Program;
3. an HTTPS domain for the public API;
4. a server that can run Node.js 22.13 or newer;
5. an authorized status endpoint or adapter that returns `live`, `offline`, or `unknown`.

A public livestream/profile URL is useful for identifying the target, but this project does not scrape an ordinary page by itself. Follow the target service's current rules and use only access you are authorized to use.

微信平台的申请、类目、模板、域名和发布规则可能变化。操作时请以[微信开放文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)和微信公众平台控制台当时显示的要求为准。

## 3. Configure the server privately

From the repository root, copy the examples:

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

Generate independent secrets locally:

```powershell
npm run admin:secrets
```

Put the generated values in `.env`. Do not paste them into chat, issues, screenshots, or Git. Then add your own server-only WeChat values:

```dotenv
DELIVERY_MODE=wechat-subscribe
WECHAT_MINIPROGRAM_APP_ID=enter-locally
WECHAT_MINIPROGRAM_APP_SECRET=enter-locally
WECHAT_MINIPROGRAM_TEMPLATE_ID=enter-locally
CLIENT_IDENTITY_SECRET=use-the-generated-client-identity-secret
WECHAT_API_TIMEOUT_MS=5000
```

`CLIENT_IDENTITY_SECRET` encrypts the external WeChat identity stored for delivery. Back it up with both SQLite databases. Losing it makes those saved delivery destinations unreadable. Never reuse an admin, observation, or operator secret for this purpose.

AppSecret and `CLIENT_IDENTITY_SECRET` stay on the server. They must never appear in `wechat-miniprogram`, browser code, screenshots, public logs, or support messages.

## 4. Configure channels and the template

In the ignored `config/self-hosted.json`, enable the client and replace fictional values:

```json
{
  "client": {
    "enabled": true,
    "sessionTtlMs": 2592000000,
    "maxSessionsPerIdentity": 5,
    "grantIntentTtlMs": 300000,
    "maxCredits": 200,
    "template": {
      "page": "pages/monitor/monitor",
      "state": "developer",
      "language": "zh_CN",
      "fields": {
        "thing1": { "source": "broadcasterId", "maxLength": 20 },
        "time2": { "source": "occurredAt", "maxLength": 32 }
      }
    }
  },
  "channels": [
    {
      "id": "my-channel",
      "displayName": "My Channel",
      "platform": "My authorized source",
      "enabled": true,
      "sort": 10,
      "staleAfterMs": 360000
    }
  ],
  "statusSources": [
    {
      "id": "my-status-source",
      "broadcasterId": "my-channel",
      "url": "https://status.example.invalid/live.json",
      "pollIntervalMs": 120000,
      "confirmationIntervalMs": 10000
    }
  ],
  "recipients": [],
  "policy": {
    "creditCost": 1,
    "defaultDeliveryLimit": 100,
    "deliveryConcurrency": 8,
    "deliveryDeadlineMs": 120000,
    "deliveryRetryDelayMs": 5000
  },
  "workerBatchSize": 100
}
```

Each enabled public channel ID is also its server broadcaster ID. The template field keys (`thing1`, `time2`, and so on) must exactly match the fields in the template approved for your Mini Program. Supported values are deliberately limited to `broadcasterId`, `eventId`, `occurredAt`, and `source`; the server does not accept arbitrary template text from clients.

The sample template is a configuration shape, not a promise that it matches your approved template. `broadcasterId` is an internal channel ID rather than a display name, and `occurredAt` is an ISO timestamp. Check the type, format, and length allowed by every field in your actual template, then validate it through the real WeChat API with a test account.

## 5. Configure the Mini Program locally

Copy the client example:

```powershell
Copy-Item wechat-miniprogram/config.example.js wechat-miniprogram/config.local.js
```

Set only your public HTTPS API base URL in `config.local.js`:

```javascript
module.exports = Object.freeze({
  apiBaseUrl: 'https://api.your-domain.example',
  requestTimeoutMs: 10000,
  staleAfterMs: 300000,
});
```

This local file is ignored by Git. It must not contain AppSecret, admin credentials, observation credentials, operator credentials, database values, OpenID, or real user data.

Install and open [WeChat Developer Tools](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html), then:

1. import the `wechat-miniprogram` directory;
2. select your own Mini Program AppID instead of the included `touristappid` placeholder, keeping machine-specific project settings private;
3. configure the same HTTPS API domain as a legal request domain in the Mini Program console;
4. compile and inspect all four tabs: Monitor, Targets, Activity, and Settings;
5. test both English and Chinese;
6. use only test users who consented to receive a test notification.

The client calls `wx.login` and sends the one-time code to your server. It stores only an opaque server session token locally. The server exchanges the code, maps the external identity to a random internal recipient, and encrypts the delivery identity at rest.

The first client data load creates this anonymous server identity. Before release, the operator must publish their own current privacy disclosures, support and deletion route, and satisfy the Mini Program platform's current registration, category, filing, and privacy requirements. If the operator's legal basis or platform review requires explicit consent before identity creation, add that consent gate before enabling real users. The included Settings page provides self-service account deletion, while already-anonymized accounting and delivery evidence may remain until the operator's documented retention period expires.

The AppID selected in Developer Tools, server `WECHAT_MINIPROGRAM_APP_ID`, AppSecret, and subscription-message template must all belong to the same Mini Program account. Template IDs are not portable between Mini Programs.

The client reports the result it receives from the subscription prompt. The server cannot independently prove that report, so it must not be described as server-verified permission. WeChat remains the final send gate; retain the built-in credit and intent caps, and rate-limit and monitor the public client endpoints.

The client database is bound to its first configured template ID. Reusing it with another template refuses startup. The reference runtime does not include an in-place rotation tool, and replacing only the client database is unsafe because the core database would still contain enabled recipients without delivery identities. Use a fully isolated fresh data directory only for testing. Production rotation requires a coordinated migration that disables old recipients and asks users to authorize the new template. Never delete only the client database to bypass the binding check.

Use `template.state=developer` for a development build, `trial` for an experience build, and `formal` only for the released build. `template.page` must be an existing Mini Program page path without a leading slash. The included path is `pages/monitor/monitor`.

Loopback HTTP can be useful in Developer Tools, but a real phone needs a publicly reachable HTTPS API. Configure the HTTPS origin as the legal request domain in the Mini Program console, not an individual API path. Disabling domain checks in Developer Tools is not production evidence.

## 6. Start and test safely

Install and start:

```powershell
npm ci
npm start
```

Keep the Node port private. Put it behind an HTTPS reverse proxy and open only the HTTPS endpoint required by the Mini Program. Configure firewalling, proxy trust, rate limiting, monitoring, backups, and restore procedures before using real users.

Test in this order:

1. make the authorized status source report `offline`;
2. open the Mini Program with a consenting test account;
3. enable reminders, select one channel, and tap the button that opens the WeChat subscription-permission prompt;
4. accept once;
5. make the status source report `live` and wait for the configured confirmation;
6. verify the event, frozen denominator, receipt, accounting, and WeChat sender result in server evidence;
7. separately record whether the test phone displayed the message.

The provider result `accepted` means the WeChat API accepted the send request. It does not prove handset display. A timeout or uncertain send outcome remains `ambiguous` and must not be blindly resent.

Each event has a persisted delivery deadline (120 seconds in the example), measured from the server's confirmation time rather than a source-provided timestamp. No new provider send starts at or after that deadline; expired work is refunded. Access-token failures may retry inside the deadline because no message was accepted. A send that started before the deadline but has an uncertain outcome remains `ambiguous` and is never blindly retried.

## 7. Release boundary

These are separate milestones:

1. local source tests pass;
2. WeChat Developer Tools compiles the project;
3. a development build works with a test server;
4. consenting test phones receive expected messages;
5. the Mini Program is uploaded;
6. platform review succeeds;
7. the approved version is released;
8. the released version and production server are read back and accepted.

Do not describe an earlier milestone as proof of a later one.

## 中文速查

- 一位运营者搭建一个小程序，普通用户不需要自己搭建。
- 服务器和云厂商可自行选择，但必须有符合微信要求的 HTTPS 域名。
- 普通公开直播链接不能直接当成可靠状态接口，必须有合法获授权的状态 API 或适配器。
- AppSecret、管理密钥和数据库只能在服务器端保存。
- 用户必须主动点击并处理微信订阅授权弹窗；服务器不能静默替用户授权。
- 微信接口接受发送不等于手机已经弹出。
- 上传、审核和正式发布是不同步骤，任何一步都不会自动发生。
