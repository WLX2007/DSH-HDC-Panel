// MCP stdio transport.
//
// The MCP stdio transport frames JSON-RPC messages as newline-delimited
// JSON: one message per line, no embedded raw newlines.
//
// stdout belongs to the protocol exclusively — every diagnostic of this
// server goes to stderr, otherwise the client's frame parser breaks.

export function createStdioTransport(options = {}) {
  const onMessage = options.onMessage || (() => {})
  const onError = options.onError || (() => {})
  let buffer = ''
  let closed = false

  const stdin = options.input || process.stdin
  const stdout = options.output || process.stdout

  function send(message) {
    if (closed) return
    try {
      stdout.write(JSON.stringify(message) + '\n')
    } catch (e) {
      onError(e)
    }
  }

  function consume(line) {
    const text = line.trim()
    if (!text) return
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      onError(e)
      // A parse error is answered with a JSON-RPC error object; the client
      // needs the id, which cannot be recovered, so null is used.
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + String(e && e.message ? e.message : e) } })
      return
    }
    Promise.resolve(onMessage(parsed)).catch((e) => onError(e))
  }

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      consume(line)
      index = buffer.indexOf('\n')
    }
  })
  stdin.on('end', () => {
    if (buffer.trim()) consume(buffer)
    buffer = ''
    closed = true
    if (typeof options.onClose === 'function') options.onClose()
  })
  stdin.on('error', (e) => onError(e))

  return {
    send,
    close() {
      closed = true
      try { stdin.pause() } catch { /* already closed */ }
    },
  }
}
