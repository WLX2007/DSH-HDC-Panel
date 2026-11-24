// Shared runtime for the MCP tool layer: hdc core, DevEco toolchain
// discovery, the optional devecocli backend, and the small helpers every
// tool group needs.
//
// Everything here is process-scoped. There is no session, no sandbox policy
// and no host shell seam: the server owns the child processes directly.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as sdkDts from './sdk-dts.mjs'
import * as studio from './studio.mjs'
import * as devcli from './devecocli.mjs'
import * as cltModule from './clt.mjs'
import { createHdcCore } from './hdc.mjs'
import { buildOk } from './build-signals.mjs'
import { runProcess, runShellRaw } from './shell.mjs'
import { SHELL_FLAVOR, psQuote, quote } from './quoting.mjs'
import { getProjectRoot } from './state.mjs'

const log = (message) => {
  try { process.stderr.write('[dsh-hdc-mcp] ' + message + '\n') } catch { /* stderr closed */ }
}

const tailText = (text, max) => (text.length <= max ? text : text.slice(text.length - max))

// ---------------------------------------------------------------------------
// toolchain path helpers
// ---------------------------------------------------------------------------

// Node runtime of a DevEco Studio install (<root>/tools/node[/bin]) and of a
// standalone Command Line Tools distribution (<root>/node[/bin]).
export function studioNodeBin(root) {
  const win = join(root, 'tools', 'node', 'node.exe')
  if (existsSync(win)) return win
  const posix = join(root, 'tools', 'node', 'bin', 'node')
  return existsSync(posix) ? posix : ''
}

export function cltNodeBin(root) {
  const win = join(root, 'node', 'node.exe')
  if (existsSync(win)) return win
  const posix = join(root, 'node', 'bin', 'node')
  return existsSync(posix) ? posix : ''
}

// arkts_check picks its own runtime: Studio first, then a standalone Command
// Line Tools install.
export function arktsRuntimeFrom(studioRoot, cltRoot) {
  if (studioRoot) {
    const node = studioNodeBin(studioRoot)
    if (node) return { root: studioRoot, node }
  }
  if (cltRoot) {
    const node = cltNodeBin(cltRoot)
    if (node) return { root: cltRoot, node }
  }
  return { root: '', node: '' }
}

// Command head for the hvigorw launcher. A CLT without bin/ ships
// hvigor/bin/hvigorw.js as plain JavaScript with no shebang, so a `js` entry
// must run under a node runtime — the toolchain's own when present.
export function hvigorCommandHead(hvigor, node, flavor = SHELL_FLAVOR) {
  const q = (value) => (flavor === 'pwsh' ? psQuote(value) : quote(value))
  if (!hvigor || hvigor.kind !== 'js') return q((hvigor && hvigor.path) || '')
  return q(node || 'node') + ' ' + q(hvigor.path)
}

export function studioJavaHome(root) {
  const candidates = [join(root, 'jbr'), join(root, 'jre'), join(root, 'tools', 'jbr')]
  for (const home of candidates) {
    if (existsSync(join(home, 'bin', 'java.exe')) || existsSync(join(home, 'bin', 'java'))) return home
  }
  return ''
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

export function createRuntime() {
  const hdcCore = createHdcCore({
    runArgv: (file, argv, opts) => runProcess(file, argv, opts),
    runShell: (command, opts) => runShellRaw(command, opts && opts.timeoutMs, opts && opts.stdoutMaxBytes, opts && opts.cwd),
    extraRoots: () => {
      const roots = []
      const st = getStudio()
      if (st.ok) roots.push(join(st.root, 'sdk'))
      const clt = getClt()
      if (clt.ok) roots.push(cltModule.cltSdkRoot(clt.root))
      return roots
    },
    log,
  })

  const {
    ensureHdc, runHdc, listTargets, pickTarget, currentTarget,
    hdcPathRef, hdcErrorRef, diagLogRef, candidateList, getPreferred, setPreferred,
  } = hdcCore

  // --- DevEco Studio / CLT / SDK discovery (cached) ------------------------

  let studioCache
  let studioCacheKey = ''
  function getStudio(overrides = {}) {
    const key = String((overrides && overrides.devecoPath) || '')
    if (studioCache && studioCacheKey === key) return studioCache
    const found = studio.findStudioRoot(key ? [key] : [])
    if (found.ok) found.version = studio.studioVersion(found.root)
    if (!key) { studioCache = found; studioCacheKey = key }
    return found
  }

  let cltCache
  function getClt() {
    if (cltCache) return cltCache
    cltCache = cltModule.findCltRoot([])
    if (cltCache.ok) {
      cltCache.kind = 'clt'
      const generation = cltCache.version || (cltCache.apiVersion ? 'api ' + cltCache.apiVersion : 'unknown generation')
      log('command-line-tools ' + generation + ' (' + cltCache.layout + ') at ' + cltCache.root)
    }
    return cltCache
  }

  function cltIsExplicit() {
    return !!(typeof process !== 'undefined' && process.env && process.env.DEVECO_CLI_CLT_PATH)
  }

  let sdkCache
  let sdkCacheKey = ''
  function getSdk(overrides = {}) {
    const key = [String((overrides && overrides.devecoPath) || ''), String((overrides && overrides.sdkPath) || '')].join('|')
    if (sdkCache && sdkCacheKey === key) return sdkCache
    const extra = []
    if (overrides && overrides.sdkPath) extra.push(overrides.sdkPath)
    const clt = getClt()
    if (!(overrides && overrides.sdkPath) && clt.ok && cltIsExplicit()) extra.push(cltModule.cltSdkRoot(clt.root))
    const st = getStudio(overrides)
    if (st.ok) extra.push(st.root)
    if (clt.ok && !cltIsExplicit()) extra.push(cltModule.cltSdkRoot(clt.root))
    const found = sdkDts.findSdkInfo(extra)
    if (!key) { sdkCache = found; sdkCacheKey = key }
    return found
  }

  function versionAtLeast(v, major, minor) {
    const m = /^(\d+)\.(\d+)/.exec(String(v || ''))
    if (!m) return false
    return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor)
  }

  function versionGte(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x > y
    }
    return true
  }

  // Feature gates that historically keyed off "Studio >= x.y" also accept the
  // Command Line Tools generation (CLT minimum is 26.0.0 per deveco-cli).
  function featureGate(minMajor, minMinor) {
    const st = getStudio()
    if (st.ok && versionAtLeast(st.version, minMajor, minMinor)) return true
    const clt = getClt()
    if (clt.ok && versionAtLeast(clt.version, 26, 0)) return true
    return !!(clt.ok && Number(clt.apiVersion) >= 26)
  }

  // --- devecocli backend ---------------------------------------------------

  let cliCache
  async function ensureCli() {
    if (cliCache) return cliCache
    const pkg = devcli.resolveCliPkg()
    if (pkg.ok) {
      const r = await runShellRaw(devcli.buildCliCommand(pkg, ['--version'], psQuote, SHELL_FLAVOR), 30000, 8192)
      if (r.exitCode === 0) {
        const version = devcli.parseCliVersion((r.stdout && r.stdout.text) || '') || pkg.version
        log('devecocli ' + version + ' via local package')
        cliCache = { ...pkg, version }
        return cliCache
      }
      const tail = ((r.stderr && r.stderr.text) || (r.stdout && r.stdout.text) || '').slice(-220)
      cliCache = { ok: false, error: 'devecocli --version failed: ' + tail + ' (needs Node >= 18)' }
      return cliCache
    }
    let pathError = ''
    try {
      const probe = SHELL_FLAVOR === 'pwsh'
        ? 'Get-Command devecocli -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source'
        : 'command -v devecocli'
      const r = await runShellRaw(probe, 15000, 8192)
      const first = (((r.stdout && r.stdout.text) || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && /[\\/]/.test(s))[0] || '').trim()
      if (r.exitCode === 0 && first) {
        // npm's POSIX global shims are symlinks to the package JS entry and the
        // platform packages ship a `#!/bin/env node` shebang: executing the
        // shim depends on the host having /bin/env, so when the link resolves
        // to a JS file run that with our own node instead.
        const shim = devcli.resolveShimTarget(first)
        const v = shim.ok
          ? await runShellRaw(devcli.buildCliCommand(shim, ['--version'], psQuote, SHELL_FLAVOR), 30000, 8192)
          : await runShellRaw((SHELL_FLAVOR === 'pwsh' ? '& ' : '') + quote(first) + ' --version', 30000, 8192)
        if (v.exitCode === 0) {
          const version = devcli.parseCliVersion((v.stdout && v.stdout.text) || '')
          log('devecocli ' + version + ' on PATH')
          cliCache = { ok: true, ...(shim.ok ? shim : { kind: 'path', cmd: first }), version }
          return cliCache
        }
      }
    } catch (e) {
      pathError = String((e && e.message) || e)
    }
    // PATH misses the npm global shim on some setups (nvm4w keeps a
    // per-version dir on the user PATH): ask npm for the global prefix and
    // probe the package under its node_modules directly.
    try {
      const r = await runShellRaw('npm prefix -g', 15000, 8192)
      const prefix = (((r.stdout && r.stdout.text) || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/'))[0] || '').trim()
      if (r.exitCode === 0 && prefix) {
        const gp = devcli.resolveGlobalPkg(prefix)
        if (gp.ok) {
          const v = await runShellRaw(devcli.buildCliCommand(gp, ['--version'], psQuote, SHELL_FLAVOR), 30000, 8192)
          if (v.exitCode === 0) {
            const version = devcli.parseCliVersion((v.stdout && v.stdout.text) || '') || gp.version
            log('devecocli ' + version + ' via npm global prefix (' + prefix + ')')
            cliCache = { ...gp, version }
            return cliCache
          }
        }
      }
    } catch (e) {
      pathError = pathError || String((e && e.message) || e)
    }
    cliCache = { ok: false, error: devcli.CLI_HINT }
    return cliCache
  }

  // devecocli discovers DevEco Studio via registry/default paths, which fails
  // for non-default installs. We already detect both toolchain kinds
  // ourselves, so inject the matching root as environment for every CLI
  // invocation (deveco-cli precedence: DEVECO_CLI_STUDIO_PATH > DEVECO_CLI_CLT_PATH).
  function cliEnvPrefix() {
    const st = getStudio()
    const clt = getClt()
    const sdk = getSdk()
    const toolchainVar = (clt.ok && cltIsExplicit())
      ? 'DEVECO_CLI_CLT_PATH=' + psQuote(clt.root)
      : (st.ok ? 'DEVECO_CLI_STUDIO_PATH=' + psQuote(st.root) : (clt.ok ? 'DEVECO_CLI_CLT_PATH=' + psQuote(clt.root) : ''))
    if (!toolchainVar && !sdk.ok) return ''
    if (SHELL_FLAVOR === 'pwsh') {
      let prefix = ''
      if (toolchainVar) prefix += '$env:' + toolchainVar + '; '
      if (sdk.ok) prefix += '$env:DEVECO_SDK_HOME=' + psQuote(sdk.sdkRoot) + '; '
      return prefix
    }
    let prefix = ''
    if (toolchainVar) prefix += toolchainVar + ' '
    if (sdk.ok) prefix += 'DEVECO_SDK_HOME=' + psQuote(sdk.sdkRoot) + ' '
    return prefix
  }

  async function runCli(cli, argv, opts = {}) {
    const cmd = cliEnvPrefix() + devcli.buildCliCommand(cli, argv, psQuote, SHELL_FLAVOR) + (opts.mergeStderr ? ' 2>&1' : '')
    const r = await runShellRaw(cmd, opts.timeoutMs || 120000, opts.stdoutMaxBytes || 524288, opts.workdir || '')
    const out = (r.stdout && r.stdout.text) || ''
    const err = (r.stderr && r.stderr.text) || ''
    return { ok: r.exitCode === 0 && !r.timedOut && !r.aborted, exitCode: r.exitCode, timedOut: r.timedOut === true, aborted: r.aborted === true, stdout: out, stderr: err, cli }
  }

  // --- hvigor launcher -----------------------------------------------------

  function cltHvigorLauncher(root) {
    for (const name of ['hvigorw.bat', 'hvigorw.cmd', 'hvigorw']) {
      const p = join(root, 'bin', name)
      if (existsSync(p)) return { ok: true, path: p, kind: 'launcher' }
    }
    return { ok: false, path: '', kind: '' }
  }

  function toolchainHvigor() {
    const st = getStudio()
    const clt = getClt()
    if (clt.ok && cltIsExplicit()) {
      const launcher = cltHvigorLauncher(clt.root)
      if (launcher.ok) return launcher
      const js = join(clt.root, 'hvigor', 'bin', 'hvigorw.js')
      if (existsSync(js)) return { ok: true, path: js, kind: 'js' }
    }
    if (st.ok) {
      const h = studio.hvigorwPath(st.root)
      if (h.ok) return h
    }
    if (clt.ok) {
      const launcher = cltHvigorLauncher(clt.root)
      if (launcher.ok) return launcher
      const js = join(clt.root, 'hvigor', 'bin', 'hvigorw.js')
      if (existsSync(js)) return { ok: true, path: js, kind: 'js' }
    }
    return { ok: false, path: '', kind: '' }
  }

  function hvigorHead(hvigor) {
    const st = getStudio()
    const clt = getClt()
    const node = (clt.ok ? cltNodeBin(clt.root) : '') || (st.ok ? studioNodeBin(st.root) : '') || (typeof process !== 'undefined' && process.execPath) || 'node'
    return hvigorCommandHead(hvigor, node, SHELL_FLAVOR)
  }

  // Direct hvigorw build, used when devecocli is unavailable or its channel
  // died. hvigorw needs the project dir as its workdir and DEVECO_SDK_HOME in
  // its environment. The HNP Command Line Tools ship hvigor/bin/hvigorw.js as
  // plain JavaScript with no shebang, so the toolchain's own node is prefixed.
  async function hvigorDirectBuild({ base, product, mode, timeoutMs, task = 'assembleHap' }) {
    const st = getStudio()
    const sdk = getSdk()
    const hvigor = toolchainHvigor()
    if (!hvigor.ok || !sdk.ok) {
      return { available: false, error: 'Fallback needs DevEco Studio or standalone Command Line Tools with a runnable hvigorw launcher: ' + (hvigor.ok ? '' : 'hvigorw not found. ') + (sdk.ok ? '' : 'SDK not found.') }
    }
    const args = task === 'clean'
      ? 'clean --no-daemon'
      : (String(task || '').trim() && task !== 'assembleHap'
        ? String(task).trim() + ' --no-daemon'
        : 'assembleHap --mode module -p product=' + product + ' -p buildMode=' + mode + ' --no-daemon')
    // Keep the hvigor cache inside the project boundary so a build never
    // depends on writes outside the project.
    const isolatedHome = join(base, '.dsh-hvigor-tmp')
    const buildCacheDir = join(isolatedHome, 'cache-env')
    const javaHome = st.ok ? studioJavaHome(st.root) : ''
    const javaPrefix = SHELL_FLAVOR === 'pwsh'
      ? (javaHome ? '$env:JAVA_HOME=' + psQuote(javaHome) + '; $env:Path=' + psQuote(join(javaHome, 'bin') + ';') + ' + $env:Path; ' : '')
      : (javaHome ? 'JAVA_HOME=' + psQuote(javaHome) + ' PATH=' + psQuote(join(javaHome, 'bin') + ':') + '$PATH ' : '')
    const envPrefix = (cacheRoot) => SHELL_FLAVOR === 'pwsh'
      ? '$env:DEVECO_SDK_HOME=' + psQuote(sdk.sdkRoot) + '; ' + (st.ok ? '$env:DEVECO_CLI_STUDIO_PATH=' + psQuote(st.root) + '; ' : '') + (cacheRoot ? '$env:HVIGOR_USER_HOME=' + psQuote(cacheRoot) + '; $env:BUILD_CACHE_DIR=' + psQuote(join(cacheRoot, 'cache-env')) + '; ' : '') + javaPrefix
      : 'DEVECO_SDK_HOME=' + psQuote(sdk.sdkRoot) + ' ' + (st.ok ? 'DEVECO_CLI_STUDIO_PATH=' + psQuote(st.root) + ' ' : '') + (cacheRoot ? 'HVIGOR_USER_HOME=' + psQuote(cacheRoot) + ' BUILD_CACHE_DIR=' + psQuote(join(cacheRoot, 'cache-env')) + ' ' : '') + javaPrefix
    // Stop any daemon that captured a stale PATH/JAVA_HOME before the JBR was
    // injected. The task itself always runs with --no-daemon so
    // app_packing_tool.jar cannot fall back to a bare `java`.
    const stopDaemon = SHELL_FLAVOR === 'pwsh'
      ? 'try { & ' + hvigorHead(hvigor) + ' --stop-daemon *> $null } catch { }'
      : hvigorHead(hvigor) + ' --stop-daemon >/dev/null 2>&1 || true'
    // First run on a clean machine should not depend on the network to
    // bootstrap pnpm inside the isolated home; reuse the cached wrapper tools
    // from the default hvigor home when they already exist.
    const defaultHvigorHome = join(process.env.HVIGOR_USER_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.hvigor'))
    const preWarmPnpm = (cacheRoot) => SHELL_FLAVOR === 'pwsh'
      ? 'if (-not (Test-Path ' + psQuote(join(cacheRoot, 'wrapper', 'tools', 'node_modules', '.bin', 'pnpm.cmd')) + ') -and (Test-Path ' + psQuote(join(defaultHvigorHome, 'wrapper', 'tools')) + ')) { try { Copy-Item -LiteralPath ' + psQuote(join(defaultHvigorHome, 'wrapper', 'tools')) + ' -Destination ' + psQuote(join(cacheRoot, 'wrapper', 'tools')) + ' -Recurse -Force -ErrorAction Stop } catch { } }'
      : 'if [ ! -f ' + psQuote(join(cacheRoot, 'wrapper', 'tools', 'node_modules', '.bin', 'pnpm')) + ' ] && [ -d ' + psQuote(join(defaultHvigorHome, 'wrapper', 'tools')) + ' ]; then cp -a ' + psQuote(join(defaultHvigorHome, 'wrapper', 'tools') + '/.') + ' ' + psQuote(join(cacheRoot, 'wrapper', 'tools')) + '/ 2>/dev/null || true; fi'
    const commandFor = (cacheRoot) => {
      const taskCommand = SHELL_FLAVOR === 'pwsh'
        ? '& ' + hvigorHead(hvigor) + ' ' + args
        : hvigorHead(hvigor) + ' ' + args
      return SHELL_FLAVOR === 'pwsh'
        ? 'Set-Location -LiteralPath ' + psQuote(base) + '; ' + (cacheRoot ? 'New-Item -ItemType Directory -Force -Path ' + psQuote(cacheRoot) + ' | Out-Null; New-Item -ItemType Directory -Force -Path ' + psQuote(join(cacheRoot, 'cache-env')) + ' | Out-Null; ' : '') + (cacheRoot ? preWarmPnpm(cacheRoot) + '; ' : '') + envPrefix(cacheRoot) + stopDaemon + '; ' + envPrefix(cacheRoot) + taskCommand
        : (cacheRoot ? 'mkdir -p ' + psQuote(cacheRoot) + ' ' + psQuote(join(cacheRoot, 'cache-env')) + ' && ' : '') + 'cd ' + psQuote(base) + ' && ' + (cacheRoot ? preWarmPnpm(cacheRoot) + '; ' : '') + envPrefix(cacheRoot) + stopDaemon + '; ' + envPrefix(cacheRoot) + taskCommand
    }
    const run = async (home) => {
      const r = await runShellRaw(commandFor(home), timeoutMs, 1048576, base)
      return { r, out: (r.stdout && r.stdout.text) || '', err: (r.stderr && r.stderr.text) || '' }
    }
    let attempt = await run(isolatedHome)
    let r = attempt.r
    let out = attempt.out
    let err = attempt.err
    let retriedDefaultHome = false
    const cacheFailure = /(?:ENOENT[^\r\n]*(?:hvigor\.js|project_caches)|(?:hvigor\.js|project_caches)[^\r\n]*ENOENT|EPERM[^\r\n]*(?:\.hvigor|\.dsh-hvigor-tmp|project_caches|node_modules|build-logs|build\.log)|(?:\.hvigor|\.dsh-hvigor-tmp|build-logs)[^\r\n]*(?:EPERM|operation not permitted|access denied))/i.test(out + '\n' + err)
    if (cacheFailure && !buildOk({ exitCode: r.exitCode, timedOut: r.timedOut === true, stdout: out, stderr: err })) {
      // The isolated cache could not be used: retry against the user's real
      // hvigor home instead of failing the build.
      attempt = await run(defaultHvigorHome)
      r = attempt.r
      out = attempt.out
      err = attempt.err
      retriedDefaultHome = true
    }
    return {
      available: true,
      ok: buildOk({ exitCode: r.exitCode, timedOut: r.timedOut === true, stdout: out, stderr: err }),
      exitCode: r.exitCode,
      timedOut: r.timedOut === true,
      retriedDefaultHome,
      daemonStopped: true,
      javaHome,
      hvigorUserHome: isolatedHome,
      buildCacheDir,
      hvigorCacheDir: isolatedHome,
      output: tailText((out + '\n' + err).trim(), 8000),
    }
  }

  const hvigorDiag = (fb) => ({
    daemonStopped: !!(fb && fb.daemonStopped),
    javaHome: (fb && fb.javaHome) || '',
    hvigorUserHome: (fb && fb.hvigorUserHome) || '',
    buildCacheDir: (fb && fb.buildCacheDir) || '',
  })

  // --- project root --------------------------------------------------------

  function projectRoot() {
    return getProjectRoot()
  }

  // A trivial host-shell probe, used by hdc_diag to prove the shell works.
  async function probeEcho() {
    const r = await runShellRaw('echo diag-ok', 8000, 2048)
    return {
      exitCode: r.exitCode,
      stdout: ((r.stdout && r.stdout.text) || '').slice(0, 120),
      stderr: ((r.stderr && r.stderr.text) || '').slice(0, 120),
    }
  }

  // Host-shell command execution (used by the hvigor fallback and the
  // arkts-check driver, both of which need env prefixes and shell syntax).
  async function runShell(command, timeoutMs = 30000, stdoutMaxBytes = 262144, workdir = '') {
    return runShellRaw(command, timeoutMs, stdoutMaxBytes, workdir)
  }

  return {
    // hdc
    ensureHdc, runHdc, listTargets, pickTarget, currentTarget,
    hdcPathRef, hdcErrorRef, diagLogRef, candidateList, getPreferred, setPreferred,
    // toolchain
    getStudio, getClt, getSdk, featureGate, versionAtLeast, versionGte, cltIsExplicit,
    ensureCli, runCli, cliEnvPrefix, toolchainHvigor, hvigorDirectBuild, hvigorDiag,
    // misc
    projectRoot, probeEcho, runShell, log,
  }
}
