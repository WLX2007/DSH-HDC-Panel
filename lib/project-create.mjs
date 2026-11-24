// Shared project-creation plan/verification helpers for the DSH plugin.
//
// This module contains NO process execution: it only validates the arguments
// that `devecocli create` accepts and interprets its output. Keeping these
// pure helpers separate makes the same contract reusable by the standalone
// MCP server (mcp/src/core/project-create.mjs) and by smoke tests.
//
// Official command shape (devecocli 1.3.x, `devecocli create --help`):
//   devecocli create
//     --project-path <path>   (default: ./<app-name>)
//     --app-name <name>       (required)
//     --bundle-name <bundle>  (default: com.example.<app-name>)
//     --api-level <level>     (auto-detected from SDK when omitted; min 17)
//     --device-types <types...> (default: phone; supported list below)

import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, resolve as pathResolve } from 'node:path'

export const CREATE_SUPPORTED_DEVICE_TYPES = ['phone', 'tablet', '2in1', 'car', 'wearable', 'tv']
export const CREATE_MIN_API_LEVEL = 17
export const CREATE_OK_MARKER = 'Project created successfully.'
export const CREATE_FAIL_RE = /Failed to create project|Cannot create project here|Invalid API version|Unsupported device type|must start with a letter|Application name must|Bundle name|Project path can only contain|Project path cannot|Template integrity check failed|No write permission/i

// CLI rules: 7-128 chars, >= 3 dot-separated segments, each segment only
// letters/digits/underscore, first segment starts with a letter, every segment
// starts and ends with a letter or digit, no consecutive dots.
const BUNDLE_RE = /^(?=.{7,128}$)[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])?){2,}$/

/**
 * Validate and normalise tool arguments into a devecocli create plan.
 * Returns `{ ok: true, ...plan }` or `{ ok: false, error }`.
 *
 * `workspaceRoot` is used to resolve a relative projectPath. `platform`
 * selects the CLI's path character whitelist on Windows vs POSIX.
 */
export function planCreate(args, { workspaceRoot = '', platform = 'win32' } = {}) {
  const input = args || {}
  const appName = String(input.appName ?? input.app_name ?? '').trim()
  if (!appName) return { ok: false, error: 'appName is required (e.g. MyHarmonyApp).' }
  if (appName.length > 200) return { ok: false, error: 'appName must be at most 200 characters.' }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(appName)) {
    return { ok: false, error: 'appName must start with a letter and contain only letters, digits, and underscores.' }
  }

  const rawPath = String(input.projectPath ?? input.project_path ?? '').trim()
  const projectPath = pathResolve(rawPath
    ? (isAbsolute(rawPath) ? rawPath : pathResolve(workspaceRoot || process.cwd(), rawPath))
    : pathResolve(workspaceRoot || process.cwd(), appName))
  if (projectPath.length > 120) return { ok: false, error: 'projectPath must be at most 120 characters (devecocli limit).' }
  // DevEco CLI's own validator allows letters, digits, dots, underscores and
  // hyphens but rejects path separators in --project-path (it resolves the
  // path relative to the CWD instead). We normalise separators to '/' and
  // validate only the leaf names, so absolute and nested paths are accepted.
  const segments = projectPath.split(/[\\/]+/).filter(Boolean).map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s.replace(':', '') : s))
  const nameRe = /^[A-Za-z0-9._\-]+$/
  const badSegment = segments.find((s) => !nameRe.test(s))
  if (badSegment) {
    return { ok: false, error: 'projectPath segments may only contain letters, digits, dots, underscores and hyphens (no spaces or Chinese characters). Bad segment: ' + badSegment }
  }
  if (/[\u4e00-\u9fff]/.test(projectPath) || projectPath.endsWith('.')) {
    return { ok: false, error: 'projectPath cannot contain Chinese characters or end with a dot (devecocli restriction).' }
  }

  let bundleName = String(input.bundleName ?? input.bundle_name ?? '').trim()
  if (bundleName) {
    if (!BUNDLE_RE.test(bundleName)) {
      return { ok: false, error: 'bundleName must be 7-128 chars, at least 3 dot-separated segments of letters/digits/underscores; first segment starts with a letter, every segment starts and ends with a letter or digit (e.g. com.example.myapp).' }
    }
  } else {
    bundleName = 'com.example.' + appName.toLowerCase()
  }

  let apiLevel = null
  if (input.apiLevel != null && input.apiLevel !== '') {
    apiLevel = Number(input.apiLevel)
    if (!Number.isInteger(apiLevel) || apiLevel < CREATE_MIN_API_LEVEL) {
      return { ok: false, error: 'apiLevel must be an integer >= ' + CREATE_MIN_API_LEVEL + '.' }
    }
  }

  let deviceTypes
  if (Array.isArray(input.deviceTypes)) {
    deviceTypes = input.deviceTypes.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  } else if (typeof input.deviceTypes === 'string' && input.deviceTypes.trim()) {
    deviceTypes = input.deviceTypes.split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean)
  } else {
    deviceTypes = ['phone']
  }
  deviceTypes = Array.from(new Set(deviceTypes))
  if (!deviceTypes.length) deviceTypes = ['phone']
  const unsupported = deviceTypes.filter((v) => !CREATE_SUPPORTED_DEVICE_TYPES.includes(v))
  if (unsupported.length) {
    return { ok: false, error: 'Unsupported deviceTypes: ' + unsupported.join(', ') + '. Supported: ' + CREATE_SUPPORTED_DEVICE_TYPES.join(', ') + '.' }
  }

  return { ok: true, appName, projectPath, bundleName, apiLevel, deviceTypes }
}

/** Build the argv for `devecocli create`; values must already be quoted. */
export function createArgv(plan, quote) {
  const q = quote || ((s) => String(s))
  const argv = ['create', '--app-name', q(plan.appName), '--project-path', q(plan.projectPath), '--bundle-name', q(plan.bundleName)]
  if (plan.apiLevel != null) argv.push('--api-level', String(plan.apiLevel))
  argv.push('--device-types', ...plan.deviceTypes.map((t) => q(t)))
  return argv
}

/**
 * Preflight the destination directory locally so an existing/non-empty folder
 * fails with one clear message instead of a long CLI trace.
 */
export function checkDestination(projectPath) {
  try {
    if (!existsSync(projectPath)) return { ok: true, exists: false }
    if (!statSync(projectPath).isDirectory()) return { ok: false, error: 'projectPath exists but is not a directory: ' + projectPath }
    const entries = readdirSync(projectPath)
    if (entries.length) return { ok: false, error: 'Directory is not empty, devecocli refuses to scaffold into it: ' + projectPath }
    return { ok: true, exists: true }
  } catch (e) {
    return { ok: false, error: 'Cannot inspect projectPath: ' + String((e && e.message) || e) }
  }
}

/** Verify the scaffold really exists on disk after the CLI reports success. */
export function verifyScaffold(projectPath) {
  const required = ['build-profile.json5', 'AppScope/app.json5', 'entry/src/main/module.json5']
  const missing = []
  for (const rel of required) {
    try {
      if (!statSync(pathResolve(projectPath, rel)).isFile()) missing.push(rel)
    } catch {
      missing.push(rel)
    }
  }
  return { ok: missing.length === 0, missing }
}

/** Parse the effective API level out of a successful CLI transcript. */
export function parseCreatedApiLevel(output) {
  const m = /API level:\s*(\d+)/i.exec(String(output || ''))
  return m ? parseInt(m[1], 10) : null
}

/** Structural hint from the CLI transcript (the CLI speaks both zh and en). */
export function createErrorHint(text, projectPath) {
  const t = String(text || '')
  if (/not empty|already exists|cannot create project here/i.test(t)) {
    return '目标目录已存在且非空：devecocli 只会向空目录写官方模板。换一个 projectPath，或先移走/删除目录再重试。Choose a different projectPath or clear the directory.'
  }
  if (/app(lication)? name|must start with a letter/i.test(t)) {
    return 'appName 必须以字母开头，且只含字母、数字、下划线。appName must start with a letter and contain only letters, digits and underscores.'
  }
  if (/invalid api version|api version 17|api level/i.test(t)) {
    return 'apiLevel 不合法或被本机 SDK 拒绝：最小 17，上限取决于本机 SDK（用 hms_setup 查看 apiVersion）；省略则由 devecocli 自动探测。'
  }
  if (/unsupported device type/i.test(t)) {
    return 'deviceTypes 仅支持：' + CREATE_SUPPORTED_DEVICE_TYPES.join(', ') + '。'
  }
  if (/bundle name|bundlename/i.test(t)) {
    return 'bundleName 需 7-128 字符、至少 3 段（如 com.example.myapp），省略时自动取 com.example.<appName>。'
  }
  if (/project path|projectpath|write permission|chinese/i.test(t)) {
    return 'projectPath 不能含空格/中文/特殊字符，且父目录必须可写；长度不超过 120。'
  }
  if (/EPERM/i.test(t)) {
    return '受限沙箱无法创建目录：请在更宽权限的会话中重试，或在本机终端直接运行 devecocli create。'
  }
  return '创建失败：本工具只走官方 devecocli create 通道；用 hms_setup 检查 devecocli/SDK 是否可用，或用 createErrorHint 的提示调整参数。'
}

/** Success hint pointing at the next step in the compile loop. */
export function createSuccessHint(projectPath) {
  return 'Created. Next: switch_cwd to "' + projectPath + '", then build_project / hms_build action=build.'
}
