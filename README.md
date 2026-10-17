# dsh-completion-voice

DSH（DeepSeek Harness）插件：**用语音播报三个时机**。

| 时机 | 播报内容 | 声线 |
| --- | --- | --- |
| 一轮任务真正结束 | **「已完成当前任务」** | 晓伊 `zh-CN-XiaoyiNeural` |
| 需要你在界面上做选择（问你问题 / 让你批准计划 / 权限确认） | **「老大老大，等你做选择呢」**（第二个「老大」尾音拖长） | 同上（可用 `choiceVoice` 单独换） |
| 开始一个新对话 | **「早上好／中午好／下午好／晚上好！有什么工作需要做吗？」**（按系统时间四选一） | 同上（可用 `greetingVoice` 单独换） |

声线用**微软 Edge 神经语音**，真人感强，不是豆包那种温暖女声。

> **系统要求：Windows。** 播放走系统自带的 `powershell.exe` + WPF `MediaPlayer`，SAPI 兜底也只认 Windows 自带语音；在 Linux / macOS 上插件会正常加载，但只写日志、不出声（见文末「已知限制」）。
>
> **联网只在第一次合成时需要**：调用微软 Edge 的语音服务把文本合成成 mp3（`api.msedgeservices.com`），之后走本地缓存离线播放。合成失败会自动降级到 SAPI。

---

## 它做了什么

插件监听 DSH 会话事件流（`ctx.on('session/event', ...)`）与 cordis 的会话生命周期事件
（`ctx.on('session/created', ...)`），有三种播报时机。

### 1. 一轮任务结束 →「已完成当前任务」

由 `turn/end` 触发：

| 条件 | 说明 |
| --- | --- |
| `event.data.reason.kind === 'completed'` | 只有正常跑完才播报；`aborted`（被打断）、`error`、`max-tokens`、`blocked` 都不响 |
| 非子代理会话 | 默认过滤 `header.origin === 'subagent'`，否则每委派一次子代理都会响 |
| 静默窗口 | `turn/end` 之后等 `settleMs` 毫秒；这段时间内该会话又出现 `turn/start`，就撤销这次播报（处理 goal 自动续跑等「这一轮不是终点」的情况） |
| goal 保护 | 会话若有 `phase === 'active'` 的 goal（`ctx.goals`），跳过播报——goal 还会自己续跑，本轮不算任务完成 |

### 2. 需要你做选择 →「老大老大，等你做选择呢」

| 触发事件 | 说明 |
| --- | --- |
| `tool/call` 且 `data.name` 匹配 `choiceToolMatch` | 模型调用了 `ask_user_question`（问你问题 / 让你选一个）或 `exit_plan_mode`（让你批准计划） |
| `approval/asked` | 权限确认，即「要放行这条命令吗」。可用 `announceOnApproval: false` 单独关掉 |

这一条**不做**子代理 / goal / `settleMs` 过滤——它意味着一件事真的卡住了一个人，越早提醒越好；只用 `choiceMinIntervalMs`（默认 3000 ms）防止同一个问题被多个事件连着重复播报。

注意 `ask_user_question` 是**阻塞式**工具调用：等待你回答的期间不会有 `turn/end`，所以「任务完成」那条不会在这时候误响。

### 3. 开始一个新对话 → 按时间问候

| 触发 | 说明 |
| --- | --- |
| cordis 的 `session/created` | 每**开始一个新对话**（新会话）时发射一次；不是 session 日志事件，所以不在 `session/event` 里 |

四个时段由 `greetingHours`（默认 `'5,11,13,18'`，即 `早,中,午,晚` 的起始小时）划分，
按**本机时间**取值：5:00–10:59 早上好 / 11:00–12:59 中午好 / 13:00–17:59 下午好 / 18:00–次日 4:59 晚上好。
四句文本分别由 `greetingMorning` / `greetingNoon` / `greetingAfternoon` / `greetingEvening` 配置，**留空的那一段就不播报**。

| 条件 | 说明 |
| --- | --- |
| 子代理会话 | 默认跳过（`includeSubagents` 一并控制三条提示音） |
| 恢复 / 分叉出来的会话 | `header.isSeeded === true` 时跳过（`greetingSkipSeeded`），只问候真正新开的对话 |
| `greetingMinIntervalMs` | 默认 15000 ms：应用启动时如果同时恢复了多个会话，只问候一次，不会连珠炮 |
| `greetingDelayMs` | 默认 500 ms：会话创建到出声之间留一点时间给界面 |

四段问候语在插件加载时就会**依次预合成**（`greetingPrefetchAll`，串行 + 1.8 s 间隔，避免并发握手被服务端 429），
所以之后无论哪个时段开新对话，都是纯本地播放、立刻出声。

### 发声：两种引擎

| `engine` | 声音 | 何时用 |
| --- | --- | --- |
| `edge`（默认） | 微软 Edge 神经语音，像真人 | 在线**合成一次** `text` → 存成 mp3 缓存 → 以后每次只是本地播放，**瞬时、离线可用**（`prefetch: true` 时加载阶段就合成好） |
| `sapi` | Windows 自带 SAPI（如 Microsoft Huihui），机械感强 | 手动选用，或 `edge` 合成失败时的**自动兜底** |

播放是宿主进程 `spawn` 一个隐藏的 `powershell.exe`，用 WPF `MediaPlayer` 放那个 mp3（约 0.6 s 起声）；SAPI 兜底则用 `-EncodedCommand`（UTF-16LE + base64）调 `SAPI.SpVoice.Speak()`。

- **为什么不用浏览器 `speechSynthesis`**：Electron 桌面端没有可用的 Web Speech 合成，中文语音基本读不出来。
- **为什么用 `-EncodedCommand` 而不是 `-Command`**：彻底绕开命令行引号转义和中文代码页问题，中文文本原样送达。
- **为什么 Edge 语音要缓存**：在线合成约 0.8 s，而播报文本是固定的；缓存后每次播报只剩进程启动开销，也不怕断网。

Edge 语音走的接口（2026 年新端点）：

```
wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1
  ?Ocp-Apim-Subscription-Key=<公开的 Edge 大声朗读 token>
  &Sec-MS-GEC=<Windows FILETIME 取整后 SHA-256 大写>
  &Sec-MS-GEC-Version=1-143.0.3650.96
  &ConnectionId=<uuid>
```

- 旧端点 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` 现在一律 **403**。
- `outputFormat` 只有三种被服务端接受：`audio-24khz-48kbitrate-mono-mp3`（本插件用）、`audio-24khz-96kbitrate-mono-mp3`、`webm-24khz-16bit-mono-opus`；发 `riff-*` / `raw-*` 会以 **WebSocket 1007** 断开。
- 请求头**不要**带 `X-Timestamp`（旧协议才有）。

---

## 文件结构

```
lib/plugin.mjs     插件入口（薄壳）：每次带时间戳动态 import impl.mjs，实现「改代码 + 碰 patch 文件即热重载」
lib/impl.mjs       真正的实现：事件过滤、缓存管理、播报调度
lib/edge-tts.mjs   无依赖 Edge 神经语音客户端（含 Sec-MS-GEC 计算）
lib/ws-client.mjs  极简 WebSocket 客户端（用 node:https 手动握手，因为要自定义 Origin/UA）
lib/player.mjs     Windows 播放：WPF MediaPlayer 放 mp3；SAPI 兜底朗读
```

---

## 安装 / 卸载

本仓库根目录就是插件包本身（`package.json` 在根上），所以可以直接从 GitHub 装：

```powershell
# HTTPS
dsh plugin --profile desktop add git+https://github.com/zhangjie-2007/dsh-voice.git
# 或者 SSH
dsh plugin --profile desktop add git+ssh://git@github.com/zhangjie-2007/dsh-voice.git
```

> 国内网络下 `git+https://` 这条经常被重置（`Recv failure: Connection was reset`），
> 用 SSH 那条更稳，前提是本机已经配好 GitHub 的 SSH key。

> 仓库名是 `dsh-voice`，包名 / 插件 id 仍然是 **`dsh-completion-voice`** —— 配置覆盖、卸载命令都按包名来。

`dsh plugin add` 会自动把 `dsh-completion-voice` 追加进 profile 的 `dsh.profile.bundles`，
并在 `<profile>\node_modules\` 下建好安装目录。

改源码调试时改用 `link:`，它会建一个指向源码目录的 junction，改完立刻生效：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-voice
```

卸载：

```powershell
dsh plugin --profile desktop remove dsh-completion-voice
```

装好后插件会在 `apply` 时往 `<DSH_HOME>\logs\dsh-completion-voice.log` 写一行 `apply: enabled=… engine=…`，
看到这行就说明加载成功了。

---

## 配置

默认值写在 `lib/impl.mjs` 的 `DEFAULTS` 里；实际生效的覆盖写在 profile 的
`<DSH_HOME>\profiles\<profile>\cordis.patch.yml`（按 `id` 匹配）：

```yaml
- id: dsh-completion-voice
  name: dsh-completion-voice
  config:
    text: '已完成当前任务'
    choiceText: '老大<prosody rate="-45%">老大</prosody>，等你做选择呢'
    engine: edge
    voice: zh-CN-XiaoyiNeural
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `text` | `'已完成当前任务'` | 任务完成时的播报文本 |
| `announceOnChoice` | `true` | 是否播报「需要你做选择」 |
| `choiceText` | `'老大<prosody rate="-45%">老大</prosody>，等你做选择呢'` | 选择提示音的文本；留空则完全不播。**支持内联 SSML**（见下） |
| `choiceToolMatch` | `'ask_user_question\|exit_plan_mode'` | 哪些工具调用算「要做选择」（对工具名做正则匹配，忽略大小写） |
| `announceOnApproval` | `true` | 权限确认（`approval/asked`）是否也算「要做选择」 |
| `choiceVoice` | `''` | 选择提示音的声线；留空 = 沿用 `voice` |
| `choiceMinIntervalMs` | `3000` | 两次「要做选择」播报的最小间隔（ms） |
| `announceOnSessionStart` | `true` | 开始新对话时是否按时间播报问候语 |
| `greetingMorning` | `'早上好！有什么工作需要做吗？'` | 早段（默认 5:00–10:59）文本；留空则不播这一段 |
| `greetingNoon` | `'中午好！有什么工作需要做吗？'` | 中段（11:00–12:59）文本 |
| `greetingAfternoon` | `'下午好！有什么工作需要做吗？'` | 午段（13:00–17:59）文本 |
| `greetingEvening` | `'晚上好！有什么工作需要做吗？'` | 晚段（18:00–次日 4:59）文本 |
| `greetingHours` | `'5,11,13,18'` | 四段起始小时，格式 `"早,中,午,晚"`，必须是 4 个 0–23 的整数（可跨零点） |
| `greetingVoice` | `''` | 问候语的声线；留空 = 沿用 `voice` |
| `greetingDelayMs` | `500` | 会话创建到播报之间的延时（ms） |
| `greetingMinIntervalMs` | `15000` | 两次问候之间的最小间隔（ms） |
| `greetingSkipSeeded` | `true` | 恢复 / 分叉出来的会话（`header.isSeeded`）不问候 |
| `greetingPrefetchAll` | `true` | 后台把四段问候语都预合成好（串行，1.8 s 间隔） |
| `engine` | `'edge'` | `'edge'` = Edge 神经语音（在线合成 + 本地缓存）；`'sapi'` = 系统本地语音 |
| `voice` | `'zh-CN-XiaoyiNeural'` | Edge 声线名 |
| `rate` | `0` | 语速：Edge 用百分比（`-20` = 慢 20%）；`engine: sapi` 时按 `/10` 映射到 SAPI 的 `-10..10` |
| `pitch` | `0` | 音调偏移（Hz），仅 Edge |
| `volume` | `100` | 音量 `0..100`（同时控制合成音量和播放音量） |
| `sapiVoiceMatch` | `'Chinese\|Huihui\|中文\|zh-CN\|zh_CN'` | 仅 SAPI 兜底时选语音的正则 |
| `settleMs` | `800` | 结束后的静默窗口（ms） |
| `minIntervalMs` | `800` | 两次播报的最小间隔（ms） |
| `includeSubagents` | `false` | 是否也给子代理轮次播报 |
| `skipActiveGoal` | `true` | 有进行中的 goal 时跳过 |
| `prefetch` | `true` | 加载时就把音频合成好放进缓存 |
| `cacheDir` | `''` | 音频缓存目录，空 = `<DSH_HOME>\audio\dsh-completion-voice` |
| `log` | `true` | 是否写诊断日志 |
| `powershellPath` | `''` | 自定义 powershell.exe 路径，空则自动探测 |
| `announceOnLoad` | `false` | 加载时立刻播报一次（自检用） |
| `debugEvents` | `false` | 把收到的前 40 条 session/event 明细写进日志（排查用） |

### 在文本里写内联 SSML（局部调速 / 停连）

`text` 和 `choiceText` 都可以带内联 SSML，用来只把某几个字拖长或加重。默认的选择提示音就是这么写的：

```yaml
choiceText: '老大<prosody rate="-45%">老大</prosody>，等你做选择呢'
```

插件识别的标签：`<prosody rate pitch volume>`、`<emphasis>`、`<say-as>`、`<phoneme>`、`<break>`（见下面的限制）。检测到标签后送给服务端的就是：

```xml
<speak version="1.0" …><voice name="zh-CN-XiaoyiNeural">老大<prosody rate="-45%">老大</prosody>，等你做选择呢</voice></speak>
```

四条实测出来的硬约束（都是踩过的坑）：

- **标签不能嵌套**。文本里一旦出现标签，插件就不再生成最外层 `<prosody>`（否则服务端直接以 `1007 invalid payload` 关闭连接），代价是整句的 `rate`/`pitch`/`volume` 那时不再生效，要写的就写进标签自己身上。
- **`<break time="140ms"/>` 不被这个端点接受**（同样 1007）。想要停顿只能用标点，比如 `老大，老大，等你做选择呢`。
- `rate` 是带百分号的字符串（`"-45%"`，`+`/`-` 都行），`pitch` 是 `"-30Hz"` 这样的频率，`volume` 是 `"-20%"`。
- 改动文本 = 缓存键变了 = 下次加载会重新联网合成一次；**旧 mp3 不会被自动清理**，觉得缓存目录脏了就手动删 `%USERPROFILE%\.dsh\audio\dsh-completion-voice\` 下的文件。
- SAPI 兜底（Edge 合成失败时）会把标签剥掉再念，不会把 `<prosody rate=…>` 念出来。

### 可选声线（微软 Edge 神经语音，中文）

| 声线 | 性别 | 风格 |
| --- | --- | --- |
| `zh-CN-XiaoyiNeural` | 女 | 活泼（**当前使用**） |
| `zh-CN-XiaoxiaoNeural` | 女 | 温暖（≈豆包那种调子） |
| `zh-CN-YunyangNeural` | 男 | 专业可靠，新闻播音腔 |
| `zh-CN-YunjianNeural` | 男 | 浑厚有力，纪实感 |
| `zh-CN-YunxiNeural` | 男 | 年轻阳光 |
| `zh-CN-YunxiaNeural` | 男 | 童声可爱 |
| `zh-CN-liaoning-XiaobeiNeural` | 女 | 东北话 |
| `zh-CN-shaanxi-XiaoniNeural` | 女 | 陕西话 |
| `zh-TW-HsiaoChenNeural` / `zh-HK-HiuMaanNeural` | 女 | 台湾腔 / 粤语 |

### 改代码后怎么生效

- 改 **`cordis.patch.yml`**：即时生效（DSH 会热重载插件）。
- 改 **`lib/impl.mjs` / `edge-tts.mjs` / `player.mjs`**：因为入口用时间戳动态 import，**碰一下 `cordis.patch.yml`（随便改一个值再改回来）就会重新加载代码**，不必重启 DSH。
- 改 **`lib/plugin.mjs`** 本身或 `package.json`：入口模块已被宿主进程缓存，**需要重启 DSH**。

---

## 排查

诊断日志：`<DSH_HOME>\logs\dsh-completion-voice.log`（超过 256 KB 自动清空）

```
[..] apply: enabled=true engine=edge voice=zh-CN-XiaoyiNeural text="已完成当前任务" choice="老大<prosody rate=\"-45%\">老大</prosody>，等你做选择呢" greeting=on(5,11,13,18) settleMs=800 cacheDir=...
[..] ready: listening on session/event + session/created
[..] synthesized 13824B voice=zh-CN-XiaoyiNeural text="已完成当前任务" -> <cacheDir>\5e64fb60c6d0297a.mp3
[..] prefetch ready ["已完成当前任务"]: <cacheDir>\5e64fb60c6d0297a.mp3   ← 预合成完成（每条提示音一行）
[..] skip speak: turn/end reason=aborted                      ← 被打断，不播报
[..] skip speak: turn/end reason=max-tokens                   ← 上下文写满，不播报
[..] skip speak: subagent session                             ← 子代理轮次
[..] skip speak: session xxx has an active goal               ← goal 还在跑
[..] skip speak: within choiceMinIntervalMs (3000ms)          ← 同一个问题已经提醒过了
[..] skip greeting: seeded session (resumed or forked)         ← 恢复/分叉的会话，不问候
[..] skip greeting: within greetingMinIntervalMs (15000ms)    ← 刚问候过，短时间内不再问候
[..] choice cue (tool ask_user_question session=...)          ← 要你做选择
[..] greeting cue (afternoon, session=session-xxxx)           ← 开始新对话，按时间问候
[..] dispatched play cbc630b220ca90e4.mp3 pid=9884            ← 正在播放
[..] speak dispatched (edge, choice: tool ask_user_question session=...) voice=zh-CN-XiaoyiNeural
[..] speak dispatched (edge, greeting: afternoon) voice=zh-CN-XiaoyiNeural
[..] dispatched play 5e64fb60c6d0297a.mp3 pid=33140
[..] speak dispatched (edge, turn end) voice=zh-CN-XiaoyiNeural
[..] synthesize failed (...): ... / speak dispatched (sapi fallback, turn end)   ← 网络不通，回退 SAPI
```

没有声音时按顺序查：

1. 日志里有没有 `speak dispatched`？—— 没有就是触发条件被过滤了（看同行的 `skip speak` 原因）。
2. 有 `speak dispatched` 但没声音：
   - `edge` 引擎：`<DSH_HOME>\audio\dsh-completion-voice\` 下有没有 mp3？能不能手动播放？
     ```powershell
     $f = "$env:USERPROFILE\.dsh\audio\dsh-completion-voice\" + (Get-ChildItem "$env:USERPROFILE\.dsh\audio\dsh-completion-voice\*.mp3")[0].Name
     powershell -NoProfile -c "Add-Type -AssemblyName PresentationCore; `$p=New-Object System.Windows.Media.MediaPlayer; `$p.Open([Uri]'$f'); `$n=0; while(-not `$p.NaturalDuration.HasTimeSpan -and `$n -lt 200){Start-Sleep -Milliseconds 20; `$n++}; `$p.Play(); Start-Sleep -Seconds 3"
     ```
   - `sapi` 引擎：机器上有没有中文 SAPI 语音？
     ```powershell
     New-Object -ComObject SAPI.SpVoice | ForEach-Object { $_.GetVoices() | ForEach-Object { $_.GetDescription() } }
     ```
     应能看到 `Microsoft Huihui Desktop - Chinese (Simplified)`。
3. 系统音量 / 未静音。

想换声线试听：改 `voice` 后删掉缓存目录（缓存按 文本+声线+语速+音调+音量 的哈希分文件，换声线会自动用新文件，不必手动删）。

---

## 已知限制

- **只在 Windows 上出声**：非 win32 平台只写日志、不播报。
- **Edge 语音需要联网合成**：第一次（或换声线后第一次）要能连上 `api.msedgeservices.com`；连不上时自动回退 SAPI，不会静默失败。
- **goal 场景**：`skipActiveGoal` 依赖 `ctx.goals` 服务（需要 profile 组合了 session projection）。服务不存在时退化为「每轮都播报」，不会报错。
- **延迟**：从「一轮结束」到「听到声音」≈ `settleMs` + 约 0.6 s（PowerShell 冷启动）+ 音频时长。
  想更快可以常驻一个 PowerShell 播放进程，当前版本没做，优先保证简单可靠。
- **多个会话同时结束**：靠 `minIntervalMs` 去重，不会叠着响。
- **「要你做选择」这条靠事件识别**：只认 `tool/call` 的工具名匹配（默认 `ask_user_question` / `exit_plan_mode`）和 `approval/asked`。如果某个交互式确认不经过这两个事件，就不会响——把对应的工具名加进 `choiceToolMatch` 即可。
- **问候语靠 cordis 的 `session/created`**：这是会话生命周期事件，不是会话日志事件。插件用 `{ global: true }` 注册以保证不受作用域过滤；如果你的 DSH 版本换了事件名，日志里会一条 `greeting cue` 都不出现（前两条不受影响）。
- **启动 DSH 时可能问候一次**：桌面端启动时若自动恢复出一个会话，也会触发 `session/created`。`greetingSkipSeeded` 已经排掉带 seed 的恢复/分叉会话，但如果你的版本恢复时不带 seed，就会在启动时听到一句问候——不想要就设 `announceOnSessionStart: false`。
- **Edge 语音接口是微软的公开接口**，不是官方 API，将来可能再变（2026 年就刚迁过一次端点，见上文）；变了就更新 `lib/edge-tts.mjs`。
