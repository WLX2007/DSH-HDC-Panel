// Manual device acceptance: drives the real tools against a connected
// HarmonyOS device over the MCP protocol.
//
// Usage: node scripts/device-check.mjs
//
// It exercises the paths that only a real device can validate:
//   hdc_shell (argv delivery, apostrophe escaping)
//   hdc_ui_dump / hdc_ui_find (layout pull + parse)
//   hdc_screenshot (JPEG pull + inline image block)
//   hdc_hilog (log tail)
//   hdc_app query (bundle management)

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const child = spawn(process.execPath, [join(ROOT, 'bin', 'dsh-hdc-mcp.mjs')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const replies = new Map()
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && replies.has(msg.id)) {
          replies.get(msg.id)(msg)
          replies.delete(msg.id)
        }
      } catch { /* ignore */ }
    }
    index = buffer.indexOf('\n')
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

let seq = 0
function call(name, args) {
  return new Promise((resolve, reject) => {
    seq += 1
    const id = seq
    const timer = setTimeout(() => reject(new Error('timeout: ' + name)), 120000)
    replies.set(id, (msg) => { clearTimeout(timer); resolve(msg.result) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n')
  })
}

function report(label, result) {
  const text = result && result.content && result.content[0] ? result.content[0].text : ''
  const short = text.length > 400 ? text.slice(0, 400) + '…' : text
  process.stdout.write('\n--- ' + label + ' (isError=' + !!(result && result.isError) + ') ---\n' + short + '\n')
  return result
}

try {
  await call('hdc_list_targets', {}).then((r) => report('hdc_list_targets', r))

  const shell = await call('hdc_shell', { command: 'param get const.ohos.apiversion' })
  report('hdc_shell (plain)', shell)

  const shellQuote = await call('hdc_shell', { command: "echo 'quoted string with spaces'" })
  report('hdc_shell (apostrophe -> base64 path)', shellQuote)

  const dump = await call('hdc_ui_dump', {})
  report('hdc_ui_dump', dump)

  const find = await call('hdc_ui_find', { text: '设置' })
  report('hdc_ui_find', find)

  const shot = await call('hdc_screenshot', {})
  if (shot && shot.content && shot.content[0] && shot.content[0].type === 'image') {
    process.stdout.write('\n--- hdc_screenshot ---\nimage block: mimeType=' + shot.content[0].mimeType + ' base64chars=' + shot.content[0].data.length + '\n')
    process.stdout.write(String(shot.content[1] ? shot.content[1].text : '').slice(0, 400) + '\n')
  } else {
    report('hdc_screenshot (NO IMAGE BLOCK)', shot)
  }

  const hilog = await call('hdc_hilog', { lines: 5 })
  report('hdc_hilog', hilog)

  const diag = await call('hdc_diag', {})
  report('hdc_diag', diag)
} catch (e) {
  process.stdout.write('\nFAILED: ' + String((e && e.stack) || e) + '\n')
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
}
