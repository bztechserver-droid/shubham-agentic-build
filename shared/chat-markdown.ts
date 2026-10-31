// F-050: the markdown of an agent's messages, parsed to a small tree the chat view draws as
// elements (never as HTML, so nothing a message says can inject markup). No dependency: the
// subset claude writes: paragraphs, headings, lists (nested), fenced code, quotes, tables, rules,
// and in a line code, **bold**, *italic*, ~~strike~~, links and bare urls. A message still being
// written parses too: an unclosed fence is code to the end, an unclosed `*` is a star.

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' }

export type MdBlock =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: 'code'; lang: string; s: string }
  | { t: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'hr' }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: Inline[][]; rows: Inline[][][] }

/** Only these links are made links: nothing a message says can run script or open a file. */
export function safeHref(href: string): string | null {
  const h = href.trim()
  return /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i.test(h) ? h : null
}

// ---------------------------------------------------------------------------------------------
// Inline

const ESCAPABLE = '\\`*_{}[]()#+-.!|~>'
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/** The index of the next `mark` at or after `from` that isn't escaped or inside a code span; -1 if none. */
function findClose(s: string, mark: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '`') {
      // Skip a code span as a whole: its stars are not emphasis.
      let k = i
      while (s[k] === '`') k++
      const run = s.slice(i, k)
      const end = s.indexOf(run, k)
      if (end !== -1) i = end + run.length - 1
      else i = k - 1
    } else if (s.startsWith(mark, i)) return i
  }
  return -1
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ t: 'text', s: buf })
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (c === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (c === '`') {
      let k = i
      while (s[k] === '`') k++
      const run = s.slice(i, k)
      const end = s.indexOf(run, k)
      if (end !== -1 && end > k) {
        flush()
        let code = s.slice(k, end).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        out.push({ t: 'code', s: code })
        i = end + run.length
        continue
      }
      buf += run
      i = k
      continue
    }
    if (c === '[') {
      // The address may hold one level of parentheses (Wikipedia's do).
      const m = /^\[((?:[^\]\\]|\\.)*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i))
      if (m && m[1]) {
        const href = safeHref(m[2])
        flush()
        const inner = parseInline(m[1])
        if (href) out.push({ t: 'link', href, c: inner })
        else out.push(...inner)
        i += m[0].length
        continue
      }
    }
    if (c === 'h' && (s.startsWith('http://', i) || s.startsWith('https://', i)) && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>"']+/.exec(s.slice(i))
      if (m) {
        // Trailing punctuation belongs to the sentence, not the address.
        let url = m[0]
        while (/[.,;:!?)\]}]$/.test(url) && !(url.endsWith(')') && url.includes('('))) url = url.slice(0, -1)
        const href = safeHref(url)
        if (href) {
          flush()
          out.push({ t: 'link', href, c: [{ t: 'text', s: url }] })
          i += url.length
          continue
        }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const double = s[i + 1] === c
      const mark = c === '~' ? (double ? '~~' : '') : double ? c + c : c
      if (mark) {
        const open = i + mark.length
        const closeAt = findClose(s, mark, open)
        // A marker needs text right inside it on both sides (**a**, not ** a **).
        const ok =
          closeAt > open &&
          !isSpace(s[open]) &&
          !isSpace(s[closeAt - 1]) &&
          // snake_case_names and 2*3*4 are not emphasis.
          (c !== '_' || (!isWord(s[i - 1]) && !isWord(s[closeAt + mark.length]))) &&
          (c !== '*' || mark.length === 2 || s[closeAt + 1] !== '*')
        if (ok) {
          flush()
          const inner = parseInline(s.slice(open, closeAt))
          out.push(c === '~' ? { t: 'del', c: inner } : mark.length === 2 ? { t: 'strong', c: inner } : { t: 'em', c: inner })
          i = closeAt + mark.length
          continue
        }
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------------------------
// Blocks

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE_RE = /^ {0,3}>\s?(.*)$/
const DELIM_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

const indentOf = (l: string) => (/^\s*/.exec(l.replace(/\t/g, '    '))?.[0].length ?? 0)

function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (t[i] === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  out.push(cur.trim())
  return out
}

const startsBlock = (l: string, next: string | undefined) =>
  FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || BULLET_RE.test(l) || ORDERED_RE.test(l) || (l.includes('|') && next !== undefined && DELIM_RE.test(next) && next.includes('-') && l.trim().length > 0 && next.includes('|'))

function parseBlocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const mark = fence[1]
      const body: string[] = []
      i++
      // Closed by a fence of the same kind at least as long; an unclosed one runs to the end.
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) body.push(lines[i++])
      i++
      out.push({ t: 'code', lang: fence[2] ?? '', s: body.join('\n') })
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      out.push({ t: 'h', level: Math.min(4, heading[1].length) as 1 | 2 | 3 | 4, c: parseInline(heading[2]) })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(QUOTE_RE.exec(lines[i++])![1])
      out.push({ t: 'quote', c: parseBlocks(inner) })
      continue
    }
    const bullet = BULLET_RE.exec(line)
    const ordered = bullet ? null : ORDERED_RE.exec(line)
    if (bullet || ordered) {
      const isOrdered = ordered !== null
      const marker = isOrdered ? ORDERED_RE : BULLET_RE
      const baseIndent = indentOf(line)
      const items: MdBlock[][] = []
      const start = ordered ? Number(ordered[2]) : 1
      while (i < lines.length) {
        const m = marker.exec(lines[i])
        if (!m || indentOf(lines[i]) !== baseIndent) break
        const body: string[] = [m[3]]
        i++
        // The item's own lines: indented deeper than its marker, blank lines between them allowed
        // when more indented content follows. They lose the indent of the first of them.
        let child = -1
        while (i < lines.length) {
          const l = lines[i]
          if (!l.trim()) {
            let k = i
            while (k < lines.length && !lines[k].trim()) k++
            if (k < lines.length && indentOf(lines[k]) > baseIndent) {
              for (; i < k; i++) body.push('')
              continue
            }
            break
          }
          const indent = indentOf(l)
          if (indent > baseIndent) {
            if (child < 0) child = indent
            body.push(l.replace(/\t/g, '    ').slice(Math.min(indent, child)))
            i++
          } else break
        }
        items.push(parseBlocks(body))
      }
      out.push({ t: 'list', ordered: isOrdered, start, items })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      out.push({
        t: 'table',
        align: head.map((_, k) => align[k] ?? null),
        head: head.map(parseInline),
        rows: rows.map(r => head.map((_, k) => parseInline(r[k] ?? ''))),
      })
      continue
    }
    // A paragraph: lines up to a blank one or the start of another kind of block.
    const para: string[] = [line.replace(/\s+$/, '')]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].replace(/\s+$/, ''))
    out.push({ t: 'p', c: parseInline(para.join('\n')) })
  }
  return out
}

export function parseMarkdown(src: string): MdBlock[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'))
}
