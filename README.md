<a id="zh"></a>

# bili-danmu-helper 弹幕助手

**中文** | [English](#english)

B 站直播间自动发弹幕。它会监听直播间，用你的账号发消息：

- **定时弹幕**（比如每 20 分钟一次喝水提醒），从开播时开始算
- **感谢**礼物（同一个人连着送会合并成一条）、上舰、SC 和关注
- **关键词回复**，只回答提问（「群号是多少？」会回，「明天再进群聊」不回；关键词前面加 `=` 就总是回）
- **「唱过 X 吗」**，用你自己的歌单回答
- **开播 / 下播**时说一句话，还有**休息提醒**（「已经播了 2 小时啦」）
- **可选 AI**（默认关）：定时弹幕和休息提醒到点让 AI 换个说法；也可以让 AI 看弹幕，自己判断要不要插一句。写好的先在本机小页面等你点「发送」，没点的话换说法发原句、插话不发
- 默认就很稳：所有消息排一个队，两条之间有最短间隔，每场有上限，出错自动暂停，太长的文字自动拆开，写成 `说法1 || 说法2` 的话，B 站悄悄吞掉一条时会换下一种说法

## 需要

- Node.js 22 或更新（用到自带的 `fetch` 和 `WebSocket`）
- `npm install` 只会装 `qrcode`，用来在终端里显示登录二维码；其他都不需要依赖

## 快速开始

```sh
npm install
cp config.example.json config.json   # 把 room 改成你的直播间号
node index.mjs login                 # 用 B站 App 扫码登录
node index.mjs                       # 运行
```

第一次运行会生成 `data/settings.json`，里面**所有功能都是关着的**。把 `enabled` 和想要的功能打开、保存，15 秒内就生效，不用重启。

其他命令：

```sh
node index.mjs login --sender   # 另外登录一个专门发弹幕的账号（然后把 "account" 设成 "own"）
node index.mjs say 大家好         # 通过队列发一条
node index.mjs test 大家好        # 马上发一条，不管总开关
```

## 设置（`data/settings.json`）

| 键 | 含义 |
| --- | --- |
| `enabled` | 总开关。关着的时候什么都不会自动发。 |
| `account` | `"bot"` = `node index.mjs login` 登录的账号；`"own"` = 另外登录的发送账号。 |
| `maxLen` | 每条最多几个字；`0` 表示去问 B 站你的账号在这个直播间能发多长。超长会拆开。 |
| `safety` | `minGapSec` 两条之间的秒数，`maxPerStream` 每场上限，`pauseMinOnError` 出错暂停几分钟。 |
| `timed` | `intervalMin` 间隔分钟，`onlyLive` 只在直播时发，`order`（`random` 随机或 `seq` 按顺序），`lines` 内容。 |
| `thanks` | `gift`（`minYuan` 最低金额、`mergeSec` 合并秒数、`template` 模板）、`guard`、`sc`、`follow`（`mergeSec`）。模板里可以用 `{name}`、`{gift}`、`{num}`。 |
| `replies` | `rules: [{ "keys": ["群号"], "reply": "..." }]`，`cooldownSec` 冷却，`userCooldownSec` 同一个人的冷却。 |
| `liveStart` / `liveEnd` | 开播（等 `delaySec` 秒后）/ 下播时说一句。 |
| `breakReminder` | `everyMin` 每几分钟，`text` 里可以用 `{hours}` / `{minutes}`。 |
| `songAsk` | 用 `data/songs.txt`（一行一首）回答「唱过 X 吗」。`yes` / `no` 模板里可以用 `{song}`。 |
| `ai` | `enabled` 总开关；`timed` / `breakReminder` 换说法；`confirm` 要不要等确认、`confirmSec` 等几秒；`persona` 用不用人设；`recentDm` 给 AI 看几条最近弹幕；`extra` 额外要求；`chat`（`enabled`、`everyMin` 几分钟最多看一次、`minNew` 至少几条新弹幕、`onlyMention` + `names` 只在叫到这些名字时插话、`maxPerStream` 每场上限）。 |

任何文字都可以用 `||` 隔开写几种说法。B 站收下但把消息藏起来（有屏蔽词）时，会发下一种说法。

`config.json`：`room`（必填）、`dataDir`、`loginFile`、`senderLoginFile`、`songsFile`，以及 `discordWebhook`：一直发不出去时发 Discord 提醒。

### AI（可选）

用 DeepSeek（或任何兼容 OpenAI 格式的接口）。在 `config.json` 里填 `deepseekKey`（或者设环境变量 `DEEPSEEK_API_KEY`），可选 `aiModel`（默认 `deepseek-flash`）、`aiBaseUrl`、`personaFile`（人设文本文件，`#` 开头的行不算）、`streamer`（主播怎么称呼）、`confirmPort`（确认页面端口，默认 18790，`0` 关掉）。然后在 `settings.json` 里打开 `ai.enabled`。

运行时打开 `http://127.0.0.1:18790/`，AI 写好的弹幕会出现在这里，可以改字、发送、换一条或不用。`node index.mjs ai-try` / `node index.mjs ai-try chat` 只试写不发。AI 写的弹幕超字数或带链接、群号这类词会被丢掉，改发原句。密钥别提交到 git（`config.json` 已在 `.gitignore` 里）。

运行状态写在 `data/status.json`（最近发出的消息、错误、队列长度）。

## 隐私

登录文件里有你的 B 站登录信息。它们放在 `data/` 里，只有你自己的账户能读，也不会进 git。千万别发给别人。

## 测试

```sh
npm test
```

## 许可

[MIT](LICENSE)。与哔哩哔哩无关。自动消息请保持礼貌、别太频繁，遵守 B 站直播间的规则。

---

<a id="english"></a>

# English

[中文](#zh) | **English**

Automatic danmaku for a **Bilibili Live** room. It listens to the room and sends messages with your account:

- **Timed messages** (e.g. a "drink water" reminder every 20 minutes), counted from when the stream started
- **Thank-yous** for gifts (merged when someone sends several in a row), guards, Super Chats and follows
- **Keyword replies** that only answer questions ("群号是多少？" yes, "明天再进群聊" no; prefix a keyword with `=` to always answer)
- **"Have you sung X?"** answers from your own song list
- **Stream start / end** messages and **break reminders** ("you've been live for 2 hours")
- **Optional AI** (off by default): rephrase timed messages and break reminders each time, or let the AI read chat and decide whether to chime in. Drafts wait on a small local page for you to press send; if you don't, a rephrase falls back to the original line and a chime-in is dropped
- Safe by default: one shared queue, a minimum gap between messages, a per-stream cap, auto-pause on errors, automatic splitting of long text, and `text A || text B` alternatives that are tried when Bilibili silently swallows a message

## Requirements

- Node.js 22 or newer (uses the built-in `fetch` and `WebSocket`)
- `npm install` only adds `qrcode` for showing the login QR code in the terminal; everything else has no dependencies

## Quick start

```sh
npm install
cp config.example.json config.json   # set room to your live room id
node index.mjs login                 # scan the QR code with the Bilibili app
node index.mjs                       # run
```

The first run creates `data/settings.json` with **everything switched off**. Turn on `enabled` and the features you want, save, and the change applies within 15 seconds; no restart needed.

Other commands:

```sh
node index.mjs login --sender   # log in a separate account just for sending (then set "account": "own")
node index.mjs say 大家好         # send one message through the queue
node index.mjs test 大家好        # send one message right away, ignoring the main switch
```

## Settings (`data/settings.json`)

| Key | Meaning |
| --- | --- |
| `enabled` | Main switch. Nothing automatic is sent while it is off. |
| `account` | `"bot"` = the account from `node index.mjs login`; `"own"` = the separate sender account. |
| `maxLen` | Max characters per message; `0` asks Bilibili what your account may send in this room. Longer text is split. |
| `safety` | `minGapSec` between messages, `maxPerStream`, `pauseMinOnError`. |
| `timed` | `intervalMin`, `onlyLive`, `order` (`random` or `seq`), `lines`. |
| `thanks` | `gift` (`minYuan`, `mergeSec`, `template`), `guard`, `sc`, `follow` (`mergeSec`). Templates use `{name}`, `{gift}`, `{num}`. |
| `replies` | `rules: [{ "keys": ["群号"], "reply": "..." }]`, `cooldownSec`, `userCooldownSec`. |
| `liveStart` / `liveEnd` | One message when the stream starts (after `delaySec`) / ends. |
| `breakReminder` | `everyMin`, `text` with `{hours}` / `{minutes}`. |
| `songAsk` | Answers "唱过 X 吗" using `data/songs.txt` (one song per line). `yes` / `no` templates use `{song}`. |
| `ai` | `enabled` master switch; `timed` / `breakReminder` rephrase; `confirm` wait for approval, `confirmSec` how long; `persona` use the persona file; `recentDm` how many recent messages the AI sees; `extra` extra instructions; `chat` (`enabled`, `everyMin` at most once per N minutes, `minNew` new messages needed, `onlyMention` + `names` only when chat calls one of these names, `maxPerStream` per-stream cap). |

Any text can list alternatives separated by `||`. If Bilibili accepts a message but hides it (filtered words), the next alternative is sent.

`config.json`: `room` (required), `dataDir`, `loginFile`, `senderLoginFile`, `songsFile`, and `discordWebhook` for an alert when sending keeps failing.

### AI (optional)

Uses DeepSeek (or any OpenAI-compatible endpoint). Put `deepseekKey` in `config.json` (or set `DEEPSEEK_API_KEY`); optional `aiModel` (default `deepseek-flash`), `aiBaseUrl`, `personaFile` (plain-text persona, lines starting with `#` are skipped), `streamer` (how to refer to the streamer) and `confirmPort` (approval page port, default 18790, `0` turns it off). Then turn on `ai.enabled` in `settings.json`.

While running, open `http://127.0.0.1:18790/`: AI drafts show up there and you can edit, send, redo or skip them. `node index.mjs ai-try` / `node index.mjs ai-try chat` draft one without sending. Drafts that are too long or contain links or group-number words are dropped in favour of the original line. Never commit your key (`config.json` is already in `.gitignore`).

The runtime state is written to `data/status.json` (last sent messages, errors, queue length).

## Privacy

Login files contain your Bilibili session. They are stored in `data/` with owner-only permissions and are ignored by git. Never share them.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE). Not affiliated with Bilibili. Keep automated messages polite and infrequent, and follow Bilibili's rules for live rooms.
