/**
 * dsh-completion-voice —— 真正的实现（由 lib/plugin.mjs 每次加载时带时间戳动态 import，
 * 所以改这里 + 触碰 profile 的 cordis.patch.yml 即可热重载，不必重启 DSH）。
 * ----------------------------------------------------------------------------
 * DSH 插件：用「语音」播报两种时机 ——
 *   1) 一轮任务真正结束时：默认「已完成当前任务」（由 `turn/end` 触发）；
 *   2) 需要用户在界面上做选择时：默认「老大老大，等你做选择呢」
 *      （由 `tool/call` 里工具名匹配 ask_user_question/exit_plan_mode 触发，
 *        以及 `approval/asked` 权限确认触发）；
 *   3) 开始一个新对话时：按系统时间说「早上好/中午好/下午好/晚上好！有什么工作需要做吗？」
 *      （由 cordis 的 `session/created` 触发 —— 不是 session 日志事件；子代理会话、
 *        以及带 seed 的恢复/分叉会话默认不报）。
 *
 * 两种发声引擎：
 *   engine: 'edge' —— 微软 Edge 神经语音（在线合成，像真人）。文本是固定的，
 *                     所以每条提示音合成一次后缓存成 mp3，之后每次播报都是纯本地播放，瞬时且离线可用。
 *   engine: 'sapi' —— Windows 自带 SAPI 语音（离线、机械感强，作为兜底）。
 * Edge 合成失败且没有缓存时，自动回退 SAPI。
 *
 * 任务完成那一条的细则：
 *   - 子代理（subagent）轮次默认不播报，否则每委派一次都会响；
 *   - 结束到播报之间有一段「静默窗口」(settleMs)：窗口内该会话又出现 `turn/start`
 *     就取消播报（例如 goal 自动续跑紧接着开始下一轮）；
 *   - 会话若有 phase === 'active' 的 goal（ctx.goals），默认跳过播报，避免每轮都响。
 * 「要做选择」那一条不做这些过滤 —— 两种情况都真的卡住了一个人。
 *
 * 全部行为都可用插件 config 覆盖（见 DEFAULTS，profile 的 cordis.patch.yml 里按 id 覆盖）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const TAG = new URL(import.meta.url).searchParams.get('t') || String(Date.now())

const edge = await import(`./edge-tts.mjs?t=${TAG}`)
const player = await import(`./player.mjs?t=${TAG}`)
const bubble = await import(`./bubble.mjs?t=${TAG}`)

/** 插件默认配置；profile 的 cordis.patch.yml 里按 id 覆盖。 */
const DEFAULTS = {
  /** 总开关。false 时插件加载后立即退出，不做任何事。 */
  enabled: true,
  /** 任务完成时要朗读的文本。 */
  text: '已完成当前任务',
  /** 需要用户在界面上做选择时，是否也播报提示音。 */
  announceOnChoice: true,
  /**
   * 需要用户做选择时朗读的文本。留空则不播报。
   * 可以直接写内联 SSML 做局部控制 —— 默认就是把第二个「老大」的尾音拖长：
   *   老大<prosody rate="-45%">老大</prosody>，等你做选择呢
   * 注意：文本里一旦出现 <prosody> 之类的标签，整句就不再套外层 prosody，
   * 此时 rate/pitch/volume 要写在标签里；标签也不能互相嵌套，否则服务端返回 1007。
   */
  choiceText: '老大<prosody rate="-45%">老大</prosody>，等你做选择呢',
  /** 哪些工具调用算「需要用户做选择」（对工具名做正则匹配）。 */
  choiceToolMatch: 'ask_user_question|exit_plan_mode',
  /** 权限确认（approval/asked，例如要跑一条需要放行的命令）是否也算「要做选择」。 */
  announceOnApproval: true,
  /** 选择提示音用的声线；留空则沿用 voice。 */
  choiceVoice: '',
  /** 两次「要做选择」播报之间的最小间隔（ms），避免同一问题被多个事件重复播报。 */
  choiceMinIntervalMs: 3000,
  /** 开始一个新对话时，是否按系统时间播报问候语。 */
  announceOnSessionStart: true,
  /** 四段问候语（对应下面 greetingHours 划分的四个时段）；留空的那一段不播报。 */
  greetingMorning: '早上好！有什么工作需要做吗？',
  greetingNoon: '中午好！有什么工作需要做吗？',
  greetingAfternoon: '下午好！有什么工作需要做吗？',
  greetingEvening: '晚上好！有什么工作需要做吗？',
  /** 四段的起始小时，格式 "早,中,午,晚"，必须是 4 个 0-23 的整数（可跨零点，如 "5,11,13,18"）。 */
  greetingHours: '5,11,13,18',
  /** 问候语用的声线；留空则沿用 voice。 */
  greetingVoice: '',
  /** 会话创建到播报之间的延时（ms），给界面留出就绪时间。 */
  greetingDelayMs: 500,
  /** 两次问候之间的最小间隔（ms）：应用启动时若同时恢复多个会话，只会问候一次。 */
  greetingMinIntervalMs: 15000,
  /** 只问候真正新开的对话：带 seed 的恢复/分叉会话（header.isSeeded）跳过。 */
  greetingSkipSeeded: true,
  /** 加载时在后台把四段问候语都预合成好（串行，间隔 1.8s，避免并发握手被限流）。 */
  greetingPrefetchAll: true,
  /** 发声引擎：'edge' = 微软 Edge 神经语音（在线合成 + 本地缓存）；'sapi' = 系统本地语音。 */
  engine: 'edge',
  /** Edge 声线名（zh-CN-XiaoyiNeural / zh-CN-YunyangNeural / zh-CN-YunjianNeural ...）。 */
  voice: 'zh-CN-XiaoyiNeural',
  /** 语速：Edge 用百分比（0 = 正常，-20 = 慢 20%）；SAPI 引擎下按 /10 映射到它自己的 -10..10。 */
  rate: 0,
  /** 音调偏移（Hz），仅 Edge 引擎有效。 */
  pitch: 0,
  /** 音量 0..100。 */
  volume: 100,
  /** SAPI 兜底时选语音用的正则（对语音描述做 -match）。 */
  sapiVoiceMatch: 'Chinese|Huihui|中文|zh-CN|zh_CN',
  /** 结束后的静默窗口（ms）：窗口内该会话又开始新一轮就不播报。 */
  settleMs: 800,
  /** 两次播报之间的最小间隔（ms），防止多个会话同时结束导致声音叠在一起。 */
  minIntervalMs: 800,
  /** 是否也为子代理轮次播报。 */
  includeSubagents: false,
  /** 会话当前有 phase === 'active' 的 goal 时跳过播报（goal 还会自动续跑）。 */
  skipActiveGoal: true,
  /** 加载时就把音频合成好放进缓存，让第一次播报也不用等网络。 */
  prefetch: true,
  /** 音频缓存目录；留空则用 <DSH_HOME>\audio\dsh-completion-voice。 */
  cacheDir: '',
  /** 是否写诊断日志。 */
  log: true,
  /** 自定义 powershell.exe 路径；留空自动探测。 */
  powershellPath: '',
  /** 在 apply 时立刻播报一次（用于验证插件是否已加载）。 */
  announceOnLoad: false,
  /**
   * 在 DSH 页面左下角显示一个小悬浮泡，点一下就能把语音提示静音/恢复。
   * 开关状态存在 <cacheDir>\bubble-state.json，重启后保持。
   * 注意：**这个气泡本身是宿主启动时注入页面的**，改这里要重启 DSH 才会出现/消失。
   */
  showBubble: true,
  /** 点悬浮泡时是否放一个小音效（开启 = 上行三连音，关闭 = 下行两音；在浏览器里现场合成，不走插件语音通道）。 */
  bubbleSound: true,
  /** 调试：把收到的前若干个 session/event 明细写进日志（默认关）。 */
  debugEvents: false,
}

/** 日志文件大小上限（超过就整体重置，避免无限增长）。 */
const LOG_MAX_BYTES = 256 * 1024

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function logPath() {
  return path.join(dshHome(), 'logs', 'dsh-completion-voice.log')
}

let loggingEnabled = DEFAULTS.log

function log(message) {
  if (!loggingEnabled) return
  try {
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.writeFileSync(file, '')
    } catch {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

function logError(where, err) {
  log(`ERROR ${where}: ${(err && err.stack) || err}`)
}

/**
 * SAPI 不认识 SSML：兜底直读前先把标签与实体还原成纯文本，
 * 否则它会把 "<prosody rate=-45%>" 一个字一个字念出来。
 */
function plainSpeech(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 合并配置：只接受已知键，非法值回落默认。 */
function normalizeConfig(config) {
  const cfg = { ...DEFAULTS }
  const src = config && typeof config === 'object' ? config : {}
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key]
    if (value === undefined || value === null) continue
    const fallback = DEFAULTS[key]
    if (typeof fallback === 'number') {
      const n = Number(value)
      if (Number.isFinite(n)) cfg[key] = n
      continue
    }
    if (typeof fallback === 'boolean') {
      // YAML 里写成 1 / 'on' / 'yes' 也算开；其余按 JS 真值语义收敛成布尔
      const text = String(value).trim().toLowerCase()
      cfg[key] = value === true || value === 1 || text === 'true' || text === '1' || text === 'yes' || text === 'on'
      continue
    }
    cfg[key] = String(value)
  }
  if (cfg.engine !== 'sapi') cfg.engine = 'edge'
  return cfg
}

/** 是否是子代理会话。 */
function isSubagentSession(session) {
  try {
    const header = session && session.header
    if (!header || typeof header !== 'object') return false
    if (header.origin === 'subagent') return true
    const depth = Number(header.delegationDepth)
    if (Number.isFinite(depth) && depth > 0) return true
    return false
  } catch {
    return false
  }
}

/** 解析 greetingHours（"早,中,午,晚" 四个 0-23 的整数）；非法返回 null。 */
function parseGreetingHours(raw) {
  const parts = String(raw).split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4) return null
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 23)) return null
  return parts
}

/** greetingHours 的默认划分：早 5-10、中 11-12、午 13-17、晚 18-4（跨零点）。 */
const GREETING_DEFAULT_HOURS = [5, 11, 13, 18]

/**
 * 按本地时间判断该说哪一句问候，返回 'morning' | 'noon' | 'afternoon' | 'evening'。
 * @param date - Date 或时间戳；省略则用当前时间。
 * @param hours - [早, 中, 午, 晚] 四段的起始小时。
 */
export function greetingKindAt(date, hours = GREETING_DEFAULT_HOURS) {
  const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date)
  const h = d.getHours()
  const [morning, noon, afternoon, evening] = hours
  const within = (start, end) => (start <= end ? h >= start && h < end : h >= start || h < end)
  if (within(morning, noon)) return 'morning'
  if (within(noon, afternoon)) return 'noon'
  if (within(afternoon, evening)) return 'afternoon'
  return 'evening'
}

export default {
  name: 'dsh-completion-voice',

  async apply(ctx, config) {
    const cfg = normalizeConfig(config)
    loggingEnabled = cfg.log

    const cacheRoot = cfg.cacheDir || path.join(dshHome(), 'audio', 'dsh-completion-voice')

    // ---- 悬浮泡控制的语音总开关（持久化在缓存目录里，重启后保持）----
    const stateFile = path.join(cacheRoot, 'bubble-state.json')
    let voiceEnabled = bubble.readVoiceEnabled(stateFile)
    const runtime = {
      get enabled() {
        return voiceEnabled
      },
      setEnabled(next) {
        const value = !!next
        if (value === voiceEnabled) return
        voiceEnabled = value
        bubble.writeVoiceEnabled(stateFile, value, logError)
        log(`voice ${value ? 'on' : 'off'} (bubble toggle)`)
      },
    }

    log(`apply: enabled=${cfg.enabled} engine=${cfg.engine} voice=${cfg.voice} text=${JSON.stringify(cfg.text)} choice=${JSON.stringify(cfg.announceOnChoice ? cfg.choiceText : '')} greeting=${cfg.announceOnSessionStart ? `on(${cfg.greetingHours})` : 'off'} bubble=${cfg.showBubble ? (voiceEnabled ? 'on' : 'muted') : 'off'} settleMs=${cfg.settleMs} cacheDir=${cacheRoot}`)

    if (!cfg.enabled) return

    // 注入行必须在 apply 里同步注册（宿主启动时一次性收集注入表，晚一步就永远进不去）。
    if (cfg.showBubble) {
      try {
        bubble.installBubble(ctx, { runtime, sound: cfg.bubbleSound, log, logError })
      } catch (err) {
        logError('installBubble', err)
      }
    }

    let disposed = false
    /** 清 dispose 时要一并清掉的延时定时器（问候语、预合成串行等）。 */
    const bgTimers = new Set()

    /**
     * 一条「提示音」= 一段文本 + 一个声线 + 它在缓存里的那份 mp3。
     * 文本/声线/语速/音调/音量任一改动都会算出新的缓存键，从而重新合成。
     */
    const makeCue = (text, voice) => {
      const key = createHash('sha1')
        .update([text, voice, cfg.rate, cfg.pitch, cfg.volume].join('|'))
        .digest('hex')
        .slice(0, 16)
      const file = path.join(cacheRoot, `${key}.mp3`)
      const cue = { text, voice, file, promise: null }
      /** 确保缓存里已有一份 mp3；返回 null 表示合成失败。 */
      cue.ensure = () => {
        try {
          const st = fs.statSync(file)
          if (st.size > 0) return Promise.resolve(file)
        } catch {}
        if (cue.promise) return cue.promise
        cue.promise = edge
          .synthesize({
            text,
            voice,
            rate: cfg.rate,
            pitch: cfg.pitch,
            volume: Math.max(-100, Math.min(100, Math.round(cfg.volume) - 100)),
            log,
            verbose: false,
          })
          .then(({ audio }) => {
            fs.mkdirSync(cacheRoot, { recursive: true })
            const tmp = `${file}.${process.pid}.tmp`
            fs.writeFileSync(tmp, audio)
            fs.renameSync(tmp, file)
            log(`synthesized ${audio.length}B voice=${voice} text=${JSON.stringify(text)} -> ${file}`)
            return file
          })
          .catch((err) => {
            log(`synthesize failed (${voice}): ${(err && err.message) || err}`)
            return null
          })
          .finally(() => { cue.promise = null })
        return cue.promise
      }
      return cue
    }

    /** 任务完成提示音。 */
    const doneCue = makeCue(cfg.text, cfg.voice)
    /** 「要你做选择」提示音；关掉开关或文本为空时为 null。 */
    const choiceCue = cfg.announceOnChoice && cfg.choiceText
      ? makeCue(cfg.choiceText, cfg.choiceVoice || cfg.voice)
      : null

    // ---- 开始新对话时的问候语：四段文本各一条 cue，按需生成 ----
    const greetingHours = parseGreetingHours(cfg.greetingHours) || GREETING_DEFAULT_HOURS
    const greetingTexts = {
      morning: cfg.greetingMorning,
      noon: cfg.greetingNoon,
      afternoon: cfg.greetingAfternoon,
      evening: cfg.greetingEvening,
    }
    const greetingCues = new Map()
    /** 取某一时段问候语的 cue；文本为空或开关关掉则为 null。 */
    const greetingCueFor = (kind) => {
      if (greetingCues.has(kind)) return greetingCues.get(kind)
      const text = greetingTexts[kind]
      const cue = cfg.announceOnSessionStart && text ? makeCue(text, cfg.greetingVoice || cfg.voice) : null
      greetingCues.set(kind, cue)
      return cue
    }

    /** 播放一条提示音；没缓存就现合成，Edge 不可用则回退 SAPI。 */
    const playCue = (cue, why) => {
      if (disposed || !cue) return
      const finish = (file) => {
        if (disposed) return
        if (file) {
          player.playFile(file, { powershellPath: cfg.powershellPath, volume: cfg.volume, log })
          log(`speak dispatched (edge, ${why}) voice=${cue.voice}`)
        } else {
          player.sapiSpeak(plainSpeech(cue.text), {
            powershellPath: cfg.powershellPath,
            voiceMatch: cfg.sapiVoiceMatch,
            rate: cfg.rate,
            volume: cfg.volume,
            log,
          })
          log(`speak dispatched (sapi fallback, ${why}) text=${JSON.stringify(plainSpeech(cue.text))}`)
        }
      }
      try {
        const st = fs.statSync(cue.file)
        if (st.size > 0) return finish(cue.file)
      } catch {}
      cue.ensure().then(finish, (err) => { logError('cue.ensure', err); finish(null) })
    }

    /** 悬浮泡把语音关掉时，所有播报都从这一个点短路。 */
    const voiceOff = (why) => {
      if (voiceEnabled) return false
      log(`skip speak: voice off by bubble (${why})`)
      return true
    }

    /** 把一条提示音真正发出去（决定走 Edge 播放还是 SAPI 直读）。 */
    const speakCue = (cue, why) => {
      if (disposed || !cue) return
      if (voiceOff(why)) return
      if (process.platform !== 'win32') {
        log('skip speak: not win32')
        return
      }
      if (cfg.engine === 'sapi' || !cue.text || !cue.voice) {
        player.sapiSpeak(plainSpeech(cue.text), {
          powershellPath: cfg.powershellPath,
          voiceMatch: cfg.sapiVoiceMatch,
          rate: cfg.rate,
          volume: cfg.volume,
          log,
        })
        log(`speak dispatched (sapi, ${why}) text=${JSON.stringify(plainSpeech(cue.text))}`)
        return
      }
      playCue(cue, why)
    }

    // 预合成：让第一次播报也不用等网络。
    const prefetchOne = (cue, tag) => {
      if (!cue || !cue.text || !cue.voice) return
      cue.ensure().then(
        (file) => log(file ? `prefetch ready [${JSON.stringify(cue.text)}]: ${file}` : `prefetch failed [${JSON.stringify(cue.text)}]: will fall back to SAPI`),
        (err) => logError(`prefetch ${tag}`, err),
      )
    }

    const greetingStartKind = greetingKindAt(new Date(), greetingHours)
    if (cfg.prefetch && cfg.engine === 'edge') {
      for (const cue of [doneCue, choiceCue, greetingCueFor(greetingStartKind)]) prefetchOne(cue, 'cue')
      // 剩下三段问候语在后台串行预热：并发握手会被服务端 429，串行 + 1.8s 间隔最稳。
      if (cfg.announceOnSessionStart && cfg.greetingPrefetchAll) {
        const rest = ['morning', 'noon', 'afternoon', 'evening'].filter((k) => k !== greetingStartKind)
        const warm = (i) => {
          if (disposed || i >= rest.length) return
          prefetchOne(greetingCueFor(rest[i]), 'greeting')
          const timer = setTimeout(() => { bgTimers.delete(timer); warm(i + 1) }, 1800)
          bgTimers.add(timer)
        }
        warm(0)
      }
    }

    /** sessionId -> 待播报的定时器 */
    const timers = new Map()
    let lastSpokenAt = 0
    let debugEventsLeft = cfg.debugEvents ? 40 : 0

    /** 限流：离上次发声不足 minMs 就跳过（并记日志）。 */
    const throttleOk = (minMs, label) => {
      const now = Date.now()
      if (now - lastSpokenAt < minMs) {
        log(`skip speak: within ${label} (${minMs}ms)`)
        return false
      }
      lastSpokenAt = now
      return true
    }

    /** 「需要你做选择」的提示音。 */
    const fireChoice = (why) => {
      if (disposed || !choiceCue) return
      if (voiceOff('choice')) return
      if (!throttleOk(cfg.choiceMinIntervalMs, 'choiceMinIntervalMs')) return
      log(`choice cue (${why})`)
      speakCue(choiceCue, `choice: ${why}`)
    }

    /** 判断工具名是否属于「需要用户做选择」的那一类。 */
    let choiceRe = null
    try {
      choiceRe = new RegExp(cfg.choiceToolMatch, 'i')
    } catch (err) {
      log(`invalid choiceToolMatch ${JSON.stringify(cfg.choiceToolMatch)}: ${(err && err.message) || err}`)
    }

    const cancelPending = (sessionId) => {
      const timer = timers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(sessionId)
      }
    }

    /** 会话是否有还在跑的 goal —— 有就说明后面还有轮次，本轮不算「任务完成」。 */
    const goalIsActive = (sessionId) => {
      if (!cfg.skipActiveGoal) return false
      try {
        if (typeof ctx.get !== 'function') return false
        const agents = ctx.get('agents')
        const goals = ctx.get('goals')
        if (!agents || !goals || typeof goals.get !== 'function') return false
        const agent = typeof agents.get === 'function' ? agents.get(sessionId) : null
        if (!agent) return false
        const view = goals.get(agent)
        if (!view || typeof view !== 'object') return false
        return view.phase === 'active'
      } catch (err) {
        logError('goalIsActive', err)
        return false
      }
    }

    const fire = (sessionId) => {
      if (disposed) return
      if (voiceOff('turn end')) return
      try {
        if (goalIsActive(sessionId)) {
          log(`skip speak: session ${sessionId} has an active goal`)
          return
        }
        if (!throttleOk(cfg.minIntervalMs, 'minIntervalMs')) return
        speakCue(doneCue, 'turn end')
      } catch (err) {
        logError('fire', err)
      }
    }

    /** 开始新对话时的问候语：cordis 的 session/created 每个会话只发一次。 */
    let lastGreetedAt = 0
    const fireGreeting = (session, why) => {
      if (disposed || !cfg.announceOnSessionStart) return
      try {
        if (!cfg.includeSubagents && isSubagentSession(session)) {
          log('skip greeting: subagent session')
          return
        }
        if (cfg.greetingSkipSeeded && session && session.header && session.header.isSeeded === true) {
          log('skip greeting: seeded session (resumed or forked)')
          return
        }
        const kind = greetingKindAt(new Date(), greetingHours)
        const cue = greetingCueFor(kind)
        if (!cue) return
        const now = Date.now()
        if (now - lastGreetedAt < cfg.greetingMinIntervalMs) {
          log(`skip greeting: within greetingMinIntervalMs (${cfg.greetingMinIntervalMs}ms)`)
          return
        }
        lastGreetedAt = now
        const timer = setTimeout(() => {
          bgTimers.delete(timer)
          if (voiceOff('greeting')) return
          log(`greeting cue (${kind}, ${why})`)
          speakCue(cue, `greeting: ${kind}`)
        }, Math.max(0, cfg.greetingDelayMs))
        bgTimers.add(timer)
      } catch (err) {
        logError('fireGreeting', err)
      }
    }

    /**
     * session/created 由 dsh-session 在会话 carrier 作用域里派发：
     * cordis 只在 hook 带 global 时才保证不受作用域过滤（cordis/lib/index.js:263），
     * 所以优先用 { global: true } 注册，不支持再退回普通注册。
     */
    const subscribeCreated = (cb) => {
      try {
        return ctx.on('session/created', cb, { global: true })
      } catch (err) {
        log(`global on() unsupported, falling back: ${(err && err.message) || err}`)
        return ctx.on('session/created', cb)
      }
    }

    const disposeCreated = subscribeCreated((session) => {
      fireGreeting(session, `session=${(session && session.id) || '?'}`)
    })

    const disposeEvent = ctx.on('session/event', (session, event) => {
      try {
        const sessionId = (session && session.id) || 'default'
        const type = event && event.type
        const data = (event && event.data) || {}

        if (debugEventsLeft > 0) {
          debugEventsLeft -= 1
          log(`event ${type} session=${sessionId} data=${JSON.stringify(data).slice(0, 400)}`)
        }

        // 新一轮开始了：说明上一轮不是终点，撤销待播报。
        if (type === 'turn/start') {
          cancelPending(sessionId)
          return
        }

        // 需要人在界面上做选择：模型调用了 ask_user_question / exit_plan_mode 之类。
        if (type === 'tool/call') {
          const toolName = String((data && data.name) || '')
          if (choiceRe && choiceRe.test(toolName)) {
            fireChoice(`tool ${toolName} session=${sessionId}`)
          }
          return
        }

        // 权限确认（要放行一条命令之类）同样是在等用户做选择。
        if (type === 'approval/asked') {
          if (cfg.announceOnApproval) {
            fireChoice(`approval tool=${(data && data.toolName) || '?'} session=${sessionId}`)
          }
          return
        }

        if (type !== 'turn/end') return

        cancelPending(sessionId)

        const reasonKind = data.reason && data.reason.kind
        if (reasonKind && reasonKind !== 'completed') {
          log(`skip speak: turn/end reason=${reasonKind}`)
          return
        }
        if (!cfg.includeSubagents && isSubagentSession(session)) {
          log('skip speak: subagent session')
          return
        }

        const timer = setTimeout(() => {
          timers.delete(sessionId)
          fire(sessionId)
        }, Math.max(0, cfg.settleMs))
        timers.set(sessionId, timer)
      } catch (err) {
        logError('session/event', err)
      }
    })

    let announceTimer
    if (cfg.announceOnLoad) announceTimer = setTimeout(() => fire('__announce__'), 300)

    ctx.effect(() => () => {
      disposed = true
      try { disposeEvent() } catch {}
      try { disposeCreated() } catch {}
      if (announceTimer) clearTimeout(announceTimer)
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const timer of bgTimers) clearTimeout(timer)
      bgTimers.clear()
      log('disposed')
    })

    log('ready: listening on session/event + session/created')
  },
}
