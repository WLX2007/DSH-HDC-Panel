// Device-layer tools (16 hdc_* tools) for the standalone MCP server.
//
// Ported from the DSH plugin's lib/host.js. Differences from the plugin:
//   - no sandbox policy object anywhere
//   - hdc is spawned with an argv array, so no host-shell quoting is applied
//     to hdc arguments (the plugin had to reconcile PowerShell and POSIX
//     quoting rules for the same call)
//   - hdc_screenshot returns the JPEG as an MCP image content block, because
//     the plugin relied on the host's read_image tool which does not exist
//     outside DSH

import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { codeHint } from '../core/errors.mjs'
import { createDeviceServices } from '../core/device-services.mjs'
import { APOS, BACKSLASH } from '../core/quoting.mjs'
import { ensureDir, getProjectRoot, screenshotsDir } from '../core/state.mjs'

const tailText = (text, max) => (text.length <= max ? text : text.slice(text.length - max))

export function buildDeviceTools(rt) {
  const { ensureHdc, runHdc, listTargets, currentTarget, hdcPathRef, hdcErrorRef, diagLogRef, candidateList, getPreferred, setPreferred } = rt
  const services = createDeviceServices(rt)

  let shotCounter = 0

  function layoutDir() {
    return join(getProjectRoot(), '.dsh-hdc-mcp')
  }

  async function cleanupShots(dir) {
    try {
      const names = readdirSync(dir)
        .filter((n) => n.startsWith('dsh-shot-'))
        .map((n) => {
          try { return { name: n, mtime: statSync(join(dir, n)).mtimeMs } } catch { return { name: n, mtime: 0 } }
        })
        .sort((a, b) => b.mtime - a.mtime)
      for (const stale of names.slice(10)) {
        try { unlinkSync(join(dir, stale.name)) } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  async function screenshot(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    shotCounter += 1
    const remote = '/data/local/tmp/dsh_mcp_shot_' + shotCounter + '.jpeg'
    const cap = await runHdc(['shell', 'snapshot_display -f ' + remote], { target: cur.target, timeoutMs: 20000 })
    const capText = (cap.stdout + '\n' + cap.stderr)
    const capLooksFailed = /error|invalid|fail/i.test(capText) && !/success/i.test(capText)
    if (!cap.ok || capLooksFailed) {
      return { ok: false, stage: 'capture', error: cap.stderr || cap.stdout || 'snapshot_display failed', remote }
    }
    const dir = typeof args.localPath === 'string' && args.localPath
      ? args.localPath.replace(/[\\/]+$/, '')
      : screenshotsDir()
    ensureDir(dir)
    const safeTarget = String(cur.target).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)
    const local = join(dir, 'dsh-shot-' + shotCounter + '-' + safeTarget + '.jpeg')
    const recv = await runHdc(['file', 'recv', remote, local], { target: cur.target, timeoutMs: 30000 })
    if (!recv.ok) return { ok: false, stage: 'recv', error: recv.stderr || recv.stdout || 'file recv failed', remote }
    if (!existsSync(local)) {
      return { ok: false, stage: 'recv-verify', error: 'file recv reported success but the local file is missing', remote, local }
    }
    await cleanupShots(dir)
    // Return the JPEG inline: an MCP client without a read_image tool can
    // still see the screen.
    let image = null
    try {
      const data = readFileSync(local)
      image = { data: data.toString('base64'), mimeType: 'image/jpeg', bytes: data.length }
    } catch (e) {
      return { ok: false, stage: 'read', error: 'screenshot file could not be read: ' + String((e && e.message) || e), local }
    }
    return {
      ok: true,
      path: local,
      target: cur.target,
      bytes: image.bytes,
      mimeType: 'image/jpeg',
      hint: 'The screenshot is returned inline as an image block; `path` points at the local JPEG copy.',
      image: { data: image.data, mimeType: 'image/jpeg' },
    }
  }

  function errorHint(text) {
    return services.errorHint(text)
  }

  const install = (args) => services.install(args)

  async function deviceShell(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const command = String(args.command || '').trim()
    if (!command) return { ok: false, error: 'command is required' }
    if (command.length > 1000) return { ok: false, error: 'command too long (max 1000 chars)' }
    // hdc 3.2.x performs another device-side parse of the shell argument, so a
    // command carrying an apostrophe can end the quoted string early and fail
    // with "no closing quote". Encode only apostrophe-bearing commands so
    // their bytes cross the boundary without another quoting layer; HarmonyOS
    // images ship /bin/base64.
    //   P0: the encoded payload is passed UNQUOTED — hdc is spawned with an
    // argv array, so there is no host-shell quoting layer left.
    //   P1: escape apostrophes BEFORE base64 so the decoded script the device
    // sh re-parses is itself valid shell text.
    const encoded = command.includes(APOS)
      ? 'echo ' + Buffer.from(command.replace(/'/g, BACKSLASH + APOS), 'utf8').toString('base64') + ' | base64 -d | sh'
      : command
    let r = await runHdc(['shell', encoded], { target: cur.target, timeoutMs: args.timeoutMs || 30000, stdoutMaxBytes: 262144 })
    if (!r.ok && encoded !== command && /base64[^\r\n]*(?:not found|inaccessible)|not found[^\r\n]*base64/i.test((r.stderr || '') + (r.stdout || ''))) {
      r = await runHdc(['shell', command], { target: cur.target, timeoutMs: args.timeoutMs || 30000, stdoutMaxBytes: 262144 })
    }
    return { ok: r.ok, exitCode: r.exitCode, stdout: tailText(r.stdout, 4000), stderr: tailText(r.stderr, 2000), timedOut: r.timedOut }
  }

  async function connect(args) {
    args = args || {}
    const address = String(args.address || '').trim()
    if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][\w.-]*):\d{1,5}$/.test(address)) {
      return { ok: false, error: 'invalid address; expected host:port such as 127.0.0.1:5555 or [::1]:5555' }
    }
    const r = await runHdc(['tconn', address], { timeoutMs: 15000 })
    const out = (r.stdout + '\n' + r.stderr).trim()
    const repeat = /repeat operation|already connected|is connected/i.test(out)
    const ok = repeat
      ? !/failed to connect|cannot connect|not connected/i.test(out)
      : (r.ok && !/fail|error/i.test(out) && (/connect ok/i.test(out) || out === ''))
    return {
      ok,
      stdout: r.stdout,
      stderr: r.stderr,
      hint: ok
        ? (repeat ? 'Target was already connected; call hdc_list_targets to confirm.' : 'Connected. Call hdc_list_targets to confirm.')
        : 'Connection failed; check the address and that the emulator is running.',
    }
  }

  async function fport(args) {
    args = args || {}
    const action = String(args.action || '').trim()
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    if (action === 'list') {
      const r = await runHdc(['fport', 'ls'], { target: cur.target, timeoutMs: 15000 })
      return { ok: r.ok, stdout: tailText(r.stdout, 4000), stderr: tailText(r.stderr, 1000) }
    }
    const localPort = Number(args.localPort)
    const remotePort = Number(args.remotePort)
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      return { ok: false, error: 'localPort and remotePort must be integers in 1-65535' }
    }
    if (action === 'add') {
      const r = await runHdc(['fport', 'tcp:' + localPort, 'tcp:' + remotePort], { target: cur.target, timeoutMs: 15000 })
      const out = (r.stdout + '\n' + r.stderr).trim()
      const ok = r.ok && !/fail|error/i.test(out)
      return { ok, stdout: tailText(r.stdout, 2000), stderr: tailText(r.stderr, 1000), hint: ok ? 'Forwarding tcp:' + localPort + ' -> tcp:' + remotePort + '. Use hdc_fport action=list to confirm.' : 'fport add failed; the local port may already be in use.' }
    }
    if (action === 'remove') {
      const r = await runHdc(['fport', 'rm', 'tcp:' + localPort, 'tcp:' + remotePort], { target: cur.target, timeoutMs: 15000 })
      const out = (r.stdout + '\n' + r.stderr).trim()
      const ok = r.ok && !/fail|error/i.test(out)
      return { ok, stdout: tailText(r.stdout, 2000), stderr: tailText(r.stderr, 1000), hint: ok ? '' : 'fport rm failed; check the exact rule with hdc_fport action=list.' }
    }
    return { ok: false, error: 'action must be one of: add, remove, list' }
  }

  async function fileTransfer(args) {
    args = args || {}
    const action = String(args.action || '').trim()
    if (action !== 'send' && action !== 'recv') return { ok: false, error: 'action must be send or recv' }
    const local = String(args.local || '').trim()
    const remote = String(args.remote || '').trim()
    if (!local || !remote) return { ok: false, error: 'local and remote paths are required' }
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const localArg = process.platform === 'win32' ? local.replace(/\//g, '\\') : local
    const r = await runHdc(['file', action, localArg, remote], { target: cur.target, timeoutMs: 120000, stdoutMaxBytes: 65536 })
    const out = (r.stdout + '\n' + r.stderr).trim()
    const ok = r.ok && !/fail|error/i.test(out)
    return { ok, exitCode: r.exitCode, stdout: tailText(r.stdout, 2000), stderr: tailText(r.stderr, 2000), hint: ok ? '' : 'Transfer failed; check that the local path exists and the remote path is writable (use hdc_shell ls to inspect the device side).' }
  }

  async function targetMgmt(args) {
    args = args || {}
    const action = String(args.action || '').trim()
    if (action === 'disconnect') {
      const address = String(args.address || '').trim()
      if (address && !/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][\w.-]*):\d{1,5}$/.test(address)) return { ok: false, error: 'invalid address; expected host:port' }
      const argv = ['tdisconn']
      if (address) argv.push(address)
      const r = await runHdc(argv, { timeoutMs: 15000 })
      const out = (r.stdout + '\n' + r.stderr).trim()
      return { ok: r.ok && !/fail|error/i.test(out), stdout: r.stdout, stderr: r.stderr, hint: 'Call hdc_list_targets to confirm.' }
    }
    if (action === 'reboot') {
      const cur = await currentTarget(args.target)
      if (cur.error) return { ok: false, error: cur.error }
      const r = await runHdc(['shell', 'reboot'], { target: cur.target, timeoutMs: 15000 })
      return { ok: r.ok, target: cur.target, stdout: tailText(r.stdout, 1000), stderr: tailText(r.stderr, 1000), hint: r.ok ? 'Reboot issued; wait for the device to come back, then hdc_list_targets.' : '' }
    }
    if (action === 'mode') {
      const mode = String(args.mode || '').trim().toLowerCase()
      if (mode !== 'usb' && mode !== 'tcp') return { ok: false, error: 'mode must be usb or tcp' }
      const r = await runHdc(['tmode', mode], { timeoutMs: 15000 })
      const out = (r.stdout + '\n' + r.stderr).trim()
      return { ok: r.ok && !/fail|error/i.test(out), stdout: r.stdout, stderr: r.stderr, hint: mode === 'tcp' ? 'Device listens on TCP now; connect with hdc_connect <ip>:<port>.' : 'Device switched to USB mode.' }
    }
    return { ok: false, error: 'action must be one of: disconnect, reboot, mode' }
  }

  async function hilog(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const lines = Math.min(Math.max(Number(args.lines) || 300, 10), 1000)
    const argv = ['shell', 'hilog', '-x']
    if (typeof args.tag === 'string' && args.tag.trim()) argv.push('-T', String(args.tag).trim().slice(0, 64))
    if (typeof args.domain === 'string' && args.domain.trim()) argv.push('-D', String(args.domain).trim().slice(0, 64))
    if (typeof args.level === 'string' && args.level.trim()) {
      const level = String(args.level).trim().toUpperCase()
      if (!['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(level)) return { ok: false, error: 'invalid level: ' + args.level + ' (expected DEBUG/INFO/WARN/ERROR/FATAL)' }
      argv.push('-L', level)
    }
    if (args.pid !== undefined && args.pid !== null && Number.isFinite(Number(args.pid))) argv.push('-P', String(Number(args.pid)))
    if (typeof args.regex === 'string' && args.regex.trim()) argv.push('-e', String(args.regex).trim().slice(0, 256))
    const r = await runHdc(argv, { target: cur.target, timeoutMs: 30000, stdoutMaxBytes: 524288 })
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'hilog failed', stdout: tailText(r.stdout, 2000) }
    const all = r.stdout.split(/\r?\n/).filter((l) => l.trim())
    const picked = all.slice(-lines)
    return { ok: true, lineCount: picked.length, totalCollected: all.length, truncated: r.stdoutTruncated, lines: picked }
  }

  // Text-mode "screenshot": dump the UI hierarchy and return the visible text
  // nodes, so text-only models can inspect a screen without an image.
  async function dumpLayoutDoc(args) {
    const cur = await currentTarget(args.target)
    if (cur.error) return { error: cur.error }
    const dump = await runHdc(['shell', 'uitest dumpLayout'], { target: cur.target, timeoutMs: 30000, stdoutMaxBytes: 65536 })
    const dumpText = (dump.stdout + '\n' + dump.stderr)
    const saved = /saved to:?\s*(\S+\.json)/i.exec(dumpText)
    if (!dump.ok || !saved) return { error: dump.stderr || dump.stdout || 'uitest dumpLayout failed' }
    const remote = String(saved[1]).trim()
    const dir = layoutDir()
    ensureDir(dir)
    const local = join(dir, 'layout-' + (shotCounter++) + '.json')
    const recv = await runHdc(['file', 'recv', remote, local], { target: cur.target, timeoutMs: 30000 })
    if (!recv.ok) return { error: recv.stderr || recv.stdout || 'file recv failed' }
    let raw = ''
    try { raw = readFileSync(local, 'utf8') } catch { raw = '' }
    if (!raw) return { ok: true, layoutPath: local, note: 'layout file pulled but could not be read for text extraction' }
    let doc
    try {
      doc = JSON.parse(raw)
    } catch (e) {
      return { error: 'layout json parse failed: ' + String((e && e.message) || e), layoutPath: local }
    }
    return { ok: true, doc, layoutPath: local }
  }

  async function uiDump(args) {
    args = args || {}
    const res = await dumpLayoutDoc(args)
    if (!res.ok) return { ok: false, error: res.error }
    const doc = res.doc
    const texts = []
    let nodeCount = 0
    function walk(node) {
      if (!node || typeof node !== 'object') return
      nodeCount += 1
      const a = node.attributes
      if (a && typeof a === 'object') {
        if (typeof a.text === 'string' && a.text.trim()) texts.push(a.text)
        else if (typeof a.originalText === 'string' && a.originalText.trim()) texts.push(a.originalText)
        if (typeof a.hint === 'string' && a.hint.trim()) texts.push('[hint] ' + a.hint)
      }
      const kids = node.children
      if (Array.isArray(kids)) for (const k of kids) walk(k)
    }
    if (Array.isArray(doc)) for (const d of doc) walk(d)
    else walk(doc)
    return { ok: true, layoutPath: res.layoutPath, nodeCount, textCount: texts.length, texts: texts.slice(0, 200) }
  }

  async function uiFind(args) {
    args = args || {}
    const query = String(args.text || '').trim()
    if (!query) return { ok: false, error: 'text is required (the text or hint to search for)' }
    const res = await dumpLayoutDoc(args)
    if (!res.ok) return { ok: false, error: res.error }
    const exact = args.exact === true
    const matches = []
    function walk(node) {
      if (!node || typeof node !== 'object') return
      const a = node.attributes
      if (a && typeof a === 'object') {
        const text = typeof a.text === 'string' ? a.text : ''
        const hint = typeof a.hint === 'string' ? a.hint : ''
        const orig = typeof a.originalText === 'string' ? a.originalText : ''
        const hay = [text, orig, hint].filter(Boolean).join('\n')
        const hit = exact ? (text === query || hint === query) : hay.toLowerCase().includes(query.toLowerCase())
        if (hit) {
          const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '')
          matches.push({
            text: orig || text || hint,
            hint,
            bounds: a.bounds || '',
            center: bm ? { x: Math.round((+bm[1] + +bm[3]) / 2), y: Math.round((+bm[2] + +bm[4]) / 2) } : null,
          })
        }
      }
      const kids = node.children
      if (Array.isArray(kids)) for (const k of kids) walk(k)
    }
    if (Array.isArray(res.doc)) for (const d of res.doc) walk(d)
    else walk(res.doc)
    return {
      ok: true,
      query,
      exact,
      matched: matches.length,
      matches: matches.slice(0, 20),
      layoutPath: res.layoutPath,
      hint: matches.length ? 'Use the first match center with hdc_ui action=tap.' : 'No matching control; try a shorter or different text.',
    }
  }

  function coordOk(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100000
  }

  async function uiAction(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const action = String(args.action || '')
    const argv = ['shell', 'uitest', 'uiInput']
    switch (action) {
      case 'tap':
        if (!coordOk(args.x) || !coordOk(args.y)) return { ok: false, error: 'tap requires integer x and y coordinates' }
        argv.push('click', String(args.x), String(args.y))
        break
      case 'doubleTap':
        if (!coordOk(args.x) || !coordOk(args.y)) return { ok: false, error: 'doubleTap requires integer x and y coordinates' }
        argv.push('doubleClick', String(args.x), String(args.y))
        break
      case 'longPress':
        if (!coordOk(args.x) || !coordOk(args.y)) return { ok: false, error: 'longPress requires integer x and y coordinates' }
        argv.push('longClick', String(args.x), String(args.y))
        break
      case 'swipe':
        if (!coordOk(args.fromX) || !coordOk(args.fromY) || !coordOk(args.toX) || !coordOk(args.toY)) return { ok: false, error: 'swipe requires integer fromX/fromY/toX/toY coordinates' }
        argv.push('swipe', String(args.fromX), String(args.fromY), String(args.toX), String(args.toY))
        if (typeof args.velocity === 'number' && Number.isInteger(args.velocity) && args.velocity >= 200 && args.velocity <= 40000) argv.push(String(args.velocity))
        break
      case 'input': {
        if (typeof args.text !== 'string' || !args.text) return { ok: false, error: 'input requires a text value' }
        const text = args.text.replace(/[\r\n\t]/g, ' ').slice(0, 200)
        if (coordOk(args.x) && coordOk(args.y)) argv.push('inputText', String(args.x), String(args.y), text)
        else argv.push('text', text)
        break
      }
      case 'key':
        if (typeof args.key !== 'string' || !/^(Back|Home|Power|\d{1,6})$/.test(args.key)) return { ok: false, error: 'key must be Back, Home, Power, or a numeric keyID' }
        argv.push('keyEvent', args.key)
        break
      default:
        return { ok: false, error: 'action must be one of: tap, doubleTap, longPress, swipe, input, key' }
    }
    const r = await runHdc(argv, { target: cur.target, timeoutMs: 30000, stdoutMaxBytes: 65536 })
    const text = (r.stdout + '\n' + r.stderr).trim()
    // uitest prints "No Error" on success; only colon-style errors, usage text,
    // and Fail markers count as failures.
    const looksFailed = /error:|incorrect|invalid|\[fail\]/i.test(text) && !/^no error/i.test(text)
    const ok = r.ok && !looksFailed
    return {
      ok,
      action,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      hint: ok ? 'Action applied. Run hdc_ui_dump or hdc_screenshot to verify the new UI state.' : '',
    }
  }

  async function crashFetch(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const kind = String(args.kind || 'all')
    if (!/^(all|jscrash|cppcrash|appfreeze)$/.test(kind)) return { ok: false, error: 'kind must be all, jscrash, cppcrash, or appfreeze' }
    const lines = Math.min(Math.max(Number(args.lines) || 60, 10), 200)
    const bundleFilter = typeof args.bundleName === 'string' ? args.bundleName.trim().toLowerCase() : ''
    const dir = '/data/log/faultlog/faultlogger/'
    const list = await runHdc(['shell', 'ls -t ' + dir + ' 2>/dev/null | head -n 60'], { target: cur.target, timeoutMs: 30000, stdoutMaxBytes: 32768 })
    if (!list.ok) return { ok: false, error: list.stderr || list.stdout || 'failed to list faultlog directory' }
    let names = list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (kind !== 'all') names = names.filter((n) => n.toLowerCase().startsWith(kind + '-'))
    if (bundleFilter) names = names.filter((n) => n.toLowerCase().includes(bundleFilter))
    if (names.length === 0) return { ok: true, files: [], note: 'No crash logs found (a clean state is a valid result).', kind, bundleFilter }
    const latest = names[0]
    const read = await runHdc(['shell', 'tail -n ' + lines + ' ' + dir + latest], { target: cur.target, timeoutMs: 30000, stdoutMaxBytes: 262144 })
    if (!read.ok) return { ok: false, error: read.stderr || read.stdout || 'failed to read ' + latest }
    const content = tailText(read.stdout, 12000)
    const summary = {}
    const nameMatch = /Error (?:name|type)\s*:\s*(\S+)/i.exec(content)
    const msgMatch = /Error message\s*:\s*([^\r\n]+)/i.exec(content)
    const codeMatch = /Error code\s*:\s*(\d+)/i.exec(content) || /code[:=]\s*(\d{4,})/i.exec(content)
    if (nameMatch) summary.errorName = nameMatch[1].replace(/[,.;]+$/, '')
    if (msgMatch) summary.errorMessage = msgMatch[1].trim()
    if (codeMatch) {
      summary.errorCode = codeMatch[1]
      if (codeHint(codeMatch[1])) summary.codeHint = codeHint(codeMatch[1])
    }
    const frameMatches = content.match(/entry\/src[^\s]*\.ets:\d+:\d+/g) || []
    const frames = []
    for (const f of frameMatches) { if (!frames.includes(f)) frames.push(f) }
    if (frames.length) summary.frames = frames.slice(0, 8)
    return { ok: true, kind, bundleFilter, totalMatched: names.length, latest, summary, content }
  }

  const TARGET_DESC = 'Optional target device id; defaults to the device last used in this server (falls back to the first connected device)'

  return [
    {
      name: 'hdc_list_targets',
      description: 'List connected HarmonyOS devices/emulators via hdc (HarmonyOS Device Connector). Returns an empty list when nothing is connected, with a hint on how to connect.',
      inputSchema: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: 'Include verbose output (defaults to false; parsing is identical)' },
        },
        required: [],
      },
      async execute() {
        await ensureHdc()
        const r = await listTargets()
        return {
          ok: r.ok,
          targets: r.targets,
          preferred: getPreferred(),
          preferredActive: !!(getPreferred() && r.targets.some((t) => t.id === getPreferred() && /connected/i.test(t.state))),
          error: r.error,
          hint: r.targets.length === 0 ? 'No devices. Use hdc_connect 127.0.0.1:5555 for an emulator, or start one in DevEco Studio.' : '',
        }
      },
    },
    {
      name: 'hdc_connect',
      description: 'Connect a HarmonyOS device/emulator over TCP via hdc tconn (e.g. 127.0.0.1:5555 for a local emulator, or a LAN device address).',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'IP address and port, e.g. 127.0.0.1:5555' },
        },
        required: ['address'],
      },
      async execute(args) { await ensureHdc(); return connect(args) },
    },
    {
      name: 'hdc_fport',
      description: 'Manage TCP port forwarding over hdc fport: add (local tcp:port -> device tcp:port), remove, or list current rules. Useful for reaching device-side debug/automation ports from the host.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: add, remove, list' },
          localPort: { type: 'integer', description: 'Local listening port, 1-65535 (add/remove)' },
          remotePort: { type: 'integer', description: 'Device-side target port, 1-65535 (add/remove)' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: ['action'],
      },
      async execute(args) { await ensureHdc(); return fport(args) },
    },
    {
      name: 'hdc_file',
      description: 'Transfer files between the host and a connected HarmonyOS device/emulator via hdc file send/recv. send: push a local file/directory to the device; recv: pull a device file/directory to the host. Combine with hdc_shell ls to inspect the device side.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'send (host -> device) or recv (device -> host)' },
          local: { type: 'string', description: 'Local path: source for send, destination for recv' },
          remote: { type: 'string', description: 'Device path: destination for send, source for recv' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: ['action', 'local', 'remote'],
      },
      async execute(args) { await ensureHdc(); return fileTransfer(args) },
    },
    {
      name: 'hdc_target',
      description: 'Target management: disconnect a TCP device (tdisconn; omit address to disconnect all), reboot the device, or switch the connection mode (tmode usb/tcp). Destructive actions (reboot, mode) are marked; verify with hdc_list_targets afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: disconnect, reboot, mode' },
          address: { type: 'string', description: 'host:port for disconnect (omit to disconnect every TCP target)' },
          mode: { type: 'string', description: 'usb or tcp, for action=mode' },
          target: { type: 'string', description: 'Optional target device id for reboot; defaults to the device last used in this server' },
        },
        required: ['action'],
      },
      async execute(args) { await ensureHdc(); return targetMgmt(args) },
    },
    {
      name: 'hdc_shell',
      description: 'Run a shell command on a connected HarmonyOS device/emulator (hdc shell). Use for device inspection: param get, ps, cat /proc, uitest dumpLayout, etc. The command is delivered byte-for-byte to the device shell (apostrophes are escaped automatically); other sh metacharacters keep their normal meaning.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run on the device shell' },
          target: { type: 'string', description: TARGET_DESC },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 30000)' },
        },
        required: ['command'],
      },
      async execute(args) { await ensureHdc(); return deviceShell(args) },
    },
    {
      name: 'hdc_screenshot',
      description: 'Capture a screenshot of the connected HarmonyOS device/emulator, pull it to the local project as a JPEG and return it inline as an image block together with the local path.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: TARGET_DESC },
          localPath: { type: 'string', description: 'Optional local directory override; defaults to <project>/.dsh-hdc-mcp/screenshots' },
        },
        required: [],
      },
      async execute(args) { await ensureHdc(); return screenshot(args) },
    },
    {
      name: 'hdc_install',
      description: 'Install a built .hap package onto the connected HarmonyOS device/emulator via hdc install (replaces by default). Combine with hdc_screenshot to verify the UI.',
      inputSchema: {
        type: 'object',
        properties: {
          hapPath: { type: 'string', description: 'Absolute or project-relative path to the .hap file' },
          target: { type: 'string', description: TARGET_DESC },
          replace: { type: 'boolean', description: 'Replace the existing installation (default true)' },
        },
        required: ['hapPath'],
      },
      async execute(args) { await ensureHdc(); return install(args) },
    },
    {
      name: 'hdc_hilog',
      description: 'Fetch recent hilog lines from the connected HarmonyOS device/emulator (dumps the buffer, returns the tail). Filters: tag (-T), domain (-D, hex id like 0xD002100 or name), level (-L, DEBUG/INFO/WARN/ERROR/FATAL), pid (-P), regex (-e).',
      inputSchema: {
        type: 'object',
        properties: {
          lines: { type: 'integer', description: 'Number of tail lines to return (default 300, max 1000)' },
          tag: { type: 'string', description: 'Optional hilog domain tag filter (domain NAME such as PARAM, not the hex domain id)' },
          domain: { type: 'string', description: 'Optional hilog domain filter (-D), e.g. 0xD002100' },
          level: { type: 'string', description: 'Optional minimum log level: DEBUG, INFO, WARN, ERROR, or FATAL' },
          pid: { type: 'integer', description: 'Optional process-id filter' },
          regex: { type: 'string', description: 'Optional regular-expression line filter (-e)' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: [],
      },
      async execute(args) { await ensureHdc(); return hilog(args) },
    },
    {
      name: 'hdc_ui_dump',
      description: 'Dump the visible UI hierarchy of the connected HarmonyOS device/emulator as text nodes (a text-mode screenshot for models without image input): runs uitest dumpLayout, pulls the json, and returns the visible text list.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: TARGET_DESC },
        },
        required: [],
      },
      async execute(args) { await ensureHdc(); return uiDump(args) },
    },
    {
      name: 'hdc_ui_find',
      description: 'Find a UI control by its text or hint on the connected device and return its bounds and center coordinates (dump the layout, match text/hint, compute centers). Combine with hdc_ui action=tap to drive the UI without manual coordinate math.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text or hint to search for (substring match, case-insensitive)' },
          exact: { type: 'boolean', description: 'Exact match on the node text/hint instead of substring (default false)' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: ['text'],
      },
      async execute(args) { await ensureHdc(); return uiFind(args) },
    },
    {
      name: 'hdc_ui',
      description: 'Drive the device UI (uitest uiInput): tap/doubleTap/longPress at coordinates, swipe between points, input text (at a focused field, or at x/y), or send a key event (Back/Home/Power or keyID). Combine with hdc_ui_dump to locate elements first, then act, then dump again to verify.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: tap, doubleTap, longPress, swipe, input, key' },
          x: { type: 'integer', description: 'X coordinate for tap/doubleTap/longPress, or input-at-coordinate' },
          y: { type: 'integer', description: 'Y coordinate for tap/doubleTap/longPress, or input-at-coordinate' },
          fromX: { type: 'integer', description: 'Swipe start X' },
          fromY: { type: 'integer', description: 'Swipe start Y' },
          toX: { type: 'integer', description: 'Swipe end X' },
          toY: { type: 'integer', description: 'Swipe end Y' },
          velocity: { type: 'integer', description: 'Swipe velocity 200-40000 (default 600)' },
          text: { type: 'string', description: 'Text to input (max 200 chars)' },
          key: { type: 'string', description: 'Key for the key action: Back, Home, Power, or a numeric keyID' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: ['action'],
      },
      async execute(args) { await ensureHdc(); return uiAction(args) },
    },
    {
      name: 'hdc_app',
      description: 'Manage an installed HarmonyOS app: query bundle info (bm dump), start (aa start, default ability EntryAbility), force-stop, clear data (bm clean -d), or uninstall. Destructive actions are marked in their descriptions; verify with hdc_app query afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: query, start, stop, clear-data, uninstall' },
          bundleName: { type: 'string', description: 'Bundle name, e.g. com.example.app' },
          abilityName: { type: 'string', description: 'Ability name for start (default EntryAbility)' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: ['action', 'bundleName'],
      },
      async execute(args) { await ensureHdc(); return services.appAction(args) },
    },
    {
      name: 'hdc_crash',
      description: 'Fetch recent crash logs from the device faultlogger directory (/data/log/faultlog/faultlogger/): jscrash, cppcrash, or appfreeze, optionally filtered by bundle name. Returns the latest matching log tail.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Crash kind filter: all (default), jscrash, cppcrash, or appfreeze' },
          bundleName: { type: 'string', description: 'Optional bundle-name substring filter' },
          lines: { type: 'integer', description: 'Tail lines to return from the latest log (default 60, max 200)' },
          target: { type: 'string', description: TARGET_DESC },
        },
        required: [],
      },
      async execute(args) { await ensureHdc(); return crashFetch(args) },
    },
    {
      name: 'hdc_diag',
      description: 'Diagnose the local hdc setup: resolved hdc binary path, discovery probes, the current project root and the last probe outcomes. Useful when hdc tools report not-found.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() {
        await ensureHdc()
        const out = {
          hdcPath: hdcPathRef(),
          hdcError: hdcErrorRef(),
          hdcCandidates: candidateList(),
          diagLog: diagLogRef(),
          projectRoot: getProjectRoot(),
        }
        try {
          const r = await rt.probeEcho()
          out.echoProbe = r
        } catch (e) {
          out.echoError = String((e && e.message) || e).slice(0, 300)
        }
        return out
      },
    },
  ]
}
