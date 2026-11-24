// Manual toolchain acceptance: exercises the hms_* layer (doctor, API
// knowledge, official knowledge service) against the local DevEco install.
//
// Usage: node scripts/toolchain-check.mjs

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
function call(name, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    seq += 1
    const id = seq
    const timer = setTimeout(() => reject(new Error('timeout: ' + name)), timeoutMs)
    replies.set(id, (msg) => { clearTimeout(timer); resolve(msg.result) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n')
  })
}

function report(label, result, limit = 900) {
  const text = result && result.content && result.content[0] ? result.content[0].text : ''
  const short = text.length > limit ? text.slice(0, limit) + '…' : text
  process.stdout.write('\n--- ' + label + ' (isError=' + !!(result && result.isError) + ') ---\n' + short + '\n')
}

try {
  report('hms_setup doctor', await call('hms_setup', { action: 'doctor' }))
  report('hms_api lookup @ohos.promptAction showToast', await call('hms_api', { action: 'lookup', module: '@ohos.promptAction', name: 'showToast', targetApi: 20 }))
  report('hms_knowledge search (hilog)', await call('hms_knowledge', { action: 'search', keywords: 'hilog 日志', limit: 3 }))
  report('hms_knowledge official-search', await call('hms_knowledge', { action: 'official-search', query: 'UIAbility 生命周期', topK: 3 }), 600)
  report('hms_lint rules', await call('hms_lint', { action: 'rules', limit: 3 }), 700)
  report('hdc_app query (a known bundle)', await call('hdc_app', { action: 'query', bundleName: 'com.huawei.hmsapp.appgallery' }), 500)
} catch (e) {
  process.stdout.write('\nFAILED: ' + String((e && e.stack) || e) + '\n')
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
}
