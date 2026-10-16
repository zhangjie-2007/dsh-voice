/**
 * 宿主侧播放：用 Windows PowerShell 起一个隐藏进程，通过 WPF MediaPlayer 播放 mp3；
 * 若没有可用音频文件则回退到 SAPI 直接朗读文本。
 *
 * 为什么走 PowerShell：DSH 宿主（Electron Node）没有内置音频输出，
 * 而 Windows 自带的 PowerShell + PresentationCore 可以零依赖播放 mp3。
 *
 * 关键工程约定：
 *   - 一律用 `-EncodedCommand`（UTF-16LE + base64）传脚本，绝不用 `-Command`，
 *     否则中文与引号会被代码页毁掉。
 *   - 脚本内的字符串用单引号字面量，单引号本身用 '' 转义。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

export function resolvePowershell(explicit) {
  if (explicit) return explicit
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function buildPlayScript(file, volume) {
  const vol = Math.min(1, Math.max(0, Number(volume) / 100 || 0))
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName PresentationCore`,
    `$p = New-Object System.Windows.Media.MediaPlayer`,
    `$p.Volume = ${vol}`,
    `$p.Open([Uri]${psLiteral(file)})`,
    `$n = 0`,
    `while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 250) { Start-Sleep -Milliseconds 20; $n++ }`,
    `$p.Play()`,
    `$dur = 5000`,
    `if ($p.NaturalDuration.HasTimeSpan) { $dur = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds }`,
    `Start-Sleep -Milliseconds ($dur + 400)`,
    `$p.Close()`,
  ].join('\n')
}

export function buildSapiScript(text, { voiceMatch, rate, volume } = {}) {
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$v = New-Object -ComObject SAPI.SpVoice`,
  ]
  if (voiceMatch) {
    lines.push(`foreach ($c in $v.GetVoices()) { if ($c.GetDescription() -match ${psLiteral(voiceMatch)}) { $v.Voice = $c; break } }`)
  }
  lines.push(`$v.Rate = ${Number.isFinite(Number(rate)) ? Math.max(-10, Math.min(10, Math.round(Number(rate) / 10))) : 0}`)
  lines.push(`$v.Volume = ${Number.isFinite(Number(volume)) ? Math.max(0, Math.min(100, Math.round(Number(volume)))) : 100}`)
  lines.push(`$v.Speak(${psLiteral(text)}) | Out-Null`)
  return lines.join('\n')
}

function dispatch(script, { powershellPath, log, what }) {
  const exe = resolvePowershell(powershellPath)
  let child
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(script)], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (err) {
    log(`spawn failed (${what}): ${err && err.message}`)
    return null
  }
  child.on('error', (err) => log(`child error (${what}): ${err && err.message}`))
  if (log) log(`dispatched ${what} pid=${child.pid}`)
  return child
}

/** 播放本地 mp3（或任何 MediaPlayer 支持的文件）。 */
export function playFile(file, { powershellPath, volume = 100, log = () => {} } = {}) {
  return dispatch(buildPlayScript(file, volume), { powershellPath, log, what: `play ${path.basename(file)}` })
}

/** 回退：直接让 SAPI 朗读。 */
export function sapiSpeak(text, { powershellPath, voiceMatch, rate, volume, log = () => {} } = {}) {
  return dispatch(buildSapiScript(text, { voiceMatch, rate, volume }), { powershellPath, log, what: 'sapi speak' })
}
