// Shared hdc discovery primitives — the single source for both the tool layer
// (lib/hdc-core.mjs, probing through the session shell) and the browser panel
// (lib/panel.mjs, probing with direct execFile). Only default install roots
// live here; non-default installs are covered by DEVECO_SDK_HOME, the Studio
// root the host finds dynamically, caller-provided extraRoots, and the PATH
// fallback each layer runs after the candidate list is exhausted.

export const VER_RE = /Ver:/i

export const HDC_ROOTS = [
  'C:\\Program Files\\Huawei\\DevEco Studio\\sdk',
  'D:\\Program Files\\Huawei\\DevEco Studio\\sdk',
  '/Applications/DevEco-Studio.app/Contents/sdk',
]
export const HDC_VERS = ['default', '10', '11', '12', '13', '14', '15', '16', '17', '18']

export const HDC_NOT_FOUND = 'hdc not found. Install DevEco Studio or HarmonyOS command-line tools, or put hdc on PATH.'

function dynamicSdkRoots(extraRoots) {
  const roots = []
  const push = (r) => { if (r && !roots.includes(String(r))) roots.push(String(r)) }
  try { push(process.env && process.env.DEVECO_SDK_HOME) } catch (e) { /* env 読取不可環境でも継続 */ }
  for (const r of extraRoots || []) push(r)
  return roots
}

// Candidate hdc.exe paths: dynamic roots first (env + caller extras), then the
// default install roots; each SDK root crossed with every known API layout in
// both path spellings.
export function hdcCandidates(extraRoots) {
  const list = []
  for (const root of [...dynamicSdkRoots(extraRoots), ...HDC_ROOTS]) {
    for (const v of HDC_VERS) {
      list.push(root + '\\' + v + '\\openharmony\\toolchains\\hdc.exe')
      list.push(root + '/' + v + '/openharmony/toolchains/hdc')
    }
  }
  return list
}
