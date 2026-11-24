// Device services shared by the tool groups.
//
// `install` and `appAction` are used both by the device layer (hdc_install,
// hdc_app) and by the build/run fallback loop in the toolchain layer, so they
// live here instead of inside a single tool module.

import { SIGN_HINT } from './errors.mjs'

export function createDeviceServices(rt) {
  const { runHdc, currentTarget } = rt

  function errorHint(text) {
    const t = String(text || '')
    if (/9568332|sign info inconsistent/i.test(t)) return '签名信息不一致：调试证书未登记当前设备 UDID。三步走：AGC 证书管理（https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-device）登记设备 UDID → 重新签名构建 → 重新安装。Sign info inconsistent: register the device UDID in AGC, rebuild with signing, reinstall.'
    if (/9568344|unsigned|signature/i.test(t)) return '签名缺失或损坏：应用未签名/签名已失效。重新执行签名后再安装（' + SIGN_HINT + '）。'
    if (/9568289|parse/i.test(t)) return '安装包解析失败：HAP 损坏、格式不被支持，或与已装版本的旧签名冲突——先卸载旧版本再重装。Parse failed: corrupt HAP or old-signature conflict; uninstall the old version first.'
    if (/140112|Consume/i.test(t)) return 'ArkTS 状态管理：@Consume 找不到对应的 @Provide（如 navPathStack 未在祖先组件提供）。检查页面组件的状态注入。@Consume cannot find its @Provide; check the ancestor component state injection.'
    if (/failed to install|install failed/i.test(t)) return '装包失败：检查签名、设备剩余存储与 bundle 名称（常见码：9568332 签名/9568289 解析/9568305 空间）。Install failed: check signing, free storage on the device, and the bundle name.'
    if (/failed to uninstall|uninstall failed/i.test(t)) return '卸载失败：确认应用已安装且 bundle 名称正确。Uninstall failed: confirm the app is installed and the bundle name is correct.'
    if (/permission denied|not permitted/i.test(t)) return '权限不足：部分操作需要设备授权或更高权限。Permission denied: some operations need device authorization or elevated privileges.'
    if (/error opening file|no such file|not exist/i.test(t)) return '本地 .hap 文件不存在或路径不可读：先 hms_build 构建（默认输出在 <project>\\entry\\build\\default\\outputs\\default\\），或核对 hapPath（Windows 下用反斜杠绝对路径）。The local .hap does not exist or is unreadable; build it first or check the path.'
    return ''
  }

  async function install(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    if (typeof args.hapPath !== 'string' || !args.hapPath.trim()) {
      return { ok: false, error: 'hapPath is required (path to a built .hap file)' }
    }
    const argv = ['install']
    if (args.replace !== false) argv.push('-r')
    // Windows hdc resolves forward-slash absolute paths against the cwd and
    // double-joins them; normalize to backslashes.
    const hapRaw = args.hapPath.trim()
    const hap = process.platform === 'win32' ? hapRaw.replace(/\//g, '\\') : hapRaw
    argv.push(hap)
    const r = await runHdc(argv, { target: cur.target, timeoutMs: 180000, stdoutMaxBytes: 262144 })
    const text = r.stdout + '\n' + r.stderr
    const ok = r.ok && !/error|failed|fail/i.test(text)
    const hint = ok ? 'Installed. Run hdc_screenshot or hdc_ui_dump to verify the UI.' : errorHint(text)
    return { ok, exitCode: r.exitCode, stdout: tailText(r.stdout, 4000), stderr: tailText(r.stderr, 2000), timedOut: r.timedOut, hint }
  }

  const BUNDLE_RE = /^[A-Za-z0-9._-]{3,200}$/
  const ABILITY_RE = /^[A-Za-z0-9._-]{1,100}$/

  // `bm dump -n <bundle>` prints the whole bundle manifest as JSON. Scanning
  // that text for the word "error" misfires on ordinary content (a page
  // called ServerErrorView is enough), so a query is judged by its exit code
  // and by the payload it produced.
  function looksLikeBundleDump(text) {
    const value = String(text || '').trim()
    if (!value) return false
    if (!/^[[{]/.test(value)) return /"bundleName"\s*:/.test(value)
    try {
      const parsed = JSON.parse(value)
      return !!parsed && typeof parsed === 'object'
    } catch {
      return /"bundleName"\s*:/.test(value)
    }
  }

  // For the mutating actions the CLI prints a short human-readable status, so
  // a failure marker on its own line is a reliable signal.
  function appActionFailed(text) {
    const value = String(text || '')
    return /(^|\n)\s*(failed to |not found|not exist|permission denied|\[fail\]|error:|failure:)/i.test(value)
  }

  async function appAction(args) {
    args = args || {}
    const cur = await currentTarget(args.target)
    if (cur.error) return { ok: false, error: cur.error }
    const action = String(args.action || '')
    const bundle = String(args.bundleName || '').trim()
    if (!BUNDLE_RE.test(bundle)) return { ok: false, error: 'bundleName must be a valid bundle identifier (e.g. com.example.app)' }
    let argv = []
    switch (action) {
      case 'query':
        argv = ['shell', 'bm', 'dump', '-n', bundle]
        break
      case 'start': {
        const ability = String(args.abilityName || 'EntryAbility').trim()
        if (!ABILITY_RE.test(ability)) return { ok: false, error: 'invalid abilityName' }
        argv = ['shell', 'aa', 'start', '-a', ability, '-b', bundle]
        break
      }
      case 'stop':
        argv = ['shell', 'aa', 'force-stop', bundle]
        break
      case 'clear-data':
        argv = ['shell', 'bm', 'clean', '-n', bundle, '-d']
        break
      case 'uninstall':
        argv = ['shell', 'bm', 'uninstall', '-n', bundle]
        break
      default:
        return { ok: false, error: 'action must be one of: query, start, stop, clear-data, uninstall' }
    }
    const r = await runHdc(argv, { target: cur.target, timeoutMs: 120000, stdoutMaxBytes: 1048576 })
    const text = (r.stdout + '\n' + r.stderr)
    const ok = action === 'query'
      ? (r.ok && looksLikeBundleDump(r.stdout))
      : (r.ok && !appActionFailed(text))
    const hint = ok ? '' : errorHint(text)
    return { ok, action, bundleName: bundle, exitCode: r.exitCode, stdout: tailText(r.stdout, 4000), stderr: tailText(r.stderr, 2000), timedOut: r.timedOut, hint }
  }

  return { errorHint, install, appAction }
}

function tailText(text, max) {
  const value = String(text || '')
  return (value.length <= max ? value : value.slice(value.length - max))
}
