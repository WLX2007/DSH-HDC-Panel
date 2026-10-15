// Tier-2 knowledge layer: on-demand fetch of OpenHarmony docs (zh-CN) from the
// Gitee mirror (gitee.com/openharmony/docs), with a local on-disk cache.
//
// Why Gitee first: raw.githubusercontent.com is unreachable on typical CN networks
// (verified 25s timeouts), while gitee raw responds in ~400ms/file anonymously.
// Official huawei doc portal requires login (X-HD-CSRF from developer_userinfo
// cookie) so it cannot be a zero-login source.
//
// Cache layout: <homedir>/.dsh-hdc-panel/knowledge-remote/
//   index.json   — array of { path, file, bytes, headings, fetchedAt }
//   <sanitized>.md — full markdown bodies
//
// Zero npm dependencies: uses global fetch (Node 18+) + node:fs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const REMOTE_SOURCE = 'https://gitee.com/openharmony/docs'
export const REMOTE_BRANCH = 'master'
export const REMOTE_LANG = 'zh-CN'
export const REMOTE_LICENSE = 'CC-BY-4.0'
export const REMOTE_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'
export const REMOTE_ATTRIBUTION = 'OpenHarmony documentation (openharmony/docs, © OpenHarmony Project Contributors), CC-BY-4.0 — https://creativecommons.org/licenses/by/4.0/'

const CACHE_DIR = join(homedir(), '.dsh-hdc-panel', 'knowledge-remote')
const CACHE_INDEX = join(CACHE_DIR, 'index.json')
const RAW_BASE = 'https://gitee.com/openharmony/docs/raw/' + REMOTE_BRANCH + '/'
const CONTENTS_API = 'https://gitee.com/api/v5/repos/openharmony/docs/contents/'
const FETCH_TIMEOUT_MS = 15000
const SYNC_FILE_CAP = 200 // safety cap per sync call
const FILE_CAP = 300000   // refuse to cache bodies above ~300KB (pathological)

const NEWLINE_RE = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10))
const NEWLINE = String.fromCharCode(10)
const HEADING_RE = /^(#{2,3})[ ]+(.*)$/
const INTRO_CAP = 4000
const SECTION_CAP = 24000
const TOC_CAP = 150

function cut(text, cap) {
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap) + NEWLINE + '…[truncated ' + (text.length - cap) + ' chars]', truncated: true }
}

export function headingsOf(text) {
  const out = []
  const lines = text.split(NEWLINE_RE)
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 })
  }
  return out
}

// ---------- cache ----------

function ensureDir() { if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true }) }

export function loadCacheIndex() {
  if (!existsSync(CACHE_INDEX)) return []
  try { return JSON.parse(readFileSync(CACHE_INDEX, 'utf8')) } catch { return [] }
}

function saveCacheIndex(list) {
  ensureDir()
  writeFileSync(CACHE_INDEX, JSON.stringify(list, null, 2), 'utf8')
}

function fileSlug(repoPath) {
  return repoPath.replace(/[^A-Za-z0-9._-]+/g, '__')
}

function cachedEntry(repoPath) {
  const list = loadCacheIndex()
  const e = list.find((x) => x.path === repoPath)
  if (!e || !existsSync(join(CACHE_DIR, e.file))) return null
  return e
}

function cachePut(repoPath, text) {
  ensureDir()
  const file = fileSlug(repoPath) // already endswith .md when path does
  writeFileSync(join(CACHE_DIR, file), text, 'utf8')
  const list = loadCacheIndex()
  const headings = headingsOf(text)
  const rec = { path: repoPath, file, bytes: Buffer.byteLength(text, 'utf8'), headings: headings.map((h) => h.text), fetchedAt: new Date().toISOString() }
  const i = list.findIndex((x) => x.path === repoPath)
  if (i >= 0) list[i] = rec; else list.push(rec)
  saveCacheIndex(list)
  return rec
}

function cacheRemove(repoPath) {
  const list = loadCacheIndex()
  const i = list.findIndex((x) => x.path === repoPath)
  if (i < 0) return false
  try { unlinkSync(join(CACHE_DIR, list[i].file)) } catch {}
  list.splice(i, 1)
  saveCacheIndex(list)
  return true
}

// ---------- network ----------

async function fetchText(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'dsh-hdc-panel knowledge' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.text()
  } finally { clearTimeout(t) }
}

function normalizeRepoPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!s) return ''
  if (!/\.md$/i.test(s)) s += '.md'
  if (!s.startsWith('zh-cn/') && !s.startsWith('en/')) s = 'zh-cn/application-dev/' + s.replace(/^application-dev\//, '')
  return s
}

async function giteeListDir(dir) {
  const url = CONTENTS_API + dir.split('/').map(encodeURIComponent).join('/') + '?ref=' + REMOTE_BRANCH
  const raw = await fetchText(url)
  let arr
  try { arr = JSON.parse(raw) } catch { throw new Error('unexpected directory listing response') }
  if (!Array.isArray(arr)) throw new Error('directory not found or listing failed: ' + dir)
  return arr.map((x) => ({ name: x.name, path: x.path, type: x.type, size: x.size }))
}

// ---------- public API ----------

// ---------- official Huawei KMS MCP layer (Tier-1, highest priority) ----------
//
// Official HarmonyOS developer-knowledge MCP service (anonymous, no login):
//   https://connect-api.cloud.huawei.com/api/developerknowledge/mcp
// Streamable-HTTP JSON-RPC; requires protocolVersion 2025-11-25 exactly and a
// Mcp-Session-Id obtained from initialize. Two tools:
//   searchDocuments  — RAG search, returns fragments + parent doc names
//   getDocumentsById — full Markdown bodies for up to 10 parent names
// The parent names (e.g. alliance/document/cn/harmonyos-guides/hilog) are the
// only addressing scheme — there is no path→name mapping, so read always needs
// a name obtained from a prior official-search.

export const OFFICIAL_MCP_URL = 'https://connect-api.cloud.huawei.com/api/developerknowledge/mcp'
export const OFFICIAL_MCP_PROTOCOL = '2025-11-25'
const OFFICIAL_TIMEOUT_MS = 30000

let officialSession = { id: null, at: 0 }

async function officialRpc(method, params, id = null) {
  const body = { jsonrpc: '2.0', ...(id != null ? { id } : {}), method, ...(params != null ? { params } : {}) }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), OFFICIAL_TIMEOUT_MS)
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }
    if (officialSession.id) headers['Mcp-Session-Id'] = officialSession.id
    const r = await fetch(OFFICIAL_MCP_URL, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) })
    const sid = r.headers.get('mcp-session-id')
    if (sid) officialSession = { id: sid, at: Date.now() }
    if (r.status === 204 || r.status === 202) return null
    const text = await r.text()
    if (!text) return null
    let json
    try { json = JSON.parse(text) } catch { throw new Error('non-JSON MCP response (HTTP ' + r.status + ')') }
    if (json.error) throw new Error('MCP error ' + json.error.code + ': ' + (json.error.message || 'unknown'))
    return json.result
  } finally { clearTimeout(t) }
}

// Initialize lazily and re-initialize once when the session goes stale.
async function officialEnsureSession() {
  if (officialSession.id && Date.now() - officialSession.at < 10 * 60 * 1000) return
  officialSession = { id: null, at: 0 }
  const res = await officialRpc('initialize', { protocolVersion: OFFICIAL_MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'dsh-hdc-panel', version: '0.12.0' } }, 1)
  if (!res || !res.serverInfo) throw new Error('MCP initialize failed')
  try { await officialRpc('notifications/initialized') } catch {}
}

function officialExtract(result) {
  if (!result) return null
  if (result.structuredContent && Array.isArray(result.structuredContent.resultList)) {
    return { code: result.structuredContent.code, message: result.structuredContent.message, resultList: result.structuredContent.resultList }
  }
  const item = Array.isArray(result.content) ? result.content.find((c) => c.type === 'text') : null
  if (!item) return null
  try {
    const p = JSON.parse(item.text)
    return Array.isArray(p.resultList) ? { code: p.code, message: p.message, resultList: p.resultList } : null
  } catch { return null }
}

// RAG search against the official knowledge base. Returns fragments + parent
// doc names; pass a parent name to official-read to get the full document.
export async function officialSearch(query, topK = 5) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'query is required' }
  const k = Math.max(1, Math.min(Number(topK) || 5, 20))
  try {
    await officialEnsureSession()
    const res = await officialRpc('tools/call', { name: 'searchDocuments', arguments: { SearchDocumentsReq: { query: q, topK: k } } }, 2)
    const parsed = officialExtract(res)
    if (!parsed) return { ok: false, error: 'unexpected official search response' }
    const results = parsed.resultList.map((x) => ({ tier: 'official', name: x.parent, excerpt: String(x.content || '').slice(0, 600) }))
    return {
      ok: parsed.code === 0 || results.length > 0,
      query: q, total: results.length,
      source: 'Huawei official developer-knowledge MCP (' + OFFICIAL_MCP_URL + ')',
      results,
      note: 'Pass a result name to action=official-read to fetch the full Markdown document.',
    }
  } catch (e) {
    officialSession = { id: null, at: 0 }
    return { ok: false, error: 'official MCP search failed: ' + e.message, source: OFFICIAL_MCP_URL }
  }
}

// Full document by official name (from official-search results). Up to 10
// names per call; the content is the server's Markdown (no section splitting).
export async function officialRead(names) {
  const list = (Array.isArray(names) ? names : String(names || '').split(/[,\s]+/)).map((s) => String(s || '').trim()).filter(Boolean)
  if (list.length === 0) return { ok: false, error: 'name is required (take it from action=official-search results)' }
  if (list.length > 10) return { ok: false, error: 'at most 10 names per call' }
  try {
    await officialEnsureSession()
    const res = await officialRpc('tools/call', { name: 'getDocumentsById', arguments: { GetDocumentsByIdRequest: { names: list } } }, 3)
    const parsed = officialExtract(res)
    if (!parsed) return { ok: false, error: 'unexpected official read response' }
    const docs = parsed.resultList.map((d) => ({
      name: d.name, title: d.title || d.name,
      uri: d.uri || '', bytes: Buffer.byteLength(String(d.content || ''), 'utf8'),
      content: String(d.content || ''),
    }))
    return {
      ok: docs.length > 0,
      requested: list.length, total: docs.length,
      missing: list.filter((n) => !docs.some((d) => d.name === n)),
      source: 'Huawei official developer-knowledge MCP (' + OFFICIAL_MCP_URL + ')',
      docs: docs.map((d) => ({ ...d, content: d.content.length > 60000 ? d.content.slice(0, 60000) + NEWLINE + '…[truncated]' : d.content })),
      note: 'Content is served as Markdown by the official service (no section index); paginate externally if very large.',
    }
  } catch (e) {
    officialSession = { id: null, at: 0 }
    return { ok: false, error: 'official MCP read failed: ' + e.message, source: OFFICIAL_MCP_URL }
  }
}

export function cacheStats() {
  const list = loadCacheIndex()
  return { ok: true, cacheDir: CACHE_DIR, source: REMOTE_SOURCE, branch: REMOTE_BRANCH, cached: list.length, entries: list.map((e) => ({ path: e.path, bytes: e.bytes, fetchedAt: e.fetchedAt, headings: e.headings.length })) }
}

// Read one doc: cache-first, then network. Mirrors knowledge.read()'s TOC/section shape.
export async function readRemote(repoPath, section = '') {
  const p = normalizeRepoPath(repoPath)
  if (!p) return { ok: false, error: 'path is required (repo-relative, e.g. zh-cn/application-dev/dfx/hilog.md)' }
  let text = null
  let fromCache = false
  const hit = cachedEntry(p)
  if (hit) {
    text = readFileSync(join(CACHE_DIR, hit.file), 'utf8')
    fromCache = true
  } else {
    try { text = await fetchText(RAW_BASE + p.split('/').map(encodeURIComponent).join('/')) } catch (e) {
      return { ok: false, error: 'fetch failed: ' + e.message, path: p, source: RAW_BASE + p, hint: 'Check the path via action=ls (directory listing), or try the zh-cn/application-dev/ prefix.' }
    }
    if (!text || text.length < 20 || /^404[: ]/.test(text.slice(0, 10))) {
      return { ok: false, error: 'document not found on Gitee: ' + p, hint: 'Use action=ls with dir=<parent directory> to list valid file names.' }
    }
    if (text.length > FILE_CAP) return { ok: false, error: 'document too large to cache (' + text.length + ' bytes): ' + p }
    cachePut(p, text)
  }
  const headings = headingsOf(text)
  const toc = headings.slice(0, TOC_CAP).map((h, i) => ({ n: i + 1, level: h.level, text: h.text }))
  const base = {
    ok: true,
    path: p,
    title: (headings.find((h) => h.level === 1) || headings[0] || { text: p }).text,
    bytes: Buffer.byteLength(text, 'utf8'),
    headingTotal: headings.length,
    fromCache,
    source: RAW_BASE + p,
    tier: 'remote',
    license: REMOTE_LICENSE,
    attribution: REMOTE_ATTRIBUTION,
  }
  if (section === '' || section == null) {
    const lines = text.split(NEWLINE_RE)
    const firstHeading = headings.length ? headings[0].line - 1 : lines.length
    const intro = cut(lines.slice(0, firstHeading).join(NEWLINE), INTRO_CAP)
    return { ...base, toc, tocTruncated: headings.length > TOC_CAP, intro: intro.text, introTruncated: intro.truncated, note: (fromCache ? '' : 'Fetched from Gitee and cached. ') + 'Pass section=<heading name or TOC n> to read one section (each capped at ' + SECTION_CAP + ' chars).' }
  }
  let idxSel = -1
  const n = Number(section)
  if (Number.isInteger(n) && n >= 1 && n <= headings.length) idxSel = n - 1
  else {
    const s = String(section).toLowerCase()
    const hi = headings.findIndex((h) => h.text.toLowerCase().includes(s))
    if (hi >= 0) idxSel = hi
  }
  if (idxSel < 0) return { ok: false, error: 'section not found: ' + section, hint: 'Read the TOC first (omit section) and pick a heading name or its n.', toc: toc.slice(0, 40) }
  const lines = text.split(NEWLINE_RE)
  const start = headings[idxSel].line - 1
  const selLevel = headings[idxSel].level
  let end = lines.length
  for (let k = idxSel + 1; k < headings.length; k++) {
    if (headings[k].level <= selLevel) { end = headings[k].line - 1; break }
  }
  const content = cut(lines.slice(start, end).join(NEWLINE), SECTION_CAP)
  return { ...base, section: headings[idxSel].text, sectionN: idxSel + 1, content: content.text, truncated: content.truncated, note: content.truncated ? 'Section truncated; ask for the next section by its TOC number.' : '' }
}

// List a directory on Gitee (dirs + .md files) to discover valid paths.
export async function listRemote(dir) {
  const d = String(dir || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!d) return { ok: false, error: 'dir is required (e.g. zh-cn/application-dev/dfx)', example: 'zh-cn/application-dev' }
  try {
    const items = await giteeListDir(d)
    return {
      ok: true,
      dir: d,
      source: REMOTE_SOURCE,
      total: items.length,
      dirs: items.filter((x) => x.type === 'dir').map((x) => x.path),
      files: items.filter((x) => x.type === 'file' && /\.md$/i.test(x.name)).map((x) => ({ path: x.path, bytes: x.size })),
      note: 'Pass one of the returned paths to action=read to fetch and cache it.',
    }
  } catch (e) {
    return { ok: false, error: 'listing failed: ' + e.message, hint: 'Directory paths are repo-relative, e.g. zh-cn/application-dev/dfx.' }
  }
}

// Sync a whole directory of .md files into the cache (bounded).
export async function syncRemote(dir, limit = 20) {
  const d = String(dir || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!d) return { ok: false, error: 'dir is required (e.g. zh-cn/application-dev/dfx)' }
  let items
  try { items = await giteeListDir(d) } catch (e) { return { ok: false, error: 'listing failed: ' + e.message } }
  const md = items.filter((x) => x.type === 'file' && /\.md$/i.test(x.name) && x.size <= FILE_CAP)
  const pick = md.slice(0, Math.max(1, Math.min(Number(limit) || 20, SYNC_FILE_CAP)))
  const results = []
  let fetched = 0, cachedSkipped = 0, failed = 0
  for (const it of pick) {
    const hit = cachedEntry(it.path)
    if (hit) { cachedSkipped++; results.push({ path: it.path, status: 'cached' }); continue }
    try {
      const text = await fetchText(RAW_BASE + it.path.split('/').map(encodeURIComponent).join('/'))
      if (text && text.length > 20 && text.length <= FILE_CAP) { cachePut(it.path, text); fetched++; results.push({ path: it.path, status: 'fetched', bytes: Buffer.byteLength(text, 'utf8') }) }
      else { failed++; results.push({ path: it.path, status: 'skipped', reason: 'empty or too large' }) }
    } catch (e) { failed++; results.push({ path: it.path, status: 'failed', reason: e.message }) }
  }
  return {
    ok: fetched > 0 || cachedSkipped > 0,
    dir: d, source: REMOTE_SOURCE, branch: REMOTE_BRANCH,
    fetched, cachedSkipped, failed,
    remaining: Math.max(0, md.length - pick.length),
    results,
    note: 'Synced docs are searchable: action=search now covers bundled Tier-1 plus the remote cache.',
  }
}

export function removeRemote(repoPath) {
  const p = normalizeRepoPath(repoPath)
  const ok = cacheRemove(p)
  return ok ? { ok: true, removed: p } : { ok: false, error: 'not in cache: ' + p }
}

// Unified search: bundled Tier-1 first (via callback to keep layering clean),
// then the remote cache. Returns merged results tagged with tier.
export function searchUnified(kws, limit, bundledSearch) {
  const out = { bundled: null, remote: [] }
  try { out.bundled = bundledSearch(kws, limit) } catch { out.bundled = null }
  const list = loadCacheIndex()
  const kwsL = kws.map((s) => s.toLowerCase())
  const scored = []
  for (const e of list) {
    const hay = (e.path + ' ' + e.headings.join(' ')).toLowerCase()
    let score = 0
    for (const kw of kwsL) if (hay.includes(kw)) score += kw.length >= 4 ? 3 : 2
    if (score > 0) scored.push({ score, e })
  }
  scored.sort((a, b) => b.score - a.score)
  out.remote = scored.slice(0, limit).map((s) => ({ tier: 'remote', path: s.e.path, bytes: s.e.bytes, fetchedAt: s.e.fetchedAt, score: s.score, matchedHeadings: s.e.headings.filter((h) => kwsL.some((k) => h.toLowerCase().includes(k))).slice(0, 6) }))
  return out
}
