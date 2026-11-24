// Smoke test for the standalone MCP server.
//
// Two levels:
//   1. in-process  — build the tool set, run initialize / tools/list /
//                    tools/call through the protocol handler
//   2. over stdio  — spawn bin/dsh-hdc-mcp.mjs and exchange real JSON-RPC
//                    frames over the pipe
//
// Usage: node scripts/smoke.mjs [--stdio]

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildTools } from '../src/tools/index.mjs'
import { createServer } from '../src/mcp/protocol.mjs'
import { INSTRUCTIONS } from '../src/core/guide.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failures = 0
function check(label, condition, detail) {
  const ok = !!condition
  if (!ok) failures += 1
  const suffix = detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
  process.stdout.write((ok ? 'PASS  ' : 'FAIL  ') + label + suffix + '\n')
}

async function inProcess() {
  process.stdout.write('\n== in-process ==\n')
  const tools = buildTools()
  check('tool set builds', tools.length >= 29, tools.length + ' tools')

  const names = tools.map((t) => t.name)
  const expected = [
    'hdc_list_targets', 'hdc_connect', 'hdc_fport', 'hdc_file', 'hdc_target', 'hdc_shell',
    'hdc_screenshot', 'hdc_install', 'hdc_hilog', 'hdc_ui_dump', 'hdc_ui_find', 'hdc_ui',
    'hdc_app', 'hdc_crash', 'hdc_diag', 'hdc_log',
    'project_create',
    'hms_emulator', 'hms_setup', 'hms_build', 'hms_lint', 'hms_api', 'hms_knowledge',
    'hms_docs', 'hms_api_change',
    'switch_cwd', 'build_project', 'arkts_check', 'start_app',
    'hdc_guide',
  ]
  const missing = expected.filter((n) => !names.includes(n))
  check('all expected tools present', missing.length === 0, missing)

  const badSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object')
  check('every tool has an object inputSchema', badSchema.length === 0, badSchema.map((t) => t.name))

  const server = createServer({ tools, instructions: INSTRUCTIONS, serverInfo: { name: 'dsh-hdc-mcp', version: '1.0.0' } })

  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
  check('initialize returns a result', !!(init && init.result), init && init.result && init.result.protocolVersion)
  check('initialize negotiates the requested protocol version', init.result.protocolVersion === '2025-06-18', init.result.protocolVersion)
  check('initialize advertises the tools capability', !!(init.result.capabilities && init.result.capabilities.tools))
  check('initialize carries instructions', typeof init.result.instructions === 'string' && init.result.instructions.length > 50)

  const old = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  check('initialize falls back for an older protocol version', old.result.protocolVersion === '2024-11-05', old.result.protocolVersion)

  const list = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  check('tools/list returns every tool', list.result.tools.length === tools.length, list.result.tools.length)
  const first = list.result.tools[0]
  check('tools/list entries use inputSchema', !!first.inputSchema && first.inputSchema.type === 'object')

  const notification = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('notifications produce no response', notification === null)

  const unknown = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
  check('an unknown tool is a protocol error', !!(unknown && unknown.error), unknown && unknown.error && unknown.error.code)

  const guide = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hdc_guide', arguments: { action: 'device' } } })
  check('hdc_guide returns the device guide', !!(guide.result && guide.result.content[0].text.includes('device debug loop')))

  const catalog = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hms_knowledge', arguments: { action: 'catalog' } } })
  const catalogText = catalog.result && catalog.result.content[0] ? catalog.result.content[0].text : ''
  check('hms_knowledge catalog reads the bundled knowledge', catalogText.includes('"ok": true'), catalogText.slice(0, 120))

  const apiModules = await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hms_api', arguments: { action: 'modules' } } })
  const apiText = apiModules.result && apiModules.result.content[0] ? apiModules.result.content[0].text : ''
  // The SDK may or may not be installed on the test machine: either a module
  // list or a structured "not found" error is a correct answer.
  check('hms_api modules answers', apiText.includes('"ok": true') || apiText.includes('"ok": false'), apiText.slice(0, 120))
}

async function overStdio() {
  process.stdout.write('\n== over stdio ==\n')
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'dsh-hdc-mcp.mjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const replies = new Map()
  const stdoutLines = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        stdoutLines.push(line)
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && replies.has(msg.id)) {
            replies.get(msg.id)(msg)
            replies.delete(msg.id)
          }
        } catch { /* not a frame we understand */ }
      }
      index = buffer.indexOf('\n')
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })

  function request(message, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(message.id); reject(new Error('timeout waiting for ' + message.method)) }, timeoutMs)
      replies.set(message.id, (msg) => { clearTimeout(timer); resolve(msg) })
      child.stdin.write(JSON.stringify(message) + '\n')
    })
  }

  try {
    const init = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
    check('stdio: initialize answers', !!(init && init.result), init && init.result && init.result.serverInfo)

    const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    check('stdio: tools/list answers', !!(list && list.result && list.result.tools.length >= 29), list && list.result && list.result.tools.length)

    const call = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hdc_list_targets', arguments: {} } })
    check('stdio: tools/call answers', !!(call && call.result && Array.isArray(call.result.content)), call && call.result && call.result.content && call.result.content[0].text.slice(0, 160))

    // stdout must carry nothing but JSON-RPC frames: a stray console.log would
// corrupt the client's parser.
    const badFrames = stdoutLines.filter((line) => {
      try {
        const msg = JSON.parse(line)
        return !msg || msg.jsonrpc !== '2.0'
      } catch {
        return true
      }
    })
    check('stdio: stdout carries only JSON-RPC frames', badFrames.length === 0, badFrames.slice(0, 3))
    check('stdio: diagnostics go to stderr', stderr.includes('ready:'), stderr.slice(0, 160))
  } finally {
    child.stdin.end()
    child.kill()
  }
}

try {
  await inProcess()
  await overStdio()
} catch (e) {
  failures += 1
  process.stdout.write('FAIL  smoke run threw: ' + String((e && e.stack) || e) + '\n')
}

process.stdout.write('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + '\n')
process.exit(failures === 0 ? 0 : 1)
