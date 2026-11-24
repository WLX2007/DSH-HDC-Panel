// Compile-assistance tools (switch_cwd, build_project, arkts_check,
// start_app, hdc_log) for the standalone MCP server.
//
// Ported from the DSH plugin's lib/host.js. The plugin kept the project root
// per conversation session; an MCP server is a single-client process, so the
// root is one process-level value (see core/state.mjs) that switch_cwd
// changes.

import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as compileCli from '../core/compile-cli.mjs'
import * as compileOut from '../core/compile-output.mjs'
import { buildOk, buildResultOk, mojoFatal, bundlePattern, statMtimeMs } from '../core/build-signals.mjs'
import { collectEtsFiles, findNewestHap, isHarmonyApplicationRoot, readBundleAndAbility } from '../core/project.mjs'
import { createDeviceServices } from '../core/device-services.mjs'
import { SHELL_FLAVOR, psQuote } from '../core/quoting.mjs'
import { getProjectRoot, getWorkspaceRoot, pathInside, setProjectRoot } from '../core/state.mjs'
import { arktsRuntimeFrom } from '../core/runtime.mjs'

const tailText = (text, max) => (text.length <= max ? text : text.slice(text.length - max))

// The ArkTS checker script ships with the package (assets/arkts-check.cjs).
function arktsScriptPath() {
  const override = (typeof process !== 'undefined' && process.env && process.env.DEVECO_ARKTS_CHECK_SCRIPT) || ''
  if (String(override).trim()) return String(override).trim()
  return fileURLToPath(new URL('../../assets/arkts-check.cjs', import.meta.url))
}

export function buildCompileTools(rt) {
  const { ensureHdc, runHdc, listTargets, currentTarget, hdcPathRef, hdcErrorRef, ensureCli, runCli, getStudio, getClt, getSdk } = rt
  const services = createDeviceServices(rt)

  async function resolveBundlePid(bundle, target) {
    if (!bundle) return 0
    const first = await runHdc(['shell', 'pidof ' + bundle], { target, timeoutMs: 20000, stdoutMaxBytes: 8192 })
    const direct = /(\d+)/.exec(first.stdout || '')
    if (first.ok && direct) return parseInt(direct[1], 10)
    const second = await runHdc(['shell', 'ps -A | grep ' + bundle], { target, timeoutMs: 20000, stdoutMaxBytes: 16384 })
    const line = (second.stdout || '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.includes(bundle)) || ''
    const pid = parseInt(line.split(/\s+/)[1], 10)
    return Number.isInteger(pid) ? pid : 0
  }

  async function verifyAbilityStarted(bundle, target) {
    if (!bundle) return { ok: false, output: '', error: 'bundle name is unavailable' }
    const dump = await runHdc(['shell', 'aa', 'dump', '-l'], { target, timeoutMs: 20000, stdoutMaxBytes: 65536 })
    const output = (dump.stdout || '') + '\n' + (dump.stderr || '')
    return { ok: dump.ok && bundlePattern(bundle).test(output), output, error: dump.ok ? '' : (dump.stderr || dump.stdout || 'aa dump failed') }
  }

  async function hdcFallbackDeploy(args, cwd) {
    await ensureHdc()
    if (!hdcPathRef()) {
      const error = hdcErrorRef()
      return { ok: false, error, text: error }
    }
    const list = await listTargets()
    const requested = String((args && args.hvd) || '').trim()
    const match = requested
      ? (list.targets.find((target) => target.id === requested || String(target.addr || '').includes(requested) || requested.includes(target.id)) || null)
      : null
    const targetId = match ? match.id : rt.pickTarget(list.targets)
    if (!targetId) {
      return { ok: false, error: 'No hdc target found. Start an emulator or connect a device, then retry.', text: 'No hdc target found.' }
    }
    const hap = findNewestHap(cwd)
    if (!hap) {
      return { ok: false, error: 'No built .hap was found under ' + cwd + '. Run build_project first and check switch_cwd.', text: 'No .hap artifact found under the project root.' }
    }
    const installPath = process.platform === 'win32' ? hap.replace(/\//g, '\\') : hap
    const installResult = await runHdc(['install', '-r', installPath], { target: targetId, timeoutMs: 180000, stdoutMaxBytes: 65536 })
    const { bundle, ability } = readBundleAndAbility(cwd)
    let startResult = null
    let verification = null
    if (installResult.ok && bundle) {
      startResult = await runHdc(['shell', 'aa', 'start', '-a', ability, '-b', bundle], { target: targetId, timeoutMs: 60000, stdoutMaxBytes: 32768 })
      verification = await verifyAbilityStarted(bundle, targetId)
    }
    const startOutput = startResult ? (startResult.stdout || '') + '\n' + (startResult.stderr || '') : ''
    const startRemoteFailure = /failed to start ability|error code:\s*\d+|screen is locked|unable to start ability/i.test(startOutput)
    const startOk = Boolean(startResult && startResult.ok && !startRemoteFailure && verification && verification.ok)
    const ok = installResult.ok && (!bundle || startOk)
    const unsignedNote = /unsigned/i.test(hap)
      ? (installResult.ok
        ? '\n  (unsigned artifact: accepted by many emulators; physical devices need signing)'
        : '\n  (unsigned artifact rejected: configure signing in build-profile.json5)')
      : ''
    const text = [
      `hdc fallback deploy -> ${targetId}:`,
      `  hdc install -r ${hap} -> ${installResult.ok ? 'ok' : 'FAILED: ' + (installResult.stderr || installResult.stdout)}`,
      bundle
        ? `  aa start -a ${ability} -b ${bundle} -> ${startOk ? 'ok (mission verified)' : 'FAILED: ' + (startRemoteFailure ? startOutput.trim() : ((startResult && (startResult.stderr || startResult.stdout)) || (verification && verification.error) || 'mission not found after aa start'))}`
        : '  bundleName was not readable from AppScope/app.json5; start it with hdc_app.',
    ].join('\n') + unsignedNote
    return { ok, targetId, hap, bundle, ability, installOk: installResult.ok, startOk, startRemoteFailure, missionVerified: Boolean(verification && verification.ok), text }
  }

  return [
    {
      name: 'switch_cwd',
      description: 'Switch the HarmonyOS project root used by build_project, start_app, arkts_check, hdc_log and hms_build. Accepts an absolute path or a path relative to the directory the server was started in.',
      inputSchema: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Target HarmonyOS project directory path, absolute or relative to the server start directory.' },
        },
        required: ['project_path'],
      },
      async execute(args) {
        const trimmed = String((args && args.project_path) || '').trim()
        if (!trimmed) return { ok: false, error: 'project_path must not be empty' }
        const root = getWorkspaceRoot()
        const target = isAbsolute(trimmed) ? normalize(trimmed) : pathResolve(root, trimmed)
        let real
        try {
          real = realpathSync(target)
        } catch {
          return { ok: false, error: 'Not a directory or not found: ' + target }
        }
        if (!statSync(real).isDirectory()) return { ok: false, error: 'Not a directory or not found: ' + target }
        setProjectRoot(real)
        const isHarmony = isHarmonyApplicationRoot(real)
        const outsideWorkspace = !pathInside(root, real)
        const text = outsideWorkspace
          ? `Project root set to ${real}. This directory is outside the server start directory (${root}).`
          : (isHarmony
            ? `Project root set to ${real}.`
            : `Directory set to ${real}, but it is not a HarmonyOS application project root.`)
        return { ok: true, directory: real, isHarmonyProject: isHarmony, outsideWorkspace, text }
      },
    },

    {
      name: 'build_project',
      description: 'Compile and package a HarmonyOS project. Uses the official DevEco CLI when installed, otherwise falls back to the local hvigorw build, and verifies that a .hap artifact changed.',
      inputSchema: {
        type: 'object',
        properties: {
          clean: { type: 'boolean', description: 'Remove existing build outputs before compiling.' },
          product: { type: 'string', description: 'Product name from build-profile.json5.' },
          modules: { type: 'array', items: { type: 'string' }, description: 'Module names or module@target values.' },
          build_mode: { type: 'string', description: 'Build mode such as debug or release.' },
        },
        required: [],
      },
      async execute(args) {
        args = args || {}
        const cwd = getProjectRoot()
        if (!existsSync(join(cwd, 'build-profile.json5'))) {
          return { ok: false, error: `HarmonyOS project not found at ${cwd}. Run switch_cwd to the project root or scaffold a project first.` }
        }
        const cli = await ensureCli()
        const argv = compileCli.buildDevecoCliBuildArgs({ ...args, clean: false })
        const cleanArgv = ['build', 'clean']
        const hapBefore = findNewestHap(cwd)
        const beforeM = statMtimeMs(hapBefore)
        let result = { stdout: '', stderr: cli.ok ? '' : cli.error, exitCode: null, timedOut: false }
        let mojo = false
        let ok = false
        if (cli.ok) {
          if (args.clean === true) {
            const cleanResult = await runCli(cli, cleanArgv.map((arg) => psQuote(arg)), { timeoutMs: 30 * 60 * 1000, stdoutMaxBytes: 1048576, workdir: cwd })
            const cleanMojo = mojoFatal(cleanResult)
            if (buildResultOk(cleanResult) && !cleanMojo) {
              result = await runCli(cli, argv.map((arg) => psQuote(arg)), { timeoutMs: 30 * 60 * 1000, stdoutMaxBytes: 1048576, workdir: cwd })
              result = { ...result, stdout: cleanResult.stdout + '\n' + result.stdout, stderr: cleanResult.stderr + '\n' + result.stderr }
              mojo = mojoFatal(result)
              ok = buildResultOk(result) && !mojo
            } else {
              result = cleanResult
              mojo = cleanMojo
            }
          } else {
            result = await runCli(cli, argv.map((arg) => psQuote(arg)), { timeoutMs: 30 * 60 * 1000, stdoutMaxBytes: 1048576, workdir: cwd })
            mojo = mojoFatal(result)
            ok = buildResultOk(result) && !mojo
          }
        }
        let hapAfter = findNewestHap(cwd)
        const afterM = statMtimeMs(hapAfter)
        const artifactStale = ok && (!hapAfter || (args.clean !== true && afterM <= beforeM))
        // An up-to-date incremental build legitimately keeps the artifact
        // mtime, so only a missing artifact is fatal.
        if (artifactStale && !hapAfter) ok = false

        let backend = cli.ok ? 'devecocli' : 'none'
        let fallback = false
        let fallbackText = ''
        let hvigorLast = null
        if (!ok) {
          fallback = true
          const product = String(args.product || 'default')
          const mode = String(args.build_mode || 'debug')
          const direct = args.clean === true
            ? await rt.hvigorDirectBuild({ base: cwd, product, mode, timeoutMs: 30 * 60 * 1000, task: 'clean' })
            : null
          hvigorLast = direct
          let buildDirect = direct
          let fallbackOutput = direct ? direct.output : ''
          if (args.clean === true && direct && direct.available && direct.ok) {
            buildDirect = await rt.hvigorDirectBuild({ base: cwd, product, mode, timeoutMs: 30 * 60 * 1000, task: 'assembleHap' })
            hvigorLast = buildDirect
            fallbackOutput += '\n' + (buildDirect.output || '')
          } else if (args.clean !== true) {
            buildDirect = await rt.hvigorDirectBuild({ base: cwd, product, mode, timeoutMs: 30 * 60 * 1000, task: 'assembleHap' })
            hvigorLast = buildDirect
            fallbackOutput = buildDirect.output
          }
          if (buildDirect && buildDirect.available && buildDirect.ok) {
            const fallbackHap = findNewestHap(cwd)
            const fallbackVerified = Boolean(fallbackHap) && (args.clean === true || statMtimeMs(fallbackHap) > beforeM)
            hapAfter = fallbackHap
            if (fallbackVerified) {
              ok = true
              backend = 'hvigorw'
              fallbackText = '\n\nDirect hvigorw fallback completed. New artifact: ' + (fallbackHap || '') + '\n' + compileOut.stripAnsi(fallbackOutput)
            } else {
              fallbackText = '\n\nhvigorw reported success but no .hap artifact was produced.\n' + compileOut.stripAnsi(fallbackOutput)
            }
          } else {
            const failure = buildDirect || direct
            fallbackText = failure && failure.available ? '\n\nhvigorw fallback failed:\n' + compileOut.stripAnsi(fallbackOutput) : '\n\nhvigorw fallback unavailable: ' + (failure ? failure.error : 'unknown error')
          }
        }
        const formatted = compileOut.formatBuildProjectOutput({ stdout: result.stdout, stderr: result.stderr, exitCode: ok ? result.exitCode : (result.exitCode === 0 ? 1 : result.exitCode) })
        let text = formatted.text
        if (ok && backend === 'devecocli' && result.exitCode !== 0) {
          text = text.replace(/BUILD FAILED \(exitCode=\d+\)/, `Build completed successfully (exitCode=${result.exitCode}, judged by output markers)`)
        }
        if (artifactStale) text += '\n\nBuild reported success but no .hap artifact was updated. Last artifact: ' + (hapAfter || 'none') + '.'
        if (mojo) text += '\n\n' + MOJO_NOTE
        if (fallbackText) text += fallbackText
        if (ok && backend === 'hvigorw') text += '\n\nBuild completed successfully (backend=hvigorw).'
        return {
          ok,
          backend,
          fallback,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          command: args.clean === true ? compileCli.commandText(cleanArgv) + ' && ' + compileCli.commandText(argv) : compileCli.commandText(argv),
          truncated: formatted.truncated,
          mojoFatal: mojo,
          artifactStale,
          hapBefore: hapBefore || '',
          hapAfter: hapAfter || '',
          warning: artifactStale ? 'Build output indicated success but the artifact did not change.' : '',
          text,
          error: ok ? '' : (fallbackText || (cli.ok ? 'build failed' : cli.error)),
        }
      },
    },

    {
      name: 'arkts_check',
      description: 'Run the ArkTS strict-mode static checker through the SDK ets-loader (DevEco Studio first, then the standalone Command Line Tools). With no files supplied, collects .ets files from entry/src/main/ets.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Optional .ets file paths, relative to the project root or absolute.' },
        },
        required: [],
      },
      async execute(args) {
        args = args || {}
        const cwd = getProjectRoot()
        // Prefer Studio, then a standalone Command Line Tools install: the
        // bundled checker needs the SDK ets-loader plus a node runtime and a
        // CLT ships both — only the runtime path differs (<root>/node/bin/node
        // vs <root>/tools/node).
        const studioInfo = getStudio()
        const cltInfo = getClt()
        const runtime = arktsRuntimeFrom(studioInfo.ok ? studioInfo.root : '', cltInfo.ok ? cltInfo.root : '')
        const arktsRoot = runtime.root
        const nodeBin = runtime.node
        if (!arktsRoot) {
          return { ok: false, error: 'arkts_check needs the SDK ets-loader plus a node runtime: neither DevEco Studio (tools/node) nor the standalone Command Line Tools (node/) were usable here. Run hms_setup to see the detected toolchain paths.' }
        }
        const scriptPath = arktsScriptPath()
        if (!existsSync(scriptPath)) return { ok: false, error: 'arkts-check script not found: ' + scriptPath }
        let files = (Array.isArray(args.files) ? args.files : []).map((file) => String(file).trim()).filter(Boolean)
        let autoCollected = false
        if (files.length === 0) {
          files = collectEtsFiles(cwd)
          autoCollected = true
        }
        if (files.length === 0) {
          return { ok: false, error: 'Auto-collect found no .ets files under entry/src/main/ets.', fileCount: 0, title: 'ArkTS Check Skipped' }
        }
        files = files.slice(0, 1000)
        const argv = [psQuote(scriptPath), '--project', psQuote(cwd), '--deveco-home', psQuote(arktsRoot), '--files', ...files.map((file) => psQuote(file))]
        const command = SHELL_FLAVOR === 'pwsh'
          ? '$env:DEVECO_HOME=' + psQuote(arktsRoot) + '; & ' + psQuote(nodeBin) + ' ' + argv.join(' ')
          : 'DEVECO_HOME=' + psQuote(arktsRoot) + ' ' + psQuote(nodeBin) + ' ' + argv.join(' ')
        const result = await rt.runShell(command, 10 * 60 * 1000, 524288, cwd)
        const stdout = ((result.stdout && result.stdout.text) || '').trim()
        const stderr = ((result.stderr && result.stderr.text) || '').trim()
        if (!stdout) return { ok: false, error: stderr || `arkts-check exited with code ${result.exitCode} but produced no output` }
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return { ok: false, error: 'Failed to parse arkts-check output: ' + stdout.slice(0, 500) }
        }
        if (parsed && parsed.error && (!Array.isArray(parsed.errors) || parsed.errors.length === 0)) return { ok: false, error: parsed.error }
        const diagnostics = Array.isArray(parsed && parsed.errors) ? parsed.errors : []
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
        const errorCount = errors.length
        const warnCount = diagnostics.length - errors.length
        if (errors.length === 0) {
          return { ok: true, errorCount: 0, warnCount, fileCount: files.length, autoCollected, title: 'ArkTS Check Passed', text: `ArkTS Check Passed: no errors found in ${files.length} file(s).` }
        }
        const lines = errors.map((diagnostic) => `${diagnostic.file || ''}:${diagnostic.line ?? ''}:${diagnostic.column ?? ''} - ${diagnostic.severity || 'error'}: ${diagnostic.message || ''}${diagnostic.rule ? ' (' + diagnostic.rule + ')' : ''}`)
        return { ok: false, errorCount, warnCount, fileCount: files.length, title: 'ArkTS Check Failed', text: ['ArkTS check found ' + errorCount + ' error(s):', ...lines].join('\n') }
      },
    },

    {
      name: 'start_app',
      description: 'Start a built HarmonyOS app without rebuilding. If the official CLI discovery or launch fails, install the newest .hap through hdc and start its entry ability.',
      inputSchema: {
        type: 'object',
        properties: {
          hvd: { type: 'string', description: 'Target device name or serial. Omit to list available devices.' },
          ability: { type: 'string', description: 'Ability name, for example EntryAbility.' },
          module: { type: 'string', description: 'Module name, for example entry.' },
          target: { type: 'string', description: 'Build target paired with module.' },
        },
        required: [],
      },
      async execute(args) {
        args = args || {}
        const cwd = getProjectRoot()
        const cli = await ensureCli()
        const results = []
        const invoke = async (cliArgs) => {
          const result = await runCli(cli, cliArgs.map((arg) => psQuote(arg)), { timeoutMs: 15 * 60 * 1000, stdoutMaxBytes: 524288, workdir: cwd })
          results.push({ command: compileCli.commandText(cliArgs), result })
          return result
        }
        if (cli.ok) {
          for (const cliArgs of compileCli.buildDevecoCliStartAppCommands(args)) await invoke(cliArgs)
          const device = String(args.hvd || '').trim()
          if (device) {
            const runArgs = compileCli.buildDevecoCliRunArgs({ device, ability: args.ability, module: args.module, target: args.target })
            const first = results[0] && results[0].result
            const firstText = first ? first.stdout + '\n' + first.stderr : ''
            if (first && compileCli.devecoCliListContainsTarget(firstText, device)) {
              await invoke(runArgs)
            } else {
              const emulators = await invoke(['emulator', 'list'])
              if (compileCli.devecoCliListContainsTarget(emulators.stdout + '\n' + emulators.stderr, device)) {
                const started = await invoke(['emulator', 'start', device])
                if (started.exitCode === 0 && !mojoFatal(started)) await invoke(runArgs)
              }
            }
          }
        }
        const discoveryResults = results.filter(({ command }) => /device list|emulator list/.test(String(command)))
        const discoveryMojo = discoveryResults.length > 0 && discoveryResults.every(({ result }) => result && (mojoFatal(result) || result.exitCode !== 0))
        const cliText = results.length ? compileCli.formatStartAppResults(results) : ''
        let ok = results.some(({ command, result }) => String(command).startsWith('devecocli run ') && result && result.exitCode === 0 && !mojoFatal(result))
        let mode = cli.ok ? 'devecocli' : 'none'
        let fallback = null
        let hdcAvailable = []
        if (!String(args.hvd || '').trim()) {
          // Listing is read-only here: start_app never deploys or launches
          // without hvd.
          await ensureHdc()
          if (hdcPathRef()) {
            const discovered = await listTargets()
            hdcAvailable = discovered.targets.filter((target) => /connected/i.test(target.state) && !/^COM\d+$/i.test(target.id))
          }
        }
        if (!ok && String(args.hvd || '').trim()) {
          fallback = await hdcFallbackDeploy(args, cwd)
          if (fallback.ok) {
            ok = true
            mode = 'hdc-fallback'
          }
        }
        const text = fallback
          ? (fallback.ok
            ? fallback.text + (cliText ? '\n\n[devecocli background]\n' + cliText : '')
            : (cliText ? cliText + '\n\n' : '') + 'hdc fallback failed: ' + (fallback.text || fallback.error))
          : (hdcAvailable.length > 0
            ? ['请指定要使用的设备。', '当前 hdc 在线设备：', '', ...hdcAvailable.map((target) => `  - ${target.id} (${target.type || 'device'})`), '', '请使用 hvd 参数指定设备名称，例如：', `- hvd="${hdcAvailable[0].id}"`].join('\n')
            : cliText)
        return {
          ok,
          mode,
          hdcFallback: fallback,
          availableDevices: hdcAvailable,
          discoveryMojo,
          commands: results.map((entry) => entry.command),
          exitCodes: results.map((entry) => entry.result ? entry.result.exitCode : null),
          text,
          error: ok ? '' : (cli.ok ? 'App launch failed.' : cli.error),
        }
      },
    },

    {
      name: 'hdc_log',
      description: 'Collect, clear, or list HarmonyOS device logs. Collection uses the official DevEco CLI when available and falls back to hdc shell hilog for PID-filtered requests.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of collect, clear, or list_devices.' },
          device_id: { type: 'string', description: 'Optional device name or serial.' },
          log_prefix: { type: 'string', description: 'Optional log keyword.' },
          bundle: { type: 'string', description: 'Optional bundle name used to resolve and filter by PID.' },
          pid: { type: 'integer', description: 'Optional explicit PID, which takes precedence over bundle.' },
          lines: { type: 'integer', description: 'Maximum log lines, 1 through 5000.' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const cwd = getProjectRoot()
        const action = String(args.action || '')

        if (action === 'list_devices') {
          const cli = await ensureCli()
          if (cli.ok) {
            const result = await runCli(cli, ['device', 'list'].map((arg) => psQuote(arg)), { timeoutMs: 60000, stdoutMaxBytes: 262144, workdir: cwd })
            const output = compileOut.stripAnsi((result.stdout + result.stderr).trim())
            const rows = compileCli.parseCliTable(result.stdout)
            if (result.exitCode === 0 && !mojoFatal(result) && rows.length > 0) {
              await ensureHdc()
              const discovered = hdcPathRef() ? await listTargets() : { ok: false, targets: [], error: '' }
              const devices = discovered.targets.filter((target) => /connected/i.test(target.state) && !/^COM\d+$/i.test(target.id))
              const preferred = rt.getPreferred() || (devices[0] && devices[0].id) || (rows[0] && (rows[0].serial || rows[0].name)) || ''
              if (preferred && !rt.getPreferred()) rt.setPreferred(preferred)
              return {
                ok: true,
                action,
                deviceCount: devices.length || rows.length,
                lineCount: null,
                devices: devices.length ? devices : rows,
                targets: discovered.targets,
                preferred,
                preferredActive: Boolean(preferred && discovered.targets.some((target) => target.id === preferred && /connected/i.test(target.state))),
                text: output,
                error: discovered.error || '',
              }
            }
          }
          await ensureHdc()
          if (!hdcPathRef()) {
            const error = hdcErrorRef()
            return { ok: false, action, deviceCount: 0, lineCount: null, devices: [], targets: [], preferred: rt.getPreferred(), preferredActive: false, text: error, error }
          }
          const targets = await listTargets()
          const devices = targets.targets.filter((target) => /connected/i.test(target.state) && !/^COM\d+$/i.test(target.id))
          const preferred = rt.getPreferred() || (devices[0] && devices[0].id) || ''
          if (preferred && !rt.getPreferred()) rt.setPreferred(preferred)
          const preferredActive = Boolean(preferred && targets.targets.some((target) => target.id === preferred && /connected/i.test(target.state)))
          const text = devices.length
            ? devices.map((target) => `${target.id} ${target.type} ${target.state}`.trim()).join('\n')
            : 'No connected devices detected.'
          return { ok: targets.ok, action, deviceCount: devices.length, lineCount: null, devices, targets: targets.targets, preferred, preferredActive, text, error: targets.error || '' }
        }

        if (action === 'clear') {
          await ensureHdc()
          if (!hdcPathRef()) {
            const error = hdcErrorRef()
            return { ok: false, error, text: error }
          }
          const target = String(args.device_id || '').trim() || undefined
          const result = await runHdc(['shell', 'hilog -r'], { timeoutMs: 30000, stdoutMaxBytes: 16384, target })
          if (!result.ok) return { ok: false, error: result.stderr || 'hilog -r failed', text: result.stderr || result.stdout }
          return { ok: true, action, device: target || 'default', text: 'Device log buffer cleared.' }
        }

        if (action === 'collect') {
          const lines = Math.max(1, Math.min(5000, Number(args.lines) || 2000))
          const keyword = String(args.log_prefix || '').trim()
          const bundle = String(args.bundle || '').trim()
          const pidArg = Number(args.pid) || 0
          let backend = 'devecocli'
          let raw = ''
          let cliNote = ''
          const needsFullBuffer = Boolean(bundle || pidArg)
          if (!needsFullBuffer) {
            const cli = await ensureCli()
            if (cli.ok) {
              const argv = compileCli.buildDevecoCliLogArgs({ device: args.device_id, keyword, tail: lines })
              const result = await runCli(cli, argv.map((arg) => psQuote(arg)), { timeoutMs: 120000, stdoutMaxBytes: 1048576, workdir: cwd })
              if (result.exitCode === 0 && !mojoFatal(result)) raw = compileOut.stripAnsi(result.stdout)
              else cliNote = 'devecocli log was unavailable; used hdc shell hilog.'
            } else {
              cliNote = 'devecocli is unavailable; used hdc shell hilog.'
            }
          } else {
            cliNote = 'PID or bundle filtering requires the full hdc hilog buffer.'
          }
          if (!raw) {
            backend = 'hdc'
            await ensureHdc()
            if (!hdcPathRef()) {
              const error = hdcErrorRef()
              return { ok: false, error, text: error }
            }
            const current = await currentTarget(args.device_id)
            if (current.error) return { ok: false, error: current.error, text: current.error }
            const result = await runHdc(['shell', 'hilog', '-x'], { target: current.target, timeoutMs: 60000, stdoutMaxBytes: 2097152 })
            if (!result.ok) return { ok: false, error: result.stderr || result.stdout || 'hilog failed', text: result.stderr || result.stdout }
            raw = result.stdout
          }
          let pid = pidArg
          let pidNote = ''
          if (!pid && bundle && hdcPathRef()) {
            const current = await currentTarget(args.device_id)
            if (!current.error) {
              pid = await resolveBundlePid(bundle, current.target)
              pidNote = pid ? `resolved pid ${pid} for ${bundle}` : `bundle ${bundle} is not running (no PID resolved)`
            }
          }
          let all = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          if (keyword) all = all.filter((line) => line.toLowerCase().includes(keyword.toLowerCase()))
          if (pid) all = all.filter((line) => new RegExp('(^|\\s)' + pid + '\\s').test(line))
          else if (bundle) all = all.filter((line) => line.toLowerCase().includes(bundle.toLowerCase()))
          const logLines = all.slice(-lines)
          const meta = { backend, bundle, pid, cliNote, pidNote }
          const head = [`backend: ${backend}`, `device: ${args.device_id || 'default'}`, `prefix: ${keyword || '(none)'}`, `bundle: ${bundle || '(none)'}`, `pid: ${pid || '(none)'}`]
          if (cliNote) head.push(cliNote)
          if (pidNote) head.push(pidNote)
          if (logLines.length === 0) return { ok: true, action, device: String(args.device_id || 'default'), prefix: keyword, ...meta, lineCount: 0, text: ['No matching logs found.', ...head].join('\n') }
          return { ok: true, action, device: String(args.device_id || 'default'), prefix: keyword, ...meta, lineCount: logLines.length, text: ['Log collection successful.', ...head, `count: ${logLines.length}`, '', '--- Log Content ---', ...logLines].join('\n') }
        }

        return { ok: false, error: 'unknown action: ' + action, text: 'unknown action: ' + action }
      },
    },
  ]
}

const MOJO_NOTE = 'devecocli mojo platform channel failed (FATAL platform_channel 拒绝访问 0x5). This is a host IPC problem, not a build failure: the discovery/docs/emulator subcommands need a normal user session, while device-side work continues through the hdc_* tools.'
