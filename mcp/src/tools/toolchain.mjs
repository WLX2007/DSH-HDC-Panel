// Official toolchain + knowledge tools (8 hms_* tools) for the standalone
// MCP server.
//
// Ported from the DSH plugin's lib/host.js. Differences:
//   - no sandbox policy; commands run directly
//   - the sandbox-specific wording ("[Outside sandbox] execution", mojo
//     channel blocked by the sandbox) is replaced with sandbox-neutral text
//   - the workspace-boundary guard is gone (there is no sandbox to guard);
//     the project root comes from switch_cwd / projectPath
//
// Toolchain backend precedence: devecocli (official CLI) when installed,
// otherwise the local hvigorw launcher + hdc.

import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as sdkDts from '../core/sdk-dts.mjs'
import * as studio from '../core/studio.mjs'
import * as verDetect from '../core/version-detect.mjs'
import * as compileOut from '../core/compile-output.mjs'
import * as knowledge from '../core/knowledge.mjs'
import * as knowledgeRemote from '../core/knowledge-remote.mjs'
import { findNewestHap, readBundleAndAbility } from '../core/project.mjs'
import { buildResultOk, mojoFatal, bundlePattern, tryParseJson, statMtimeMs } from '../core/build-signals.mjs'
import { createDeviceServices } from '../core/device-services.mjs'
import { SHELL_FLAVOR, psQuote } from '../core/quoting.mjs'
import { getProjectRoot, lintReportDir } from '../core/state.mjs'
import {
  planCreate, createArgv, checkDestination, verifyScaffold,
  parseCreatedApiLevel, createErrorHint, createSuccessHint, CREATE_OK_MARKER,
} from '../core/project-create.mjs'

const tailText = (text, max) => (text.length <= max ? text : text.slice(text.length - max))

const MOJO_NOTE = 'devecocli mojo platform channel failed (FATAL platform_channel 拒绝访问 0x5). This is a host IPC problem, not a build failure: the discovery/docs/emulator subcommands need a normal user session, while device-side work continues through the hdc_* tools.'
const MOJO_ARTIFACT_NOTE = 'devecocli mojo platform channel crashed (0x5) but the build process itself completed — verify the .hap artifact exists before installing (hdc_install rejects a missing artifact).'

export function buildToolchainTools(rt) {
  const { ensureHdc, runHdc, listTargets, currentTarget, hdcPathRef, hdcErrorRef, ensureCli, runCli, getStudio, getClt, getSdk, featureGate, versionAtLeast, versionGte, toolchainHvigor } = rt
  const services = createDeviceServices(rt)

  // --- artifact discovery --------------------------------------------------

  // See ../core/project.mjs for collectEtsFiles / findNewestHap /
  // readBundleAndAbility — they are shared with the compile tool group.

  async function verifyAbilityStarted(bundle, target) {
    if (!bundle) return { ok: false, output: '', error: 'bundle name is unavailable' }
    const dump = await runHdc(['shell', 'aa', 'dump', '-l'], { target, timeoutMs: 20000, stdoutMaxBytes: 65536 })
    const output = (dump.stdout || '') + '\n' + (dump.stderr || '')
    return { ok: dump.ok && bundlePattern(bundle).test(output), output, error: dump.ok ? '' : (dump.stderr || dump.stdout || 'aa dump failed') }
  }

  // --- target API resolution ----------------------------------------------

  async function resolveTarget({ explicit, projectPath, overrides }) {
    const sdkInfo = getSdk(overrides || {})
    let project = null
    let projectDir = ''
    const base = projectPath || getProjectRoot()
    if (base) {
      const prof = verDetect.findProjectProfile(base)
      if (prof.ok) {
        const v = verDetect.parseCompatibleSdk(prof.text)
        project = v.compatibleSdkVersion != null ? v.compatibleSdkVersion : (v.compileSdkVersion != null ? v.compileSdkVersion : null)
        projectDir = prof.dir
      }
    }
    let device = null
    let deviceError = ''
    if (hdcPathRef()) {
      try {
        const r = await runHdc(['shell', 'param get const.ohos.apiversion'], { timeoutMs: 20000, stdoutMaxBytes: 4096 })
        const m = /(\d+)/.exec(r.stdout || '')
        if (r.ok && m) device = parseInt(m[1], 10)
        else if (!r.ok) deviceError = r.stderr || 'device param read failed'
      } catch (e) {
        deviceError = String((e && e.message) || e)
      }
    } else {
      deviceError = 'hdc unavailable'
    }
    const resolved = verDetect.resolveApi({ explicit: explicit ?? null, project, device, sdk: sdkInfo.ok ? sdkInfo.apiVersion : null })
    return { resolved, sdkInfo, projectDir, deviceError }
  }

  // --- hvigor fallback build ----------------------------------------------

  // hvigorDirectBuild / hvigorDiag live in core/runtime.mjs so the compile
  // tool group can share the same fallback path.
  const hvigorDirectBuild = rt.hvigorDirectBuild
  const hvigorDiag = rt.hvigorDiag

  // --- lint report staging -------------------------------------------------

  const LINT_REPORT_RE = /CodeLinter report|Summary:/i
  let lintReportSeq = 0
  function lintReportPath() {
    const base = getProjectRoot()
    if (!base) return ''
    lintReportSeq += 1
    const dir = lintReportDir()
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* the CLI creates it */ }
    return join(dir, 'lint-' + Date.now() + '-' + lintReportSeq + '.json')
  }

  function takeLintReport(reportPath) {
    if (!reportPath) return null
    try {
      const text = readFileSync(reportPath, 'utf8')
      try { unlinkSync(reportPath) } catch { /* best-effort cleanup */ }
      return text
    } catch {
      return null
    }
  }

  // --- tool definitions ----------------------------------------------------

  return [
    {
      name: 'project_create',
      description: 'Create a new HarmonyOS application project through the official DevEco CLI (devecocli create). Scaffolds the standard template into a new/empty directory. Params: appName (required), optional projectPath, bundleName, apiLevel (>=17), deviceTypes (phone/tablet/2in1/car/wearable/tv; default phone). Returns {ok:true,projectPath,apiLevel,...} or {ok:false,error,hint}. Verifies the generated scaffold on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          appName: { type: 'string', description: 'Application name: starts with a letter, only letters/digits/underscores, max 200 chars (required).' },
          projectPath: { type: 'string', description: 'Absolute path or path relative to the current project root for the new project directory. Defaults to <project root>/<appName>. Must be empty or not yet existing; no spaces/Chinese characters; max 120 chars.' },
          bundleName: { type: 'string', description: 'Bundle name, e.g. com.example.myapp. Optional; defaults to com.example.<lowercase appName>.' },
          apiLevel: { type: 'integer', description: 'HarmonyOS API level (>=17, upper bound depends on local SDK). Omit to let devecocli auto-detect from the installed SDK.' },
          deviceTypes: {
            description: 'Device types: an array or a comma/space-separated string of phone, tablet, 2in1, car, wearable, tv. Defaults to ["phone"].',
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
          },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 120000)' },
        },
        required: ['appName'],
      },
      async execute(args) {
        args = args || {}
        const plan = planCreate(args, { workspaceRoot: getProjectRoot(), platform: process.platform })
        if (!plan.ok) return { ok: false, error: plan.error, hint: createErrorHint(plan.error, '') }

        const dest = checkDestination(plan.projectPath)
        if (!dest.ok) return { ok: false, error: dest.error, hint: createErrorHint(dest.error, plan.projectPath), projectPath: plan.projectPath }

        const cli = await ensureCli()
        if (!cli.ok) return { ok: false, backend: 'devecocli', error: cli.error || 'devecocli not found', hint: cli.hint || '安装官方 CLI 后即可创建工程：npm i -g @deveco/deveco-cli（需 DevEco Studio ≥ 6.1.0 或独立 Command Line Tools ≥ 26）。' }

        const timeoutMs = Number(args.timeoutMs) || 120000
        const argv = createArgv(plan, psQuote)
        const parent = join(plan.projectPath, '..')
        const r = await runCli(cli, argv, { timeoutMs, stdoutMaxBytes: 524288, workdir: parent })
        const output = tailText(compileOut.stripAnsi(((r.stdout || '') + '\n' + (r.stderr || '')).trim()), 8000)

        const okByMarker = String(r.stdout || '').includes(CREATE_OK_MARKER)
        if (!r.ok || !okByMarker) {
          const failure = output || ('devecocli create exited with code ' + r.exitCode + (r.timedOut ? ' (timed out)' : ''))
          return { ok: false, error: failure, output, exitCode: r.exitCode, timedOut: r.timedOut, backend: 'devecocli', hint: createErrorHint(failure, plan.projectPath), projectPath: plan.projectPath }
        }

        const scaffold = verifyScaffold(plan.projectPath)
        if (!scaffold.ok) {
          const failure = 'devecocli reported success but required scaffold files are missing: ' + scaffold.missing.join(', ') + ' in ' + plan.projectPath
          return { ok: false, error: failure, output, backend: 'devecocli', hint: createErrorHint(failure, plan.projectPath), projectPath: plan.projectPath }
        }

        const createdApi = parseCreatedApiLevel(output)
        return {
          ok: true,
          backend: 'devecocli',
          appName: plan.appName,
          projectPath: plan.projectPath,
          bundleName: plan.bundleName,
          apiLevel: createdApi != null ? createdApi : plan.apiLevel,
          deviceTypes: plan.deviceTypes,
          output,
          hint: createSuccessHint(plan.projectPath),
        }
      },
    },
    {
      name: 'hms_emulator',
      description: 'Control HarmonyOS emulators through the official DevEco CLI (devecocli emulator): list/start/stop/create/delete instances, and inject device states — battery level/status, GPS (geolocation), sensors (light/humidity/temperature/steps/heart-rate), motion scenes, shake, power, rotate, volume, fold. Requires @deveco/deveco-cli; degrades with install guidance when missing.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: list, start, stop, create, delete, shake, power, rotate, volume, fold, battery, geolocation, sensor, scene' },
          name: { type: 'string', description: 'Emulator instance name for start/create/delete' },
          target: { type: 'string', description: '--target <nameOrSerial> for state injections (battery/geolocation/sensor/scene/shake/power/rotate/volume/fold)' },
          level: { type: 'integer', description: 'Battery level 0-100 (action=battery)' },
          status: { type: 'string', description: 'Battery charging status: charging or discharging (action=battery)' },
          longitude: { type: 'string', description: 'GPS longitude (action=geolocation)' },
          latitude: { type: 'string', description: 'GPS latitude (action=geolocation)' },
          altitude: { type: 'string', description: 'GPS altitude (action=geolocation)' },
          direction: { type: 'string', description: 'GPS direction (action=geolocation)' },
          lightIntensity: { type: 'string', description: 'Ambient light intensity (action=sensor)' },
          humidity: { type: 'string', description: 'Ambient humidity (action=sensor)' },
          temperature: { type: 'string', description: 'Ambient temperature (action=sensor)' },
          steps: { type: 'string', description: 'Pedometer steps (action=sensor)' },
          heartRate: { type: 'string', description: 'Heart rate (action=sensor)' },
          rotateDir: { type: 'string', description: 'left or right (action=rotate)' },
          volumeDir: { type: 'string', description: 'up or down (action=volume)' },
          foldState: { type: 'string', description: 'Foldable display state (action=fold)' },
          sceneName: { type: 'string', description: 'outdoorRunning, outdoorCycling or drivingNavigation (action=scene)' },
          deviceType: { type: 'string', description: 'phone/tablet/foldable/... (action=create)' },
          osVersion: { type: 'string', description: 'System image API version (action=create)' },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 120000)' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const cli = await ensureCli()
        if (!cli.ok) {
          return { ok: false, backend: 'devecocli', error: cli.error, hint: '安装官方 CLI 后即可用模拟器控制（电量/GPS/传感器/摇一摇/折叠/运动场景）：npm i -g @deveco/deveco-cli（需 DevEco Studio ≥ 6.1.0 或独立 Command Line Tools ≥ 26，Linux 仅支持后者，并设 DEVECO_CLI_CLT_PATH）。' }
        }
        const q = (s) => (s === undefined || s === null ? '' : String(s).trim())
        const flag = (name, value) => (value ? [name, String(value)] : [])
        const tflag = () => flag('--target', q(args.target))
        const action = q(args.action)
        const timeoutMs = Number(args.timeoutMs) || 120000
        const run = async (argv) => {
          const r = await runCli(cli, argv, { timeoutMs, stdoutMaxBytes: 524288 })
          const out = (r.stdout || '') + '\n' + (r.stderr || '')
          return { ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut === true, output: tailText(out.trim(), 4000), error: r.exitCode === 0 ? '' : tailText((r.stderr || r.stdout || '').trim(), 1500) }
        }
        const isEmulatorTarget = (id) => /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(String(id || '')) || /emulator/i.test(String(id || ''))
        const pollEmulatorRunning = async (name, waitMs) => {
          const deadline = Date.now() + Math.max(Number(waitMs) || 0, 5000)
          while (Date.now() < deadline) {
            try {
              await ensureHdc()
              const list = await listTargets()
              const hit = list.targets.find((t) => /connected/i.test(t.state) && isEmulatorTarget(t.id))
              if (hit) return { running: true, target: hit.id, method: 'hdc' }
            } catch { /* keep polling */ }
            try {
              const r = await runCli(cli, ['emulator', 'list', '--format', 'json'], { timeoutMs: 30000, stdoutMaxBytes: 524288, mergeStderr: true })
              const instances = tryParseJson((r.stdout || '').trim())
              if (Array.isArray(instances)) {
                const hit = instances.find((i) =>
                  String(i.name || '').trim() === name &&
                  (/connected|running|started/i.test(String(i.status || i.state || '')) || /true/i.test(String(i.isRunning || ''))))
                if (hit) return { running: true, target: hit.name || '', method: 'devecocli' }
              }
            } catch { /* keep polling */ }
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
          return { running: false, target: '' }
        }
        const argv = ['emulator']
        if (action === 'list') {
          let r = await runCli(cli, ['emulator', 'list', '--format', 'json'], { timeoutMs: 60000, stdoutMaxBytes: 524288 })
          let json = tryParseJson((r.stdout || '').trim())
          let text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim()
          if (r.exitCode === 0 && !r.timedOut && !mojoFatal(r) && !text) {
            r = await runCli(cli, ['emulator', 'list', '--format', 'json'], { timeoutMs: 60000, stdoutMaxBytes: 524288 })
            json = tryParseJson((r.stdout || '').trim())
            text = ((r.stdout || '') + '\n' + (r.stderr || '')).trim()
          }
          if (json == null) {
            const plain = await runCli(cli, ['emulator', 'list'], { timeoutMs: 60000, stdoutMaxBytes: 524288, mergeStderr: true })
            const plainText = ((plain.stdout || '') + '\n' + (plain.stderr || '')).trim()
            if (plainText) {
              r = { ...plain, stdout: plainText, stderr: '' }
              text = plainText
            }
          }
          // hdc cross-check: hdc is the authority on live links — surface it on
          // every list so callers can tell "no emulators" from "channel dead".
          let hdcConnected = []
          try {
            await ensureHdc()
            const list = await listTargets()
            hdcConnected = list.targets.filter((t) => /connected/i.test(t.state)).map((t) => t.id)
          } catch { /* best effort */ }
          const hdcNote = hdcConnected.length ? ' hdc sees connected target(s): ' + hdcConnected.join(', ') + ' — trust hdc_list_targets for the live link.' : ''
          const likely = hdcConnected.filter(isEmulatorTarget)
          const hdcBackfilled = (json == null || (Array.isArray(json) && json.length === 0)) && likely.length > 0
          const instances = hdcBackfilled ? likely.map((id) => ({ name: id, isRunning: true, source: 'hdc' })) : json
          const output = hdcBackfilled
            ? ((text && !/No emulator instances found/i.test(text) ? text : JSON.stringify(instances, null, 2)) + hdcNote)
            : (text || (Array.isArray(json) && json.length ? JSON.stringify(json, null, 2) : 'No emulator instances found.'))
          const ok = (r.exitCode === 0 && !r.timedOut && !mojoFatal(r) && (json != null || !!text)) || hdcBackfilled
          const error = !ok
            ? (mojoFatal(r)
              ? 'devecocli mojo platform channel failed (0x5) — emulator list needs a normal user session' + hdcNote
              : (text ? text + hdcNote : 'devecocli emulator list returned empty output — the CLI may need auth (devecocli auth login) or a newer version.' + hdcNote))
            : ''
          return { ok, backend: 'devecocli', instances, hdcConnected, hdcBackfilled, output: tailText(output, 8000), error }
        }
        if (action === 'start') {
          if (!q(args.name)) return { ok: false, error: 'name is required for start' }
          argv.push('start', q(args.name))
          const res = await run(argv)
          if (!res.ok) return res
          const poll = await pollEmulatorRunning(q(args.name), Math.min(timeoutMs, 180000))
          if (poll.running) {
            return { ...res, running: true, target: poll.target, verifiedBy: poll.method, output: tailText((res.output + '\nEmulator is running (verified by ' + poll.method + ').').trim(), 4000) }
          }
          return { ...res, ok: res.ok && poll.running, running: false, target: poll.target, verifiedBy: poll.method || '', error: 'devecocli start returned success but no running emulator appeared in hdc list targets within ' + Math.round((Math.min(timeoutMs, 180000)) / 1000) + 's' }
        } else if (action === 'stop') {
          argv.push('stop', ...tflag())
        } else if (action === 'create') {
          if (!q(args.name) || !q(args.deviceType)) return { ok: false, error: 'name and deviceType are required for create' }
          argv.push('create', q(args.name), '--device-type', q(args.deviceType), ...flag('--os-version', q(args.osVersion)))
        } else if (action === 'delete') {
          if (!q(args.name)) return { ok: false, error: 'name is required for delete' }
          argv.push('delete', q(args.name))
        } else if (action === 'shake' || action === 'power') {
          argv.push(action, ...tflag())
        } else if (action === 'rotate') {
          argv.push('rotate', q(args.rotateDir) || 'left', ...tflag())
        } else if (action === 'volume') {
          argv.push('volume', q(args.volumeDir) || 'up', ...tflag())
        } else if (action === 'fold') {
          if (!q(args.foldState)) return { ok: false, error: 'foldState is required for fold' }
          argv.push('fold', q(args.foldState), ...tflag())
        } else if (action === 'battery') {
          if (!q(args.target)) return { ok: false, error: 'target is required for battery' }
          argv.push('battery', ...tflag(), ...flag('--level', args.level), ...flag('--status', q(args.status)))
        } else if (action === 'geolocation') {
          if (!q(args.target)) return { ok: false, error: 'target is required for geolocation' }
          argv.push('geolocation', ...tflag(), ...flag('--longitude', q(args.longitude)), ...flag('--latitude', q(args.latitude)), ...flag('--altitude', q(args.altitude)), ...flag('--direction', q(args.direction)))
        } else if (action === 'sensor') {
          if (!q(args.target)) return { ok: false, error: 'target is required for sensor' }
          argv.push('sensor', ...tflag(), ...flag('--light-intensity', q(args.lightIntensity)), ...flag('--humidity', q(args.humidity)), ...flag('--temperature', q(args.temperature)), ...flag('--steps', q(args.steps)), ...flag('--heartrate', q(args.heartRate)))
        } else if (action === 'scene') {
          if (!q(args.sceneName)) return { ok: false, error: 'sceneName is required for scene' }
          argv.push('scene', q(args.sceneName), ...tflag())
        } else {
          return { ok: false, error: 'unknown action: ' + action }
        }
        return run(argv)
      },
    },

    {
      name: 'hms_setup',
      description: 'HarmonyOS toolchain doctor: hdc, DevEco Studio (version), SDK (API version), the optional devecocli backend, connected devices, and the resolved target API version across project/device/SDK. Run this first when any tool reports not-found, a version mismatch, or missing signing.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: doctor (default), paths' },
          devecoPath: { type: 'string', description: 'Optional explicit DevEco Studio install root (overrides auto-detection)' },
          sdkPath: { type: 'string', description: 'Optional explicit SDK root, e.g. C:\\Huawei\\DevEco Studio\\sdk (overrides auto-detection and DEVECO_SDK_HOME)' },
          projectPath: { type: 'string', description: 'Optional HarmonyOS project root (defaults to the current project root)' },
        },
        required: [],
      },
      async execute(args) {
        args = args || {}
        const overrides = { devecoPath: args.devecoPath, sdkPath: args.sdkPath }
        if (args.action === 'paths') {
          const discovery = studio.discoverStudioRoots(overrides.devecoPath ? [overrides.devecoPath] : [])
          return {
            hdcCandidates: rt.candidateList(),
            studioRoots: discovery.roots,
            studioRegistryPaths: discovery.registryPaths,
            envDevEcoSdkHome: (typeof process !== 'undefined' && process.env && process.env.DEVECO_SDK_HOME) || '',
            envCliCltPath: (typeof process !== 'undefined' && process.env && process.env.DEVECO_CLI_CLT_PATH) || '',
            envCommandLineToolPath: (typeof process !== 'undefined' && process.env && process.env.COMMAND_LINE_TOOL_PATH) || '',
          }
        }
        await ensureHdc()
        const st = getStudio(overrides)
        const clt = getClt()
        const sdk = getSdk(overrides)
        const cli = await ensureCli()
        const targets = hdcPathRef() ? (await listTargets()).targets : []
        const hvigor = toolchainHvigor()
        const target = await resolveTarget({ explicit: null, projectPath: args.projectPath, overrides })
        const out = {
          hdc: hdcPathRef() ? { found: true, path: hdcPathRef() } : { found: false, error: hdcErrorRef() },
          devecoStudio: st.ok ? { found: true, root: st.root, version: st.version, sources: st.sources || [] } : { found: false, error: st.error },
          commandLineTools: clt.ok
            ? { found: true, root: clt.root, version: clt.version, apiVersion: clt.apiVersion || 0, layout: clt.layout || '' }
            : { found: false, error: clt.error },
          toolchainKind: (clt.ok && rt.cltIsExplicit()) ? 'clt' : (st.ok ? 'studio' : (clt.ok ? 'clt' : 'none')),
          sdk: sdk.ok ? { found: true, root: sdk.sdkRoot, flavor: sdk.flavor, apiVersion: sdk.apiVersion, sdkVersion: sdk.sdkVersion } : { found: false, error: sdk.error },
          devecocli: cli.ok ? { found: true, kind: cli.kind, version: cli.version } : { found: false, error: cli.error },
          hvigorFallback: hvigor.ok ? { found: true, path: hvigor.path } : { found: false },
          devices: targets,
          projectRoot: getProjectRoot(),
          targetApi: {
            value: target.resolved.api,
            source: target.resolved.source,
            sources: target.resolved.sources,
            mismatches: target.resolved.mismatches,
            projectDir: target.projectDir,
            deviceError: target.deviceError,
          },
        }
        const recs = []
        if (!hdcPathRef()) recs.push('hdc missing: install DevEco Studio or put hdc on PATH (all hdc_* tools need it).')
        if (!st.ok && !clt.ok) recs.push('No Huawei toolchain detected. Either DevEco Studio (>= 6.1.0 recommended): https://developer.huawei.com/consumer/cn/deveco-studio/ — or the standalone Command Line Tools (>= 26.0.0, also the only option on Linux): https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos and set DEVECO_CLI_CLT_PATH.')
        if (!sdk.ok) recs.push('SDK not detected; hms_api needs it. Set DEVECO_SDK_HOME or pass sdkPath.')
        if (!cli.ok) recs.push(cli.error)
        if (cli.ok && !featureGate(6, 1)) recs.push('The detected toolchain is below the --format json feature level (Studio >= 6.1.0 / Command Line Tools >= 26.0.0); update it to enable JSON outputs.')
        if (hdcPathRef() && targets.length === 0) recs.push('No device connected. Emulator: hdc_connect 127.0.0.1:5555; physical device: enable USB debugging.')
        if (target.resolved.mismatches.length) recs.push('Version mismatch: ' + target.resolved.mismatches.join('; ') + '. Use hms_api_change action=diff to list breaking changes.')
        out.recommendations = recs
        return out
      },
    },

    {
      name: 'hms_build',
      description: 'Build/sign/run a HarmonyOS project through the official DevEco CLI (devecocli) when available, with automatic fallback to the local hvigorw build and the hdc_install/hdc_app loop. Actions: status, build, run, sign, clean. Signing requires a one-time browser OAuth (devecocli auth login) plus a connected device.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: status, build, run, sign, clean' },
          projectPath: { type: 'string', description: 'Optional project root (defaults to the current project root)' },
          modules: { type: 'string', description: 'Optional space-separated module names for build (devecocli build --modules m1 m2@target)' },
          product: { type: 'string', description: 'Optional product name (default "default")' },
          buildMode: { type: 'string', description: 'Optional build mode (default "debug"; e.g. "release")' },
          module: { type: 'string', description: 'Optional single module for run (defaults to the auto-selected runnable one)' },
          device: { type: 'string', description: 'Optional device name/serial for run (required when several devices are connected)' },
          skipBuild: { type: 'boolean', description: 'For run: deploy existing artifacts without rebuilding' },
          uninstall: { type: 'boolean', description: 'For run: uninstall the app first (fixes signing-key changes)' },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 600000)' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const timeoutMs = Number(args.timeoutMs) || 600000
        const st = getStudio()
        const sdk = getSdk()
        const cli = await ensureCli()
        const q = (s) => (s === undefined || s === null ? '' : String(s).trim())
        if (args.action === 'status') {
          const hvigor = toolchainHvigor()
          const clt = getClt()
          return {
            devecocli: cli.ok ? { found: true, kind: cli.kind, version: cli.version } : { found: false, error: cli.error },
            devecoStudio: st.ok ? { found: true, version: st.version } : { found: false, error: st.error },
            commandLineTools: clt.ok ? { found: true, root: clt.root, version: clt.version } : { found: false },
            sdk: sdk.ok ? { apiVersion: sdk.apiVersion, root: sdk.sdkRoot } : { error: sdk.error },
            hvigorFallback: hvigor.ok ? { found: true, path: hvigor.path, kind: hvigor.kind } : { found: false },
            backend: cli.ok ? 'devecocli' : (hvigor.ok && sdk.ok ? 'hvigorw' : 'none'),
          }
        }
        if (args.action === 'build' || args.action === 'clean') {
          const base = q(args.projectPath) || getProjectRoot()
          const hapBefore = await findNewestHap(base)
          const argv = ['build']
          if (args.action === 'clean') argv.push('clean')
          if (q(args.modules)) argv.push('--modules', ...q(args.modules).split(/\s+/).map((m) => psQuote(m)))
          if (q(args.product)) argv.push('--product', psQuote(q(args.product)))
          if (q(args.buildMode)) argv.push('--build-mode', psQuote(q(args.buildMode)))
          let deOutput = ''
          let deMojo = false
          let deExit = 0
          if (cli.ok) {
            const r = await runCli(cli, argv, { timeoutMs, stdoutMaxBytes: 1048576, workdir: base })
            deMojo = mojoFatal(r)
            deExit = r.exitCode
            deOutput = tailText(compileOut.stripAnsi((r.stdout + '\n' + r.stderr).trim()), 8000)
            if (buildResultOk(r) && !deMojo) {
              const hapAfter = await findNewestHap(base)
              const artifactVerified = args.action === 'clean' ? !hapAfter : Boolean(hapAfter)
              if (artifactVerified) {
                return { backend: 'devecocli', ok: true, exitCode: deExit, timedOut: r.timedOut, output: compileOut.stripAnsi(deOutput), artifactVerified, hapBefore: hapBefore || '', hapAfter: hapAfter || '', ...hvigorDiag(null) }
              }
              deOutput += '\n\ndevecocli returned success but artifact state was not verified; using hvigor fallback.'
            }
          }
          const fb = await hvigorDirectBuild({ base, product: q(args.product) || 'default', mode: q(args.buildMode) || 'debug', timeoutMs, task: args.action === 'clean' ? 'clean' : 'assembleHap' })
          if (fb.available && fb.ok) {
            const hapAfter = await findNewestHap(base)
            const artifactVerified = args.action === 'clean' ? !hapAfter : Boolean(hapAfter)
            if (artifactVerified) {
              return { backend: 'hvigorw', ok: true, exitCode: fb.exitCode, timedOut: fb.timedOut, output: compileOut.stripAnsi(fb.output), artifactVerified, hapBefore: hapBefore || '', hapAfter: hapAfter || '', ...hvigorDiag(fb), note2: (deMojo ? 'devecocli channel failed (mojo 0x5) — fell back to the direct hvigorw build. ' : 'devecocli failed — used the direct hvigorw build. ') + 'hvigorw uses the signingConfigs already present in build-profile.json5; unsigned builds cannot install on a device.' }
            }
            return { backend: 'hvigorw', ok: false, exitCode: fb.exitCode, timedOut: fb.timedOut, output: compileOut.stripAnsi(fb.output), error: args.action === 'clean' ? 'hvigorw reported success but build outputs were not cleaned' : 'hvigorw reported success but no .hap artifact was produced', hapBefore: hapBefore || '', hapAfter: hapAfter || '', ...hvigorDiag(fb) }
          }
          return { backend: 'hvigorw', ok: false, exitCode: fb.available ? fb.exitCode : deExit, timedOut: fb.timedOut === true, output: compileOut.stripAnsi((deOutput ? deOutput + '\n\n' : '') + (fb.available ? 'hvigorw fallback also failed:\n' + fb.output : 'hvigorw fallback unavailable: ' + fb.error)), error: fb.available ? 'hvigorw build failed' : fb.error, ...hvigorDiag(fb) }
        }
        if (args.action === 'run') {
          const base = q(args.projectPath) || getProjectRoot()
          let deRunNote = ''
          if (cli.ok) {
            const argv = ['run']
            if (q(args.module)) argv.push('--module', psQuote(q(args.module)))
            if (q(args.device)) argv.push('--device', psQuote(q(args.device)))
            if (args.skipBuild) argv.push('--skip-build')
            if (args.uninstall) argv.push('--uninstall')
            const r = await runCli(cli, argv, { timeoutMs, stdoutMaxBytes: 1048576, workdir: base })
            const mojo = mojoFatal(r)
            if (buildResultOk(r) && !mojo) {
              const app = await readBundleAndAbility(base)
              await ensureHdc()
              const current = app.bundle ? await currentTarget(args.device) : { target: '', error: 'bundle name unavailable' }
              const mission = !current.error && app.bundle ? await verifyAbilityStarted(app.bundle, current.target) : { ok: false, error: current.error || 'bundle name unavailable' }
              if (mission.ok) {
                return { backend: 'devecocli', ok: true, exitCode: r.exitCode, timedOut: r.timedOut, missionVerified: true, target: current.target, bundleName: app.bundle, output: tailText((r.stdout + '\n' + r.stderr).trim(), 8000) }
              }
              deRunNote = 'devecocli run returned success but mission verification failed; using the fallback loop. '
            } else {
              deRunNote = mojo ? 'devecocli run channel failed (mojo 0x5) — using the fallback loop. ' : 'devecocli run failed or returned no output — using the fallback loop. '
            }
          }
          // Fallback loop: hvigorw build -> newest .hap -> hdc install -> aa start
          if (!base) return { backend: 'none', ok: false, error: cli.error + ' No project root for the fallback loop.' }
          const fb = await hvigorDirectBuild({ base, product: q(args.product) || 'default', mode: q(args.buildMode) || 'debug', timeoutMs })
          if (!fb.available || !fb.ok) return { backend: 'hvigorw', ok: false, stage: 'build', output: fb.available ? compileOut.stripAnsi(fb.output) : '', error: fb.available ? 'hvigorw build failed' : fb.error, ...hvigorDiag(fb) }
          const hap = await findNewestHap(base)
          if (!hap) return { backend: 'hvigorw', ok: false, stage: 'hap', error: 'build produced no .hap under ' + base, ...hvigorDiag(fb) }
          await ensureHdc()
          if (!hdcPathRef()) return { backend: 'hvigorw', ok: false, stage: 'install', hap, error: hdcErrorRef(), ...hvigorDiag(fb) }
          const inst = await services.install({ hapPath: hap, target: q(args.device) || undefined })
          if (!inst.ok) return { backend: 'hvigorw', ok: false, stage: 'install', hap, error: inst.error || inst.hint, ...hvigorDiag(fb) }
          let bundleName = ''
          try {
            const appJson = join(base, 'AppScope', 'app.json5')
            if (existsSync(appJson)) {
              const m = /["']bundleName["']\s*:\s*["']([^"']+)["']/.exec(readFileSync(appJson, 'utf8'))
              if (m) bundleName = m[1]
            }
          } catch { /* bundleName stays empty */ }
          if (bundleName) {
            const started = await services.appAction({ action: 'start', bundleName, target: q(args.device) || undefined })
            const current = await currentTarget(args.device)
            const mission = started.ok && !current.error ? await verifyAbilityStarted(bundleName, current.target) : { ok: false, error: current.error || 'aa start failed' }
            return { backend: 'hvigorw', ok: started.ok && mission.ok, stage: 'start', hap, bundleName, target: current.target, start: { ok: started.ok, hint: started.hint }, missionVerified: Boolean(mission.ok), ...hvigorDiag(fb), note: deRunNote + 'Fallback loop: hvigorw build -> hdc install -> aa start.' }
          }
          return { backend: 'hvigorw', ok: false, stage: 'installed', hap, missionVerified: false, ...hvigorDiag(fb), error: 'Installed, but bundleName could not be read from AppScope/app.json5; app was not started.', note: deRunNote + 'Installed; bundleName could not be read from AppScope/app.json5 — start it with hdc_app action=start bundleName=<from AppScope/app.json5>.' }
        }
        if (args.action === 'sign') {
          if (!cli.ok) return { backend: 'none', ok: false, error: cli.error }
          // Sign must WRITE build-profile.json5 (signingConfigs/products). A
          // channel that silently dies leaves the file untouched — snapshot it
          // and require a real change, the same artifact-verification pattern
          // as build.
          const base = q(args.projectPath) || getProjectRoot()
          const profilePath = base ? join(base, 'build-profile.json5') : ''
          const beforeM = statMtimeMs(profilePath)
          let beforeText = ''
          if (profilePath) {
            try { beforeText = readFileSync(profilePath, 'utf8') } catch { /* absent — signing should create it */ }
          }
          const status = await runCli(cli, ['auth', 'status'], { timeoutMs: 30000, stdoutMaxBytes: 16384, workdir: base })
          if (mojoFatal(status)) {
            return { backend: 'devecocli', ok: false, stage: 'auth', error: 'devecocli mojo platform channel failed (0x5) — sign needs a normal user session' }
          }
          const authOut = (status.stdout + status.stderr).trim()
          if (!authOut) {
            return { backend: 'devecocli', ok: false, stage: 'auth', emptyOutput: true, error: 'devecocli auth status returned no output — the CLI could not reach its backend, so the login state cannot be verified and signature generation would silently do nothing. Run devecocli auth login in a host terminal, or sign in DevEco Studio (Project Structure > Signing Configs).' }
          }
          const loggedIn = status.ok && !/not logged|未登录|not log in/i.test(authOut)
          if (!loggedIn) {
            return { backend: 'devecocli', ok: false, stage: 'auth', error: 'Not logged in. Run once in a terminal: devecocli auth login (browser OAuth), then retry. A connected device is also required for device registration.' }
          }
          const argv = ['signature', 'generate']
          if (q(args.product)) argv.push('--product', psQuote(q(args.product)))
          const r = await runCli(cli, argv, { timeoutMs, stdoutMaxBytes: 262144, workdir: base })
          const mojo = mojoFatal(r)
          const out = (r.stdout + '\n' + r.stderr).trim()
          const empty = !out
          const afterM = statMtimeMs(profilePath)
          let afterText = ''
          if (profilePath) {
            try { afterText = readFileSync(profilePath, 'utf8') } catch { /* still absent */ }
          }
          const profileChanged = afterM !== beforeM || afterText !== beforeText
          const ok = r.ok && !mojo && !empty && profileChanged
          const error = ok
            ? ''
            : (mojo ? 'devecocli mojo platform channel failed (0x5) — sign needs a normal user session'
              : (empty ? 'devecocli signature generate returned no output — the channel died before signing ran. Sign in DevEco Studio (Project Structure > Signing Configs) or run devecocli auth login + signature generate in a host terminal.'
                : (!profileChanged ? 'devecocli reported success but build-profile.json5 was NOT updated — no signing materials were written (missing local signing materials or a silent failure). Check ~/.ohos/config for auto-sign materials, run devecocli auth login in a host terminal, or sign in DevEco Studio.'
                  : (r.stderr || r.stdout))))
          return { backend: 'devecocli', ok, exitCode: r.exitCode, emptyOutput: empty, profileChanged, output: tailText(out, 6000), error, hint: ok ? 'signingConfigs/products were written to build-profile.json5; then hms_build action=build.' : '' }
        }
        return { ok: false, error: 'unknown action: ' + args.action }
      },
    },

    {
      name: 'hms_lint',
      description: 'Official ArkTS lint: rules lists the 57+ built-in DevEco codelinter rule docs from the local install (Apache-2.0, read locally); read-rule returns one rule doc; check runs devecocli check lint (official ArkTS checks, --format json needs DevEco Studio >= 6.1.0).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: rules, read-rule, check' },
          rule: { type: 'string', description: 'Rule id for read-rule (from action=rules)' },
          lang: { type: 'string', description: 'Rule doc language: cn (default) or en' },
          path: { type: 'string', description: 'File or directory to lint for action=check (defaults to the project root)' },
          fix: { type: 'boolean', description: 'For check: apply auto-fixes' },
          limit: { type: 'integer', description: 'For rules/check: max records shown (default all rules / devecocli default 100)' },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 300000)' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        // codelinter rule docs: the DevEco Studio bundle layout first; when only
        // a standalone Command Line Tools exists, probe both plausible CLT
        // layouts (Huawei does not document the inner tree as stable).
        function codelinterBase() {
          const st2 = getStudio()
          if (st2.ok) return { ok: true, root: st2.root, pluginsDir: '' }
          const clt2 = getClt()
          if (!clt2.ok) return { ok: false, error: st2.error || clt2.error }
          try {
            if (existsSync(join(clt2.root, 'plugins', 'codelinter'))) return { ok: true, root: clt2.root, pluginsDir: '' }
            if (existsSync(join(clt2.root, 'codelinter', 'plugins'))) return { ok: true, root: clt2.root, pluginsDir: join(clt2.root, 'codelinter', 'plugins') }
          } catch { /* fall through */ }
          return { ok: false, error: 'codelinter rule docs not found in this Command Line Tools layout; action=rules currently maps the DevEco Studio bundle layout only.' }
        }
        if (args.action === 'rules') {
          const base = codelinterBase()
          if (!base.ok) return { ok: false, error: base.error }
          const rules = studio.listCodelinterRules(base.root, base.pluginsDir)
          if (!rules.ok) return rules
          const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 200
          return { ok: true, count: rules.rules.length, shown: Math.min(rules.rules.length, limit), docsDir: rules.docsDir, rules: rules.rules.slice(0, limit), license: 'Apache-2.0 (Copyright (c) 2024 Huawei Device Co., Ltd.) — read from the local DevEco Studio install, never redistributed.' }
        }
        if (args.action === 'read-rule') {
          const base = codelinterBase()
          if (!base.ok) return { ok: false, error: base.error }
          const doc = studio.readRuleDoc(base.root, args.rule || '', args.lang === 'en' ? 'en' : 'cn', base.pluginsDir)
          if (!doc.ok) return doc
          return { ok: true, rule: args.rule, lang: args.lang === 'en' ? 'en' : 'cn', content: doc.text }
        }
        if (args.action === 'check') {
          const cli = await ensureCli()
          if (!cli.ok) return { ok: false, error: cli.error, fallback: 'hms_lint action=rules still works locally; review rules manually.' }
          const jsonOk = featureGate(6, 1)
          const argv = ['check', 'lint']
          if (args.path && String(args.path).trim()) argv.push(psQuote(String(args.path).trim()))
          const reportPath = jsonOk ? lintReportPath() : ''
          if (jsonOk) argv.push('--format', 'json')
          // --limit only shapes the terminal listing, which the CLI skips once
          // the full report goes to --output-path.
          if (reportPath) argv.push('--output-path', psQuote(reportPath))
          if (args.fix) argv.push('--fix')
          if (Number(args.limit) > 0 && !reportPath) argv.push('--limit', String(Math.min(Number(args.limit), 500)))
          const r = await runCli(cli, argv, { timeoutMs: Number(args.timeoutMs) || 300000, stdoutMaxBytes: 1048576 })
          const reportText = takeLintReport(reportPath)
          const fromReport = reportText != null ? tryParseJson(reportText.trim()) : null
          // Older CLIs printed the JSON report on stdout; that path still works.
          const fromStdout = jsonOk ? tryParseJson(r.stdout.trim()) : null
          const json = fromReport != null ? fromReport : fromStdout
          const mojo = mojoFatal(r)
          const missingJson = jsonOk && json == null
          const hasOutput = (r.stdout + '\n' + r.stderr).trim().length > 0
          const ok = !r.timedOut && !mojo && !missingJson && (json != null || (hasOutput && (r.exitCode === 0 || LINT_REPORT_RE.test(r.stdout + r.stderr))))
          const filesChecked = json && json.summary && Number.isFinite(Number(json.summary.filesChecked)) ? Number(json.summary.filesChecked) : null
          const emptyScope = ok && filesChecked === 0
          const missingJsonError = missingJson
            ? 'devecocli lint returned no JSON report' + (reportPath ? ' (expected at ' + reportPath + ')' : '') + '. Use action=rules to review rules manually.'
            : ''
          return {
            backend: 'devecocli',
            ok,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            mojoFatal: mojo,
            emptyResult: missingJson,
            format: jsonOk ? 'json' : 'text',
            result: json != null ? json : null,
            filesChecked,
            output: json != null ? '' : tailText((r.stdout + '\n' + r.stderr).trim(), 8000),
            note: emptyScope ? 'The report lists 0 files checked: this run inspected no source file. Verify the lint path and the project code-linter.json5 files glob before trusting a clean result.' : '',
            error: ok ? '' : (mojo ? 'devecocli mojo platform channel failed (0x5) — lint check needs a normal user session' : (missingJson ? missingJsonError : (r.stderr || r.stdout))),
          }
        }
        return { ok: false, error: 'unknown action: ' + args.action }
      },
    },

    {
      name: 'hms_api',
      description: 'Official-first, version-classified API knowledge from the local HarmonyOS SDK .d.ts: every entry carries @since/@deprecated/@syscap tags. Actions: modules (list SDK modules), lookup (declarations of a module/member classified against the target API version), snippet (raw declaration text).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: modules, lookup, snippet' },
          module: { type: 'string', description: 'Module name for lookup/snippet, e.g. @ohos.promptAction (use action=modules to list)' },
          name: { type: 'string', description: 'Optional exported member name to filter for lookup/snippet' },
          filter: { type: 'string', description: 'Optional substring filter for action=modules' },
          targetApi: { type: 'integer', description: 'Optional explicit target API version; defaults to project compatibleSdkVersion > device > SDK' },
          projectPath: { type: 'string', description: 'Optional project root for target resolution (defaults to the current project root)' },
          devecoPath: { type: 'string', description: 'Optional explicit DevEco Studio install root' },
          sdkPath: { type: 'string', description: 'Optional explicit SDK root' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const overrides = { devecoPath: args.devecoPath, sdkPath: args.sdkPath }
        const sdk = getSdk(overrides)
        if (!sdk.ok) return { ok: false, error: sdk.error }
        if (args.action === 'modules') {
          const all = sdkDts.listModules(sdk.apiDir)
          const filter = String(args.filter || '').toLowerCase()
          const hit = filter ? all.filter((m) => m.toLowerCase().includes(filter)) : all
          return { ok: true, total: hit.length, shown: hit.slice(0, 80), truncated: hit.length > 80, filter: filter || '', sdkApiVersion: sdk.apiVersion, note: 'Local SDK read (Apache-2.0, never redistributed).' }
        }
        const moduleName = String(args.module || '').trim()
        if (!moduleName) return { ok: false, error: 'module is required for action=lookup/snippet (e.g. @ohos.promptAction)' }
        const read = sdkDts.readModule(sdk.apiDir, moduleName)
        if (!read.ok) return read
        if (args.action === 'snippet') {
          const windows = sdkDts.snippetFor(read.text, args.name ? String(args.name) : 'export', args.name ? 40 : 25)
          return { ok: true, module: moduleName, name: args.name || '', windows: windows.map((w) => ({ start: w.start, text: w.text.slice(0, 2400) })), source: read.file, sdkApiVersion: sdk.apiVersion }
        }
        let targetApi = null
        if (Number.isInteger(args.targetApi)) {
          targetApi = args.targetApi
        } else {
          const target = await resolveTarget({ explicit: null, projectPath: args.projectPath, overrides })
          targetApi = target.resolved.api
        }
        const result = sdkDts.queryModule(read.text, args.name ? String(args.name) : '', targetApi, sdk.apiVersion)
        return { ...result, module: moduleName, targetApi, file: read.file, sdkApiVersion: sdk.apiVersion }
      },
    },

    {
      name: 'hms_knowledge',
      description: 'Official knowledge (zh-CN): the Huawei official developer-knowledge MCP (official-search/official-read, anonymous, RAG search + full Markdown docs) is the primary source; bundled offline excerpts work without network; read/search auto-extend with an on-demand Gitee (openharmony/docs) remote layer cached under ~/.dsh-hdc-mcp/knowledge-remote. Actions: official-search (RAG search of the official Huawei KMS), official-read (full doc by name from official-search), catalog (list bundled topics), read (topic TOC, then a section by name/index; id= reads bundled, path= reads any repo doc — cached or fetched live), search (keywords over bundled topics AND the remote cache), ls (list a Gitee docs directory), sync (fetch a directory of docs into the cache), cache (cache stats), rm (remove a cached doc).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: official-search, official-read, catalog, read, search, ls, sync, cache, rm' },
          query: { type: 'string', description: 'Query string for official-search (natural language, e.g. "UIAbility 生命周期")' },
          topK: { type: 'integer', description: 'Max results for official-search (default 5, max 20)' },
          name: { type: 'string', description: 'Document name for official-read (from official-search results; comma/space-separated for up to 10)' },
          id: { type: 'string', description: 'Bundled topic id for read (from catalog/search)' },
          path: { type: 'string', description: 'Repo-relative doc path for read/rm (e.g. zh-cn/application-dev/dfx/hilog.md; the zh-cn/application-dev/ prefix may be omitted)' },
          section: { type: 'string', description: 'Optional section for read: a heading name substring or its 1-based TOC index; omit to get the TOC plus the intro' },
          keywords: { type: 'string', description: 'Space-separated keywords for search (bundled titles/tags/headings + remote cache paths/headings)' },
          limit: { type: 'integer', description: 'Max results for search (default 6, max 20)' },
          dir: { type: 'string', description: 'Repo-relative directory for ls/sync (e.g. zh-cn/application-dev/dfx)' },
          count: { type: 'integer', description: 'For sync: max files to fetch (default 20, cap 200); already-cached files are skipped' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        if (args.action === 'ls') return knowledgeRemote.listRemote(args.dir)
        if (args.action === 'official-search') return knowledgeRemote.officialSearch(args.query, args.topK)
        if (args.action === 'official-read') return knowledgeRemote.officialRead(args.name)
        if (args.action === 'sync') return knowledgeRemote.syncRemote(args.dir, args.count)
        if (args.action === 'cache') return knowledgeRemote.cacheStats()
        if (args.action === 'rm') return knowledgeRemote.removeRemote(args.path)
        if (args.action === 'read' && String(args.path || '').trim() && !String(args.id || '').trim()) {
          return knowledgeRemote.readRemote(args.path, args.section == null ? '' : String(args.section))
        }
        if (!knowledge.available()) {
          if (args.action === 'read' && String(args.path || '').trim()) return knowledgeRemote.readRemote(args.path, args.section == null ? '' : String(args.section))
          return { ok: false, error: 'bundled knowledge layer not found in this installation', fallback: 'Use hms_api for local SDK .d.ts lookups; action=read with path= still works via the Gitee remote layer, or hms_docs via devecocli for the full official docs.' }
        }
        if (args.action === 'catalog') return knowledge.catalog(args.filter, args.kind)
        if (args.action === 'read') {
          const id = String(args.id || '').trim()
          if (!id) return { ok: false, error: 'id is required for read (list ids with action=catalog), or pass path= for any OpenHarmony docs file' }
          return knowledge.read(id, args.section == null ? '' : String(args.section))
        }
        if (args.action === 'search') {
          const kws = String(args.keywords || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
          if (kws.length === 0) return { ok: false, error: 'keywords are required for search' }
          const lim = Number(args.limit) > 0 ? Math.min(Number(args.limit), 20) : 6
          // Official KMS MCP first (primary source); fall back gracefully to
          // the bundled + Gitee-cache merge when the service is unreachable.
          const official = await knowledgeRemote.officialSearch(kws.join(' '), lim).catch(() => null)
          const merged = knowledgeRemote.searchUnified(kws, lim, knowledge.search)
          const results = [
            ...(official && official.ok ? official.results : []),
            ...(merged.bundled ? merged.bundled.results.map((r) => ({ ...r, tier: 'bundled' })) : []),
            ...merged.remote,
          ]
          return {
            ok: results.length > 0,
            keywords: kws,
            total: results.length,
            officialTotal: official && official.ok ? official.results.length : 0,
            bundledTotal: merged.bundled ? merged.bundled.total : 0,
            remoteTotal: merged.remote.length,
            officialSource: knowledgeRemote.OFFICIAL_MCP_URL,
            remoteSource: knowledgeRemote.REMOTE_SOURCE,
            results,
            note: 'tier=official rows use action=official-read with name=; tier=bundled rows use action=read with id=; tier=remote rows use action=read with path=. Discover more remote paths with action=ls.',
          }
        }
        return { ok: false, error: 'unknown action: ' + args.action }
      },
    },

    {
      name: 'hms_docs',
      description: 'Search and read the official local HarmonyOS docs through devecocli docs (search/read/catalog). Official-first documentation knowledge; falls back with web-docs guidance when devecocli is unavailable.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: search, read, catalog' },
          keywords: { type: 'string', description: 'Space-separated keywords for search (matches any keyword)' },
          documentId: { type: 'string', description: 'Document id for read (copy it from a search result, e.g. 开发指南/.../ide-insight-session-launch)' },
          catalog: { type: 'string', description: 'Optional catalog name for search' },
          limit: { type: 'integer', description: 'Max search results (default 10)' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const cli = await ensureCli()
        if (!cli.ok) {
          return { ok: false, error: cli.error, fallback: 'Online official docs: developer.huawei.com (use web search tools with the target API version in the query).' }
        }
        if (args.action === 'catalog') {
          const r = await runCli(cli, ['docs', 'catalog'], { timeoutMs: 60000, stdoutMaxBytes: 262144 })
          const mojo = mojoFatal(r)
          return { ok: r.ok && !mojo, mojoFatal: mojo, output: tailText((r.stdout + '\n' + r.stderr).trim(), 6000), error: r.ok ? (mojo ? 'devecocli mojo platform channel failed (0x5) — docs needs a normal user session' : '') : (r.stderr || r.stdout) }
        }
        if (args.action === 'search') {
          const kws = String(args.keywords || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
          if (kws.length === 0) return { ok: false, error: 'keywords are required for action=search' }
          const argv = ['docs', 'search', ...kws.map((k) => psQuote(k)), '--format', 'json']
          if (args.catalog && String(args.catalog).trim()) argv.push('--catalog', psQuote(String(args.catalog).trim()))
          if (Number(args.limit) > 0) argv.push('--limit', String(Math.min(Number(args.limit), 50)))
          const r = await runCli(cli, argv, { timeoutMs: 60000, stdoutMaxBytes: 524288 })
          const mojo = mojoFatal(r)
          const empty = !(r.stdout + r.stderr).trim()
          const json = tryParseJson(r.stdout.trim())
          const ok = r.ok && !mojo && !empty
          return { ok, backend: 'devecocli', results: json != null ? json : null, output: json != null ? '' : tailText((r.stdout + '\n' + r.stderr).trim(), 6000), error: ok ? '' : (mojo ? 'devecocli mojo platform channel failed (0x5) — docs needs a normal user session' : (empty ? 'devecocli docs returned no output — the docs index (user profile) could not be read.' : (r.stderr || r.stdout))), mojoFatal: mojo, emptyOutput: empty, hint: 'Search matches ANY keyword (tokenized); for a precise topic use a longer phrase or --catalog. Use hms_docs action=read with a documentId from the results to get full content.' }
        }
        if (args.action === 'read') {
          const id = String(args.documentId || '').trim()
          if (!id) return { ok: false, error: 'documentId is required for action=read' }
          const r = await runCli(cli, ['docs', 'read', psQuote(id)], { timeoutMs: 60000, stdoutMaxBytes: 524288 })
          const mojo = mojoFatal(r)
          return { ok: r.ok && !mojo, documentId: id, mojoFatal: mojo, content: tailText((r.stdout + '\n' + r.stderr).trim(), 12000), error: r.ok ? (mojo ? 'devecocli mojo platform channel failed (0x5) — docs needs a normal user session' : '') : (r.stderr || r.stdout) }
        }
        return { ok: false, error: 'unknown action: ' + args.action }
      },
    },

    {
      name: 'hms_api_change',
      description: 'Official cross-version breaking API change scan (devecocli check compat): versions lists the SDK versions the local toolchain knows; diff scans a project, module set, or file list between --source-version and --target-version (target must be newer) and returns the breaking changes as JSON. The authoritative answer for "what changed between HarmonyOS versions".',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: versions, diff' },
          sourceVersion: { type: 'string', description: 'Source SDK version for diff (required; from action=versions)' },
          targetVersion: { type: 'string', description: 'Target SDK version for diff (required; must be newer than source)' },
          modules: { type: 'string', description: 'Optional space-separated modules to scan (diff; mutually exclusive with files)' },
          files: { type: 'string', description: 'Optional space-separated .ets/.c/.cpp files to scan (diff; mutually exclusive with modules)' },
          outputPath: { type: 'string', description: 'Optional directory/file to write apiChange-*.json/csv (diff)' },
          limit: { type: 'integer', description: 'Max console records (diff; default 100)' },
          timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 600000)' },
        },
        required: ['action'],
      },
      async execute(args) {
        args = args || {}
        const cli = await ensureCli()
        if (!cli.ok) return { ok: false, error: cli.error }
        // devecocli's compat channel needs DevEco Studio >= 26.0.0.810. Fail
        // fast from the local Studio version when it is provably below the
        // requirement, then let the real CLI output pass through otherwise.
        const st = getStudio()
        const COMPAT_MIN = '26.0.0.810'
        const COMPAT_UPGRADE_URL = 'https://developer.huawei.com/consumer/cn/download/'
        const compatBlocked = st.ok && !versionGte(st.version, COMPAT_MIN)
        if (compatBlocked) {
          const compatErrorText = 'Error: A required component is missing. The detected DevEco Studio version is ' + st.version + '. The minimum required version is ' + COMPAT_MIN + ". Upgrade before using 'check compat' at " + COMPAT_UPGRADE_URL
          return {
            ok: false,
            action: args.action,
            studioVersion: st.version,
            requiredVersion: COMPAT_MIN,
            localVersionGuard: true,
            output: compatErrorText,
            error: compatErrorText,
            hint: 'check compat requires the newer DevEco Studio version named in the error (upgrade at ' + COMPAT_UPGRADE_URL + '). Until then, hms_api @since/@deprecated tags give per-API version knowledge.',
          }
        }
        if (args.action === 'versions') {
          let r = await runCli(cli, ['check', 'compat', 'versions', '--format', 'json'], { timeoutMs: 60000, stdoutMaxBytes: 262144 })
          let json = tryParseJson(r.stdout.trim())
          let text = (r.stdout + '\n' + r.stderr).trim()
          if (json == null) {
            const plain = await runCli(cli, ['check', 'compat', 'versions'], { timeoutMs: 60000, stdoutMaxBytes: 262144, mergeStderr: true })
            const plainText = ((plain.stdout || '') + '\n' + (plain.stderr || '')).trim()
            if (plainText) {
              r = { ...plain, stdout: plainText, stderr: '' }
              text = plainText
            }
          }
          const mojo = mojoFatal(r)
          const emptyResult = json == null && !text
          const upgradeNeeded = /required component is missing|minimum required version/i.test(text)
          const ok = r.ok && !mojo && (json != null || (text && r.exitCode === 0 && !upgradeNeeded))
          const output = text || (json != null ? JSON.stringify(json, null, 2) : '')
          return { ok, versions: json != null ? json : null, mojoFatal: mojo, emptyResult, format: json != null ? 'json' : 'text', output: tailText(output, 8000), error: ok ? '' : (mojo ? 'devecocli mojo platform channel failed (0x5) — compat versions needs a normal user session' : (emptyResult ? 'devecocli compat versions returned no output.' : (text || 'devecocli compat versions failed.'))), hint: upgradeNeeded ? 'check compat requires the newer DevEco Studio version named in the error (upgrade at developer.huawei.com). Until then, hms_api @since/@deprecated tags give per-API version knowledge. ' : '' }
        }
        if (args.action === 'diff') {
          const src = String(args.sourceVersion || '').trim()
          const tgt = String(args.targetVersion || '').trim()
          if (!src || !tgt) return { ok: false, error: 'sourceVersion and targetVersion are required for diff; list them with action=versions.' }
          const argv = ['check', 'compat', '--source-version', psQuote(src), '--target-version', psQuote(tgt), '--format', 'json']
          if (args.modules && String(args.modules).trim()) argv.push('--modules', ...String(args.modules).split(/\s+/).map((m) => psQuote(m)))
          if (args.files && String(args.files).trim()) argv.push(...String(args.files).split(/\s+/).map((f) => psQuote(f)))
          if (args.outputPath && String(args.outputPath).trim()) argv.push('--output-path', psQuote(String(args.outputPath).trim()))
          if (Number(args.limit) > 0) argv.push('--limit', String(Math.min(Number(args.limit), 500)))
          let r = await runCli(cli, argv, { timeoutMs: Number(args.timeoutMs) || 600000, stdoutMaxBytes: 1048576 })
          let json = tryParseJson(r.stdout.trim())
          let text = (r.stdout + '\n' + r.stderr).trim()
          if (json == null) {
            const plainArgv = argv.filter((item, idx) => !(item === '--format' && argv[idx + 1] === 'json'))
            const plain = await runCli(cli, plainArgv, { timeoutMs: Number(args.timeoutMs) || 600000, stdoutMaxBytes: 1048576, mergeStderr: true })
            const plainText = ((plain.stdout || '') + '\n' + (plain.stderr || '')).trim()
            if (plainText) {
              r = { ...plain, stdout: plainText, stderr: '' }
              text = plainText
            }
          }
          const mojo = mojoFatal(r)
          const emptyResult = json == null && !text
          const upgradeNeeded = /required component is missing|minimum required version/i.test(text)
          const ok = r.ok && !mojo && (json != null || (text && r.exitCode === 0 && !upgradeNeeded))
          const output = text || (json != null ? JSON.stringify(json, null, 2) : '')
          return { ok, exitCode: r.exitCode, timedOut: r.timedOut, sourceVersion: src, targetVersion: tgt, changes: json != null ? json : null, format: json != null ? 'json' : 'text', mojoFatal: mojo, emptyResult, output: tailText(output, 8000), error: ok ? '' : (mojo ? 'devecocli mojo platform channel failed (0x5) — compat diff needs a normal user session' : (emptyResult ? 'devecocli compat diff returned no output.' : (text || 'devecocli compat diff failed.'))), hint: upgradeNeeded ? 'check compat requires the newer DevEco Studio version named in the error (upgrade at developer.huawei.com). Until then, hms_api @since/@deprecated tags give per-API version knowledge. ' : '' }
        }
        return { ok: false, error: 'unknown action: ' + args.action }
      },
    },
  ]
}
