/**
 * 极简 WebSocket 客户端（仅客户端侧，够用于 Edge TTS）。
 * 用 node:https 手动做 Upgrade 握手，因为需要自定义 Header（Origin/UA），
 * 而 Node 内置的全局 WebSocket 不允许设置自定义请求头。
 */
import https from 'node:https'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function md5hex(input) {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

export function connectWebSocket(rawUrl, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl)
    const key = randomBytes(16).toString('base64')
    const req = https.request({
      host: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    })
    let settled = false
    const fail = (err) => { if (!settled) { settled = true; try { req.destroy() } catch {} reject(err) } }

    req.on('upgrade', (res, socket, head) => {
      if (settled) return
      settled = true
      const accept = createHash('sha1').update(key + GUID).digest('base64')
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy()
        reject(new Error(`bad Sec-WebSocket-Accept: ${res.headers['sec-websocket-accept']}`))
        return
      }
      socket.setNoDelay(true)
      socket.setTimeout(0)
      resolve(makeConnection(socket, head))
    })
    req.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { if (body.length < 500) body += c })
      res.on('end', () => fail(new Error(`handshake failed: HTTP ${res.statusCode} ${res.statusMessage} ${body.slice(0, 200)}`)))
    })
    req.on('error', (e) => fail(e))
    req.on('timeout', () => fail(new Error('handshake timeout')))
    req.end()
  })
}

function makeConnection(socket, head) {
  const listeners = { message: [], close: [], error: [], open: [] }
  const emit = (name, arg) => { for (const fn of listeners[name]) { try { fn(arg) } catch (err) { emit('error', err) } } }

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
  let closed = false
  const fragments = []

  const handleFrame = (fin, opcode, payload) => {
    if (opcode === 0x8) { // close
      closed = true
      try { socket.end() } catch {}
      emit('close', { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 })
      return
    }
    if (opcode === 0x9) { // ping -> pong
      try { socket.write(encodeFrame(0xa, payload)) } catch {}
      return
    }
    if (opcode === 0xa) return // pong
    if (opcode === 0x0) fragments.push(payload)
    else { fragments.length = 0; fragments.push(payload) }
    if (!fin) return
    const data = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
    fragments.length = 0
    emit('message', { binary: opcode === 0x2 || opcode === 0x0, data })
  }

  const pump = () => {
    while (true) {
      if (buffer.length < 2) return
      const b0 = buffer[0]
      const b1 = buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset); offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const big = buffer.readBigUInt64BE(offset); offset += 8
        if (big > 64n * 1024n * 1024n) { emit('error', new Error('frame too large')); return }
        length = Number(big)
      }
      let maskKey = null
      if (masked) {
        if (buffer.length < offset + 4) return
        maskKey = buffer.subarray(offset, offset + 4); offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (maskKey) {
        const copy = Buffer.from(payload)
        for (let i = 0; i < copy.length; i++) copy[i] ^= maskKey[i & 3]
        payload = copy
      }
      buffer = buffer.subarray(offset + length)
      handleFrame(fin, opcode, payload)
      if (closed) return
    }
  }

  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    pump()
  })
  socket.on('error', (err) => emit('error', err))
  socket.on('close', () => { if (!closed) { closed = true; emit('close', { code: 1006 }) } })

  return {
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); return this },
    sendText(text) { if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))) },
    close() { if (!closed) { closed = true; try { socket.write(encodeFrame(0x8, Buffer.alloc(0))); socket.end() } catch {} } },
    get closed() { return closed },
  }
}

function encodeFrame(opcode, payload) {
  const mask = randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(6)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | length
    mask.copy(header, 2)
  } else if (length < 65536) {
    header = Buffer.alloc(8)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
    mask.copy(header, 4)
  } else {
    header = Buffer.alloc(14)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
    mask.copy(header, 10)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
  return Buffer.concat([header, masked])
}
