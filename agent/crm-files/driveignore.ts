// o6e65 S7: the .driveignore ENGINE for the CRM drive (new-files-only candidate; the sync/hook half is Web's, Agent 5).
//
// A PURE module — no Windows, no koffi, no I/O, no CRM. It answers one question cheaply over a huge tree: "is this path ignored by the .driveignore rules?"
// so the drive's sync can skip the files the person does not want mirrored (editor lock files, build junk, OS cruft, half-downloads, …).
//
// Format: exactly `.gitignore` (gitignore(5)). Verified line-for-line against real `git check-ignore` in driveignore.test.ts, so the drive and git agree.
// Supported: `*` `?` `[...]`, `**` (leading `**/`, trailing `/**`, middle `/**/`), a trailing `/` (directory-only), a leading or middle `/` (anchored to the
// .driveignore's own folder), `!` (re-include), `#` (comment), `\` escapes (`\#` `\!` `\ ` a literal trailing space, `\*` …), and trailing spaces dropped unless escaped.
//
// Paths here are drive-relative, `/`-separated, NO leading or trailing slash: "" is the root, "projects/Alpha/notes.txt" a file. (A caller using Windows "\\"
// paths can pass them through `normalizePath` first.) Rules live in a Map keyed by the folder that holds each .driveignore ("" = the root). NEAREST folder wins;
// within one file the LAST matching line wins — git's own precedence.
//
// The git rule that catches people out, and that this engine honours: **a path inside an excluded directory can NOT be re-included.** `build/` then `!build/keep`
// still ignores build/keep (git never descends into an excluded directory). To keep some files, exclude the CONTENTS not the folder: `build/*` then `!build/keep`.
//
// Performance: every rule's matcher is a RegExp compiled ONCE at parse time (never per path). `createMatcher` additionally memoises each directory's excluded/not
// state, so scanning a whole tree is about one decision per directory, not per file. `isIgnored(path, isDir, rulesByFolder)` is the simple one-shot form.

/** One parsed .driveignore line. The RegExp is precompiled; nothing is compiled while matching. */
export interface DriveignoreRule {
  /** The original line, for debugging / `git check-ignore -v`-style reporting. */
  readonly source: string
  /** A `!` line: re-include rather than ignore. */
  readonly negated: boolean
  /** A `foo/` line: matches directories only. */
  readonly dirOnly: boolean
  /** The pattern is tied to its .driveignore's folder (a leading or middle `/`); false = a bare name that matches at any depth. */
  readonly anchored: boolean
  /** Precompiled. Anchored rules test it against the path relative to the rule's folder; floating rules against the basename. */
  readonly re: RegExp
}

/** Folder (relative, "" = root) → that folder's .driveignore rules, in file order. */
export type RulesByFolder = Map<string, DriveignoreRule[]>

/** The built-in, switchable defaults (editor lock files, temp files, OS cruft, dependency folders, half-finished downloads). */
export const DEFAULT_PATTERNS: readonly string[] = ['~$*', '*.tmp', 'Thumbs.db', 'desktop.ini', '.DS_Store', 'node_modules', '*.crdownload']

// ---- parsing -------------------------------------------------------------------------------------------------------

/** Parse one .driveignore's text into rules (blank lines and comments drop out). */
export function parseDriveignore(text: string): DriveignoreRule[] {
  const rules: DriveignoreRule[] = []
  for (const raw of text.split('\n')) {
    const rule = parseLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
    if (rule) rules.push(rule)
  }
  return rules
}

function parseLine(raw: string): DriveignoreRule | null {
  if (raw.length === 0) return null
  if (raw[0] === '#') return null // a comment (a literal leading '#' is written "\#")
  let line = trimTrailingUnescaped(raw)
  if (line.length === 0) return null // blank / all spaces

  let negated = false
  if (line[0] === '!') {
    negated = true
    line = line.slice(1)
  } else if (line[0] === '\\' && (line[1] === '!' || line[1] === '#')) {
    line = line.slice(1) // "\!" / "\#" → a literal '!' / '#' as the first character
  }
  if (line.length === 0) return null // a lone '!'

  let dirOnly = false
  if (line.endsWith('/') && !isEscaped(line, line.length - 1)) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  if (line.length === 0) return null // a lone '/'

  let anchored = false
  if (line[0] === '/') {
    anchored = true
    line = line.slice(1)
  } else if (line.includes('/')) {
    anchored = true
  }
  if (line.length === 0) return null

  const re = anchored ? new RegExp('^' + globPathToRe(line) + '$') : new RegExp('^' + globSegmentToRe(line) + '$')
  return { source: raw, negated, dirOnly, anchored, re }
}

/** Drop trailing spaces that are not backslash-escaped (git: "Trailing spaces are ignored unless they are quoted with backslash."). */
function trimTrailingUnescaped(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === ' ' && !isEscaped(s, end - 1)) end--
  return s.slice(0, end)
}

/** Is the character at `idx` escaped by an odd run of backslashes before it? */
function isEscaped(s: string, idx: number): boolean {
  let n = 0
  let j = idx - 1
  while (j >= 0 && s[j] === '\\') {
    n++
    j--
  }
  return n % 2 === 1
}

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/

function escapeRe(ch: string): string {
  return RE_SPECIAL.test(ch) ? '\\' + ch : ch
}

/** One path segment (no '/') → a regex fragment. `*`→anything-but-'/', `?`→one-but-'/', `[...]`→a class, `\x`→literal x, runs of `*` collapse. */
function globSegmentToRe(seg: string): string {
  let r = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '\\') {
      const n = seg[i + 1]
      if (n !== undefined) {
        r += escapeRe(n)
        i++
      } else r += '\\\\'
    } else if (c === '*') {
      while (seg[i + 1] === '*') i++ // "a**b" (not a whole-segment "**") is just "*"
      r += '[^/]*'
    } else if (c === '?') {
      r += '[^/]'
    } else if (c === '[') {
      const cls = parseClass(seg, i)
      r += cls.re
      i = cls.end
    } else r += escapeRe(c)
  }
  return r
}

/** A full glob with '/' and '**' → a regex fragment matching a whole (anchored) path. */
function globPathToRe(glob: string): string {
  const segs = glob.split('/')
  let r = ''
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]
    const last = k === segs.length - 1
    if (seg === '**') {
      if (last) {
        r += '.*' // trailing "/**": everything below (a '/' was already emitted by the previous segment)
      } else {
        r += '(?:[^/]+/)*' // leading "**/" or middle "/**/": zero or more path segments (includes its own trailing '/')
        continue // do not add another '/'
      }
    } else {
      r += globSegmentToRe(seg)
    }
    if (!last) r += '/'
  }
  return r
}

/** Parse a `[...]` class starting at `start` ('['). Returns its regex and the index of the closing ']'; a class with no ']' is a literal '['. */
function parseClass(seg: string, start: number): { re: string; end: number } {
  let i = start + 1
  let neg = false
  if (seg[i] === '!' || seg[i] === '^') {
    neg = true
    i++
  }
  let body = ''
  if (seg[i] === ']') {
    body += '\\]'
    i++
  }
  while (i < seg.length && seg[i] !== ']') {
    const c = seg[i]
    if (c === '\\') {
      const n = seg[i + 1]
      if (n !== undefined) {
        body += '\\' + n
        i += 2
        continue
      }
    }
    body += c === '^' || c === '\\' || c === ']' ? '\\' + c : c
    i++
  }
  if (i >= seg.length) return { re: escapeRe('['), end: start } // no closing ']': a literal '['
  return { re: '[' + (neg ? '^' : '') + body + ']', end: i }
}

// ---- building the rule map -----------------------------------------------------------------------------------------

export interface DriveignoreFile {
  /** The folder that holds this .driveignore, relative to the drive root ("" = root). Windows "\\" and leading/trailing "/" are tolerated. */
  folder: string
  text: string
}

export interface BuildOptions {
  /** Prepend the built-in defaults at the root (switchable). A root .driveignore can still override one with `!` (e.g. "!Thumbs.db"). */
  defaults?: boolean
}

/** The defaults as rules, as though a root .driveignore held DEFAULT_PATTERNS. */
export function defaultRules(): DriveignoreRule[] {
  return parseDriveignore(DEFAULT_PATTERNS.join('\n'))
}

/** Gather .driveignore files (and, if asked, the defaults) into the folder→rules map. Files in the same folder are concatenated in the given order. */
export function buildRulesByFolder(files: readonly DriveignoreFile[], opts: BuildOptions = {}): RulesByFolder {
  const map: RulesByFolder = new Map()
  if (opts.defaults) map.set('', defaultRules())
  for (const f of files) {
    const folder = normalizeFolder(f.folder)
    const parsed = parseDriveignore(f.text)
    const existing = map.get(folder)
    map.set(folder, existing ? [...existing, ...parsed] : parsed)
  }
  return map
}

/** "a\\b", "/a/b/", "a/b" → "a/b"; root → "". */
export function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/** "\\a\\b\\", "/a/b" → "a/b". For callers holding Windows paths. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

// ---- matching ------------------------------------------------------------------------------------------------------

const parentDir = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}
const basename = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

type Verdict = 'ignore' | 'include' | undefined

/** The last matching rule's verdict within ONE folder's list, for a path relative to that folder (git: the last match wins). */
function lastMatch(rules: DriveignoreRule[], rel: string, isDir: boolean): Verdict {
  const base = basename(rel)
  let verdict: Verdict
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.re.test(r.anchored ? rel : base)) verdict = r.negated ? 'include' : 'ignore'
  }
  return verdict
}

/** The verdict for ONE path component, from the nearest folder that has a matching rule (deeper .driveignore beats shallower). */
function decide(path: string, isDir: boolean, rbf: RulesByFolder): Verdict {
  let folder = parentDir(path)
  for (;;) {
    const rules = rbf.get(folder)
    if (rules && rules.length) {
      const rel = folder === '' ? path : path.slice(folder.length + 1)
      const v = lastMatch(rules, rel, isDir)
      if (v !== undefined) return v
    }
    if (folder === '') return undefined
    folder = parentDir(folder)
  }
}

export interface Matcher {
  /** Is this drive-relative path ignored? `isDir` tells directory-only rules (and the sub-tree rule) what the path is. */
  isIgnored(path: string, isDir: boolean): boolean
}

/**
 * A matcher over a fixed rule map, with a per-directory cache: ideal for scanning a whole tree. Walks a path's ancestors top-down — if any ancestor DIRECTORY
 * is excluded, the path is ignored and no `!` can save it; otherwise the path's own nearest-wins verdict decides. Each directory's excluded state is memoised.
 */
export function createMatcher(rbf: RulesByFolder): Matcher {
  const dirExcludedCache = new Map<string, boolean>()
  function dirExcluded(dir: string): boolean {
    if (dir === '') return false
    const hit = dirExcludedCache.get(dir)
    if (hit !== undefined) return hit
    const res = dirExcluded(parentDir(dir)) || decide(dir, true, rbf) === 'ignore'
    dirExcludedCache.set(dir, res)
    return res
  }
  return {
    isIgnored(path: string, isDir: boolean): boolean {
      const p = normalizePath(path)
      if (p === '') return false // the root is never ignored
      if (dirExcluded(parentDir(p))) return true
      return decide(p, isDir, rbf) === 'ignore'
    },
  }
}

/**
 * One-shot: is `path` ignored by `rulesByFolder`? (The signature Shubham asked for.) For scanning many paths, build a `createMatcher` once instead —
 * the rules' regexes are already compiled, but the per-directory cache is what makes a huge tree cheap.
 */
export function isIgnored(path: string, isDir: boolean, rulesByFolder: RulesByFolder): boolean {
  return createMatcher(rulesByFolder).isIgnored(path, isDir)
}
