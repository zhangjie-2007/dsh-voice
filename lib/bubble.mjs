/**
 * 语音开关小悬浮泡 —— 宿主侧。
 * ----------------------------------------------------------------------------
 * 桌面端页面里怎么塞进一个按钮：
 *   桌面壳的 index.html 是安装包里的静态 dist，`webServer.tapIndex` 永远过不去。
 *   唯一通道是 `webserver/index-inject` 推的结构化行（宿主启动时**一次性收集**后缓存，
 *   没有刷新路径 ⇒ 行必须在 apply() 里同步注册）。
 *   行类型只能用内联 `script`：页面侧解释器对 `script-src` 是"加载失败即 reject 整个 boot"，
 *   而内联行由我们自己建 <script src>、并吞掉 onerror —— 路由不在也绝不拖垮宿主。
 *   代价：**新增/删掉这个气泡需要重启 DSH 才会出现在页面上**。
 *
 * 气泡做的事只有一件：切换「语音提示」总开关（= 让插件闭嘴 / 恢复发声）。
 * 开关状态落在 <cacheDir>/bubble-state.json，重启后保持。
 *
 * 安全栅栏（照 dsh-whale-widget 的 issue #92/#136 做法）：
 *   Host 必须是回环地址；`Sec-Fetch-Site: cross-site` 一律拒；带 Origin 时必须与 Host 同源；
 *   写请求（POST）必须来自本机；宿主提供了 `connection.requestRejection` 就再委托它一层。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const BUBBLE_JS_PATH = '/dsh-completion-voice/bubble.js'
export const BUBBLE_API_PATH = '/dsh-completion-voice/api'

const CLIENT_FILE = fileURLToPath(new URL('./bubble-client.js', import.meta.url))

let cachedClient = ''
/** 客户端脚本只在第一次请求时读盘（改完源码要重启宿主才生效，和注入行同理）。 */
function clientSource() {
  if (!cachedClient) cachedClient = fs.readFileSync(CLIENT_FILE, 'utf8')
  return cachedClient
}

/** 注入行：只负责把 /dsh-completion-voice/bubble.js 挂进页面，失败静默。 */
const INJECT_ROW_TEXT =
  '(function(){try{if(window.__dcvBubbleInstalled)return;' +
  'var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${BUBBLE_JS_PATH}";` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** 只认回环：localhost / *.localhost / 127.0.0.0/8 / ::1。 */
function isLoopbackHostname(raw) {
  const h = String(raw || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function deny(res, code) {
  try {
    res.statusCode = code || 403
    res.end()
  } catch {}
  return true
}

/** 通过 → false；否则拒绝并返回 true。 */
function rejected(req, res, conn) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch {
      return deny(res, 403) // 缺 Host / 畸形
    }
    const authority = hostUrl.host.toLowerCase()
    const loopback = isLoopbackHostname(hostUrl.hostname)
    // 宿主的栅栏知道 --trusted-host 声明了谁；它在就直接委托，自校验只管回环之外的一律拒。
    let connVerdict = null
    if (conn && typeof conn.requestRejection === 'function') {
      try {
        connVerdict = conn.requestRejection(req)
      } catch {
        return deny(res, 403) // 栅栏自己抛异常 → 按拒绝处理（fail-closed）
      }
      if (connVerdict) return deny(res, connVerdict === true ? 403 : Number(connVerdict) || 403)
    }
    if (!loopback && !conn) return deny(res, 403)
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return deny(res, 403)
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try {
        originUrl = new URL(origin)
      } catch {
        return deny(res, 403)
      }
      if (originUrl.host.toLowerCase() !== authority) return deny(res, 403)
    }
    // 写请求必须是本机发起的。
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && !loopback) return deny(res, 403)
    return false
  } catch {
    return deny(res, 403)
  }
}

function sendJson(res, status, body) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  } catch {}
}

/** 读请求体（上限 4KB，够放一个 {enabled:false}）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4096) {
        resolve('')
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * 装上悬浮泡。
 * @param ctx - 插件 apply 收到的 cordis Context。
 * @param opts.runtime - { get enabled(), setEnabled(next) }：语音总开关的读写。
 * @param opts.log / opts.logError - 插件日志。
 */
export function installBubble(ctx, { runtime, sound = true, log, logError }) {
  const disposers = []
  /** 浏览器侧读到的「要不要放开关音效」。 */
  const wantsSound = () => sound !== false

  // ① 注入行：必须同步注册（宿主启动时一次性收集注入表）。
  try {
    disposers.push(ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === BUBBLE_JS_PATH) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(BUBBLE_JS_PATH) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: INJECT_ROW_TEXT })
      } catch (err) {
        logError('bubble.inject', err)
      }
    }))
  } catch (err) {
    logError('bubble.on(index-inject)', err)
  }

  // ② 路由：等 webServer 就绪后再挂。
  try {
    disposers.push(ctx.inject(['webServer'], (scope) => {
      const web = (scope && scope.webServer) || (scope && typeof scope.get === 'function' ? scope.get('webServer') : null)
      if (!web || typeof web.register !== 'function') {
        log('bubble: webServer unavailable, bubble route not mounted')
        return
      }
      let conn = null
      try {
        conn = typeof scope.get === 'function' ? scope.get('connection') : scope.connection
      } catch {}
      if (!conn) {
        try { conn = typeof ctx.get === 'function' ? ctx.get('connection') : null } catch {}
      }

      disposers.push(web.register({
        kind: 'exact',
        path: BUBBLE_JS_PATH,
        handler: (req, res) => {
          if (rejected(req, res, conn)) return
          try {
            const body = clientSource()
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Length': Buffer.byteLength(body),
            })
            res.end(body)
          } catch (err) {
            logError('bubble.client', err)
            deny(res, 500)
          }
        },
      }))

      disposers.push(web.register({
        kind: 'exact',
        path: BUBBLE_API_PATH,
        handler: async (req, res) => {
          if (rejected(req, res, conn)) return
          const method = String((req && req.method) || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            sendJson(res, 200, { ok: true, enabled: runtime.enabled, sound: wantsSound() })
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let parsed = {}
          try {
            const raw = await readBody(req)
            parsed = raw ? JSON.parse(raw) : {}
          } catch {
            parsed = {}
          }
          const next = typeof (parsed && parsed.enabled) === 'boolean' ? parsed.enabled : !runtime.enabled
          try {
            runtime.setEnabled(next)
          } catch (err) {
            logError('bubble.setEnabled', err)
          }
          sendJson(res, 200, { ok: true, enabled: runtime.enabled, sound: wantsSound() })
        },
      }))

      // ③ web 形态（浏览器直开 dsh web）没有注入行，用 tapIndex 顺带插一行 <script>。
      try {
        if (typeof web.tapIndex === 'function') {
          disposers.push(web.tapIndex((html) => {
            try {
              if (typeof html !== 'string' || html.indexOf(BUBBLE_JS_PATH) !== -1) return html
              const tag = `<script defer src="${BUBBLE_JS_PATH}"></script>`
              if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
              return html + tag
            } catch {
              return html
            }
          }))
        }
      } catch (err) {
        logError('bubble.tapIndex', err)
      }

      log(`bubble: routes ready (${BUBBLE_JS_PATH})`)
    }))
  } catch (err) {
    logError('bubble.inject(webServer)', err)
  }

  try {
    ctx.effect(() => () => {
      for (const off of disposers) {
        try { if (typeof off === 'function') off() } catch {}
      }
    })
  } catch {}

  return disposers
}

/** 读开关状态：文件不存在或读不懂 → 发声（true）。 */
export function readVoiceEnabled(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled
    return true
  } catch {
    return true
  }
}

/** 写开关状态；失败只记日志（不影响发声逻辑）。 */
export function writeVoiceEnabled(file, enabled, logError) {
  try {
    fs.writeFileSync(file, JSON.stringify({ enabled: !!enabled, updatedAt: new Date().toISOString() }, null, 2) + '\n')
  } catch (err) {
    if (logError) logError('bubble.writeState', err)
  }
}
