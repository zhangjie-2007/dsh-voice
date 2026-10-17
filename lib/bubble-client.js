/* dsh-completion-voice —— 语音开关小悬浮泡（注入到 DSH Web 页面里运行） */
(function () {
  'use strict'
  if (window.__dcvBubbleInstalled) return
  window.__dcvBubbleInstalled = true

  var API = '/dsh-completion-voice/api'
  var POS_KEY = 'dcv-bubble-pos'
  var state = { enabled: true, ready: false, sound: true }

  // ---- 开关时的小音效（Web Audio 现场合成，零资源、零延迟、断网也有）----
  var actx = null
  function audioCtx() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      if (!actx) actx = new AC()
      if (actx.state === 'suspended') {
        var p = actx.resume()
        if (p && p.catch) p.catch(function () {})
      }
      return actx
    } catch (e) {
      return null
    }
  }

  function tone(ctx, freq, at, dur, peak, type) {
    var osc = ctx.createOscillator()
    var gain = ctx.createGain()
    osc.type = type || 'sine'
    osc.frequency.setValueAtTime(freq, at)
    // 像小铃铛：极快起音 + 指数衰减
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(at)
    osc.stop(at + dur + 0.03)
  }

  /** 开启：上行三连音 + 一点高频闪光（bingo 感）。 */
  function chimeOn() {
    var ctx = audioCtx()
    if (!ctx) return
    var t = ctx.currentTime + 0.01
    var notes = [1046.5, 1318.51, 1567.98] // C6 E6 G6
    for (var i = 0; i < notes.length; i++) tone(ctx, notes[i], t + i * 0.072, 0.3, 0.16)
    tone(ctx, 2093.0, t + 0.216, 0.26, 0.09)
  }

  /** 关闭：下行两音，软一点（不吵人）。 */
  function chimeOff() {
    var ctx = audioCtx()
    if (!ctx) return
    var t = ctx.currentTime + 0.01
    tone(ctx, 880.0, t, 0.2, 0.13, 'triangle')
    tone(ctx, 587.33, t + 0.085, 0.26, 0.11, 'triangle')
  }

  function chime(enabled) {
    if (!state.sound) return
    if (enabled) chimeOn()
    else chimeOff()
  }

  var STYLE = [
    '.dcv-wrap{position:fixed;left:22px;bottom:22px;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;',
    'font-family:inherit;-webkit-user-select:none;user-select:none;touch-action:none}',
    '.dcv-btn{position:relative;width:40px;height:40px;padding:0;border:0;border-radius:50%;cursor:grab;display:flex;align-items:center;justify-content:center;',
    'background:linear-gradient(140deg,#ffb4d3 0%,#c9a6ff 55%,#9d8cff 100%);',
    'box-shadow:0 6px 16px rgba(157,140,255,.42),0 1px 0 rgba(255,255,255,.65) inset;',
    'transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease,filter .2s ease;outline:none}',
    '.dcv-btn:hover{transform:scale(1.09);box-shadow:0 9px 22px rgba(157,140,255,.55),0 1px 0 rgba(255,255,255,.65) inset}',
    '.dcv-btn:active{transform:scale(.93)}',
    '.dcv-btn.dcv-dragging{cursor:grabbing;transform:scale(1.04)}',
    '.dcv-btn.dcv-busy{filter:brightness(.94) saturate(.9)}',
    '.dcv-btn.dcv-off{background:linear-gradient(140deg,#e6e8ee 0%,#c8ccd8 100%);box-shadow:0 4px 10px rgba(100,116,139,.28),0 1px 0 rgba(255,255,255,.7) inset}',
    '.dcv-btn svg{width:21px;height:21px;position:relative;z-index:1;overflow:visible}',
    '.dcv-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,255,255,.85);opacity:0;pointer-events:none}',
    '.dcv-wrap.dcv-live .dcv-ring{animation:dcv-ping 2.6s ease-out infinite}',
    '@keyframes dcv-ping{0%{transform:scale(.86);opacity:.75}70%{transform:scale(1.6);opacity:0}100%{transform:scale(1.6);opacity:0}}',
    '.dcv-wrap.dcv-pop .dcv-btn{animation:dcv-pop .42s cubic-bezier(.34,1.56,.64,1)}',
    '@keyframes dcv-pop{0%{transform:scale(.82)}55%{transform:scale(1.16)}100%{transform:scale(1)}}',
    '.dcv-toast{max-width:150px;padding:5px 10px;border-radius:999px;font-size:12px;line-height:1.35;white-space:nowrap;',
    'color:#fff;background:rgba(30,27,58,.86);backdrop-filter:blur(6px);box-shadow:0 4px 12px rgba(0,0,0,.22);',
    'opacity:0;transform:translateY(6px);transition:opacity .22s ease,transform .22s ease;pointer-events:none}',
    '.dcv-toast.dcv-show{opacity:1;transform:translateY(0)}',
    '@media (prefers-color-scheme:light){.dcv-toast{background:rgba(45,40,80,.9)}}'
  ].join('')

  // 两种状态只留**一个**喇叭：开 = 喇叭 + 两道声波，关 = 喇叭 + 叉。
  // 图标内容整体替换，不用「两个 svg 靠 CSS 互斥」—— 那样容易被更高优先级的选择器顶掉。
  var ICON_ON =
    '<path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="#fff" stroke="none"/>' +
    '<path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8"/><path d="M18.2 5.8a8.8 8.8 0 0 1 0 12.4"/>'
  var ICON_OFF =
    '<path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="#fff" stroke="none"/>' +
    '<path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/>'
  var SVG_ICON =
    '<svg class="dcv-ico" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + ICON_ON + '</svg>'

  function mount() {
    if (document.getElementById('dcv-wrap')) return
    var style = document.createElement('style')
    style.setAttribute('data-dsh-completion-voice', '1')
    style.textContent = STYLE
    document.head.appendChild(style)

    var wrap = document.createElement('div')
    wrap.className = 'dcv-wrap'
    wrap.id = 'dcv-wrap'
    var btn = document.createElement('button')
    btn.className = 'dcv-btn'
    btn.id = 'dcv-btn'
    btn.type = 'button'
    btn.innerHTML = '<span class="dcv-ring"></span>' + SVG_ICON
    var toast = document.createElement('div')
    toast.className = 'dcv-toast'
    toast.id = 'dcv-toast'
    wrap.appendChild(btn)
    wrap.appendChild(toast)
    document.body.appendChild(wrap)

    restorePos(wrap)
    paint(wrap, btn)
    window.addEventListener('resize', function () { clampIntoView(wrap) })
    bindDrag(wrap, btn, toast)
    refresh(wrap, btn)
  }

  function paint(wrap, btn) {
    btn.classList.toggle('dcv-off', !state.enabled)
    wrap.classList.toggle('dcv-live', state.enabled)
    var ico = btn.querySelector('svg.dcv-ico')
    var want = state.enabled ? ICON_ON : ICON_OFF
    if (ico && ico.innerHTML !== want) ico.innerHTML = want
    btn.title = state.enabled ? '语音提示：开（点击关闭）' : '语音提示：已关（点击开启）'
    btn.setAttribute('aria-label', btn.title)
    btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false')
  }

  function say(toast, text) {
    toast.textContent = text
    toast.classList.add('dcv-show')
    clearTimeout(say._t)
    say._t = setTimeout(function () { toast.classList.remove('dcv-show') }, 1500)
  }

  function apply(wrap, btn, enabled, toast, text) {
    state.enabled = !!enabled
    paint(wrap, btn)
    wrap.classList.remove('dcv-pop')
    void wrap.offsetWidth
    wrap.classList.add('dcv-pop')
    if (toast && text) say(toast, text)
  }

  function refresh(wrap, btn) {
    fetch(API, { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (body) {
        state.ready = true
        if (typeof body.sound === 'boolean') state.sound = body.sound
        apply(wrap, btn, body.enabled, null, '')
      })
      .catch(function () { /* 宿主没起来时静默：默认按开显示 */ })
  }

  function toggle(wrap, btn, toast) {
    if (state.busy) return
    state.busy = true
    btn.classList.add('dcv-busy')
    // 先出声：点下去立刻有反馈（这是界面音效，与「静音」无关，听得到）
    chime(!state.enabled)
    fetch(API, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toggle: true })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (body) {
        apply(wrap, btn, body.enabled, toast, body.enabled ? '语音已开 🔔' : '语音已关 🔕')
      })
      .catch(function (err) {
        say(toast, '切换失败 ' + (err && err.message ? err.message : ''))
      })
      .then(function () {
        state.busy = false
        btn.classList.remove('dcv-busy')
      })
  }

  function bindDrag(wrap, btn, toast) {
    var drag = null
    btn.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      var rect = wrap.getBoundingClientRect()
      drag = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top, moved: false }
      btn.classList.add('dcv-dragging')
      try { btn.setPointerCapture(ev.pointerId) } catch (e) {}
    })
    btn.addEventListener('pointermove', function (ev) {
      if (!drag) return
      var dx = ev.clientX - drag.x
      var dy = ev.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      place(wrap, drag.left + dx, drag.top + dy)
    })
    function finish(ev) {
      if (!drag) return
      var moved = drag.moved
      drag = null
      btn.classList.remove('dcv-dragging')
      try { btn.releasePointerCapture(ev.pointerId) } catch (e) {}
      if (moved) savePos(wrap)
      else toggle(wrap, btn, toast)
    }
    btn.addEventListener('pointerup', finish)
    btn.addEventListener('pointercancel', function (ev) {
      if (!drag) return
      drag = null
      btn.classList.remove('dcv-dragging')
      try { btn.releasePointerCapture(ev.pointerId) } catch (e) {}
    })
    btn.addEventListener('click', function (ev) { ev.preventDefault() })
  }

  function place(wrap, left, top) {
    var maxL = Math.max(4, window.innerWidth - wrap.offsetWidth - 4)
    var maxT = Math.max(4, window.innerHeight - wrap.offsetHeight - 4)
    var l = Math.min(Math.max(4, left), maxL)
    var t = Math.min(Math.max(4, top), maxT)
    wrap.style.left = l + 'px'
    wrap.style.top = t + 'px'
    wrap.style.bottom = 'auto'
    wrap.style.right = 'auto'
  }

  function clampIntoView(wrap) {
    if (!wrap.style.top) return
    place(wrap, parseFloat(wrap.style.left), parseFloat(wrap.style.top))
  }

  function savePos(wrap) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: parseFloat(wrap.style.left), top: parseFloat(wrap.style.top)
      }))
    } catch (e) {}
  }

  function restorePos(wrap) {
    try {
      var raw = localStorage.getItem(POS_KEY)
      if (!raw) return
      var pos = JSON.parse(raw)
      if (pos && isFinite(pos.left) && isFinite(pos.top)) place(wrap, pos.left, pos.top)
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
  // 页面换了内容（比如切会话）时，若节点被清掉就重新挂上
  var recheck = setInterval(function () {
    if (!document.getElementById('dcv-wrap')) {
      if (document.body) mount()
    }
  }, 4000)
  window.addEventListener('beforeunload', function () { clearInterval(recheck) })
})()
