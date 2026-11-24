// Manual compile-loop acceptance.
//
// Usage: node scripts/compile-check.mjs <projectRoot> [--build]
//
// With --build the script runs a real build_project inside a temporary COPY
// of the project, so the original working tree is never touched.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const projectArg = process.argv[2]
const wantBuild = process.argv.includes('--build')
if (!projectArg) {
  process.stdout.write('usage: node scripts/compile-check.mjs <projectRoot> [--build]\n')
  process.exit(2)
}

let workRoot = projectArg
let tempRoot = ''
if (wantBuild) {
  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-hdc-mcp-build-'))
  const dest = join(tempRoot, 'app')
  cpSync(projectArg, dest, { recursive: true, dereference: false })
  workRoot = dest
  process.stdout.write('building in a temporary copy: ' + dest + '\n')
}

const child = spawn(process.execPath, [join(ROOT, 'bin', 'dsh-hdc-mcp.mjs')], {
  cwd: workRoot,
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
function call(name, args, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    seq += 1
    const id = seq
    const timer = setTimeout(() => reject(new Error('timeout: ' + name)), timeoutMs)
    replies.set(id, (msg) => { clearTimeout(timer); resolve(msg.result) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n')
  })
}

function report(label, result, limit = 1200) {
  const text = result && result.content && result.content[0] ? result.content[0].text : ''
  const short = text.length > limit ? text.slice(0, limit) + '…' : text
  process.stdout.write('\n--- ' + label + ' (isError=' + !!(result && result.isError) + ') ---\n' + short + '\n')
}

try {
  report('switch_cwd', await call('switch_cwd', { project_path: workRoot }))
  report('hms_build status', await call('hms_build', { action: 'status' }))
  report('arkts_check', await call('arkts_check', {}), 2000)
  if (wantBuild) {
    report('build_project', await call('build_project', { clean: false, product: 'default', build_mode: 'debug' }), 3000)
  }
} catch (e) {
  process.stdout.write('\nFAILED: ' + String((e && e.stack) || e) + '\n')
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
