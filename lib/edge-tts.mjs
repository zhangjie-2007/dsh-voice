/**
 * 无依赖的 Edge 神经语音（Edge TTS）客户端。
 *
 * 协议来自微软 Edge「大声朗读」所用服务，2026 年起已从
 *   wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 * 迁移到
 *   wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1
 * 鉴权参数由 TrustedClientToken 改为 Ocp-Apim-Subscription-Key。
 *
 * 只有三种 outputFormat 被服务端接受（其余一律以 WebSocket 1007 关闭）：
 *   audio-24khz-48kbitrate-mono-mp3 / audio-24khz-96kbitrate-mono-mp3 / webm-24khz-16bit-mono-opus
 */
import { createHash, randomUUID } from 'node:crypto'
import { connectWebSocket } from './ws-client.mjs'

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const SEC_MS_GEC_VERSION = '1-143.0.3650.96'
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'

export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
export const OUTPUT_EXT = 'mp3'

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Sec-MS-GEC：Windows FILETIME 时间戳按 300 秒取整后 ×10^7，拼上固定 token 取 SHA-256 大写 hex。 */
export function secMsGec(now = Date.now()) {
  const ticks = BigInt(Math.floor(now / 1000) + 11644473600) * 10000000n
  const rounded = ticks - (ticks % 3000000000n)
  return createHash('sha256').update(`${rounded}${TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

function buildUrl() {
  const q = new URLSearchParams({
    'Ocp-Apim-Subscription-Key': TOKEN,
    'Sec-MS-GEC': secMsGec(),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
    ConnectionId: randomUUID(),
  })
  return `${WSS_URL}?${q.toString()}`
}

/** 从声线名推出 xml:lang：zh-CN-XiaoyiNeural -> zh-CN。 */
export function localeOf(voice) {
  const parts = String(voice || '').split('-')
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'zh-CN'
}

function configMessage(outputFormat) {
  return 'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
    `{\n  "context": {\n    "synthesis": {\n      "audio": {\n        "metadataoptions": {\n` +
    `          "sentenceBoundaryEnabled": "false",\n          "wordBoundaryEnabled": "false"\n` +
    `        },\n        "outputFormat": "${outputFormat}"\n      }\n    }\n  }\n}`
}

/**
 * 文本里包含这些标签时，按内联 SSML 原样透传（不做 XML 转义），
 * 这样就能对句子里的某几个字单独调速/加停顿，例如把第二个「老大」的尾音拖长：
 *   老大<prosody rate="-45%">老大</prosody>，等你做选择呢
 */
const SSML_MARKUP_RE = /<(prosody|break|emphasis|say-as|phoneme|sub|mstts:)/i

function ssmlMessage(text, voice, { rate = 0, pitch = 0, volume = 0, lang, plainVoice } = {}) {
  const requestId = randomUUID().replace(/-/g, '')
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const hasMarkup = SSML_MARKUP_RE.test(text)
  // 内联 SSML 与最外层 <prosody> 不能嵌套（服务端直接 1007），所以有标签时就不再套外层 prosody。
  // 代价：整句的 rate/pitch/volume 会被内联标签接管，需要时自己写在标签上。
  const plain = plainVoice === undefined ? hasMarkup : plainVoice
  const body = hasMarkup ? String(text) : esc(text)
  const inner = plain
    ? body
    : `<prosody pitch="${pitch >= 0 ? '+' : ''}${pitch}Hz" rate="${rate >= 0 ? '+' : ''}${rate}%" volume="${volume >= 0 ? '+' : ''}${volume}%">${body}</prosody>`
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang || localeOf(voice)}">` +
    `<voice name="${voice}">${inner}</voice></speak>`
  return { requestId, message: `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}` }
}

/**
 * 合成一段语音，返回 { audio: Buffer(mp3), control: string[] }。
 * 失败时抛出 Error，并带上 .control / .chunks 便于排查。
 */
export async function synthesize({
  text,
  voice,
  rate = 0,
  pitch = 0,
  volume = 0,
  lang,
  plainVoice,
  outputFormat = OUTPUT_FORMAT,
  timeoutMs = 30000,
  verbose = false,
  log = () => {},
} = {}) {
  if (!text) throw new Error('synthesize: empty text')
  if (!voice) throw new Error('synthesize: no voice')

  const ws = await connectWebSocket(buildUrl(), { headers: BROWSER_HEADERS, timeoutMs: 15000 })
  const chunks = []
  const control = []
  try {
    const audio = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthesize: timeout')), timeoutMs)
      const finish = (fn, arg) => { clearTimeout(timer); fn(arg) }
      ws.on('error', (err) => finish(reject, err))
      ws.on('close', (c) => finish(reject, new Error(`synthesize: socket closed code=${c.code}`)))
      ws.on('message', ({ binary, data }) => {
        if (!binary) {
          const s = data.toString('utf8')
          if (verbose) log('    <- ' + s.replace(/\r\n/g, ' | ').slice(0, 300))
          const m = /Path:([\w.]+)/.exec(s)
          if (m) control.push(m[1])
          if (s.includes('Path:turn.end')) finish(resolve, Buffer.concat(chunks))
          return
        }
        const headerLength = data.readUInt16BE(0)
        const header = data.subarray(2, 2 + headerLength).toString('utf8')
        if (verbose) log(`    <- [bin ${data.length}B] ${header.replace(/\r\n/g, ' | ')}`)
        if (header.includes('Path:audio')) chunks.push(data.subarray(2 + headerLength))
      })
      ws.sendText(configMessage(outputFormat))
      ws.sendText(ssmlMessage(text, voice, { rate, pitch, volume, lang, plainVoice }).message)
    })
    if (!audio.length) throw new Error(`synthesize: no audio (control=${control.join(',')})`)
    return { audio, control }
  } catch (err) {
    err.control = control
    err.chunks = chunks.length
    throw err
  } finally {
    try { ws.close() } catch {}
  }
}
