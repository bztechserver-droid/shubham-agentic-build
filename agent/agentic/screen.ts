import type { ChatMenu, ChatStatus } from '../../shared/chat.ts'

// F-050: what a chat's terminal shows right now, as text. The agent's chats are claude's TUI in a
// pseudo-terminal, and claude draws it with cursor moves and erases (Ink): the stream of what it
// printed isn't the screen. This is the small part of a terminal that makes it one: the cursor,
// printing, wrapping, line feeds and scrolling, and the erase, insert and delete sequences. Colours,
// modes and titles are skipped. It is for reading a few lines off the bottom of the screen (a menu
// that is waiting for an answer, the spinner line), not for drawing; checked against xterm's own
// parser on recordings of claude 2.1.316 (screen.test.ts).

export interface Screen {
  readonly cols: number
  readonly rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  /** The visible lines, top to bottom, trailing spaces cut. */
  lines(): string[]
}

const blank = (cols: number) => Array.from({ length: cols }, () => ' ')
const grid = (cols: number, rows: number) => Array.from({ length: rows }, () => blank(cols))

// What is printed but takes no cell of its own: combining marks, the zero width joiner and its kin, variation selectors.
function noWidth(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x200b && c <= 0x200d) || c === 0x2060 || (c >= 0xfe00 && c <= 0xfe0f) || /^\p{M}$/u.test(ch)
}

export function createScreen(cols0 = 120, rows0 = 32): Screen {
  let cols = Math.max(1, cols0)
  let rows = Math.max(1, rows0)
  let cells = grid(cols, rows)
  let x = 0
  let y = 0
  let wrapNext = false
  let saved = { x: 0, y: 0 }
  // The parser: plain text, after an escape, inside a CSI (its parameters), or inside a string (OSC and friends) up to its end.
  let mode: 'text' | 'esc' | 'csi' | 'str' | 'skip1' = 'text'
  let params = ''
  let strEsc = false

  const clampX = (v: number) => Math.max(0, Math.min(cols - 1, v))
  const clampY = (v: number) => Math.max(0, Math.min(rows - 1, v))

  function scrollUp(n: number) {
    for (let i = 0; i < n; i++) {
      cells.shift()
      cells.push(blank(cols))
    }
  }
  function scrollDown(n: number) {
    for (let i = 0; i < n; i++) {
      cells.pop()
      cells.unshift(blank(cols))
    }
  }
  function lineFeed() {
    if (y === rows - 1) scrollUp(1)
    else y++
  }
  function put(ch: string) {
    if (noWidth(ch)) return
    if (wrapNext) {
      x = 0
      lineFeed()
      wrapNext = false
    }
    cells[y][x] = ch
    if (x === cols - 1) wrapNext = true
    else x++
  }
  const clearRange = (row: number, from: number, to: number) => {
    for (let i = Math.max(0, from); i <= Math.min(cols - 1, to); i++) cells[row][i] = ' '
  }

  function csi(final: string) {
    const priv = /^[?>=!]/.test(params)
    const nums = params
      .replace(/^[?>=!]/, '')
      .split(/[;:]/)
      .map(s => (s === '' ? 0 : Number(s) || 0))
    const n = nums[0] || 1
    if (priv) return
    // A cursor move ends a wrap that was waiting; a colour change (m) or an erase doesn't.
    if ('ABCDEFGHfdu'.includes(final)) wrapNext = false
    switch (final) {
      case 'A':
        y = clampY(y - n)
        break
      case 'B':
        y = clampY(y + n)
        break
      case 'C':
        x = clampX(x + n)
        break
      case 'D':
        x = clampX(x - n)
        break
      case 'E':
        y = clampY(y + n)
        x = 0
        break
      case 'F':
        y = clampY(y - n)
        x = 0
        break
      case 'G':
        x = clampX(n - 1)
        break
      case 'd':
        y = clampY(n - 1)
        break
      case 'H':
      case 'f':
        y = clampY((nums[0] || 1) - 1)
        x = clampX((nums[1] || 1) - 1)
        break
      case 'J': {
        const m = nums[0] ?? 0
        if (m === 0) {
          clearRange(y, x, cols - 1)
          for (let r = y + 1; r < rows; r++) clearRange(r, 0, cols - 1)
        } else if (m === 1) {
          for (let r = 0; r < y; r++) clearRange(r, 0, cols - 1)
          clearRange(y, 0, x)
        } else cells = grid(cols, rows)
        break
      }
      case 'K': {
        const m = nums[0] ?? 0
        if (m === 0) clearRange(y, x, cols - 1)
        else if (m === 1) clearRange(y, 0, x)
        else clearRange(y, 0, cols - 1)
        break
      }
      case 'L':
        for (let i = 0; i < Math.min(n, rows - y); i++) {
          cells.splice(y, 0, blank(cols))
          cells.pop()
        }
        break
      case 'M':
        for (let i = 0; i < Math.min(n, rows - y); i++) {
          cells.splice(y, 1)
          cells.push(blank(cols))
        }
        break
      case 'P':
        cells[y].splice(x, Math.min(n, cols - x))
        while (cells[y].length < cols) cells[y].push(' ')
        break
      case '@':
        for (let i = 0; i < Math.min(n, cols - x); i++) {
          cells[y].splice(x, 0, ' ')
          cells[y].pop()
        }
        break
      case 'X':
        clearRange(y, x, x + n - 1)
        break
      case 'S':
        scrollUp(n)
        break
      case 'T':
        scrollDown(n)
        break
      case 's':
        saved = { x, y }
        break
      case 'u':
        x = saved.x
        y = saved.y
        break
      default:
      // Colours (m), modes (h, l), reports (n, c), scroll regions (r): nothing on screen.
    }
  }

  function feed(ch: string) {
    if (mode === 'text') {
      const c = ch.charCodeAt(0)
      if (c === 0x1b) mode = 'esc'
      else if (c === 0x0d) {
        x = 0
        wrapNext = false
      } else if (c === 0x0a || c === 0x0b || c === 0x0c) {
        wrapNext = false
        lineFeed()
      } else if (c === 0x08) {
        x = clampX(x - 1)
        wrapNext = false
      } else if (c === 0x09) {
        x = clampX((Math.floor(x / 8) + 1) * 8)
        wrapNext = false
      } else if (c >= 0x20 && c !== 0x7f) put(ch)
      return
    }
    if (mode === 'esc') {
      mode = 'text'
      if (ch === '[') {
        mode = 'csi'
        params = ''
      } else if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
        mode = 'str'
        strEsc = false
      } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#' || ch === '%' || ch === ' ') mode = 'skip1'
      else if (ch === '7') saved = { x, y }
      else if (ch === '8') {
        x = saved.x
        y = saved.y
      } else if (ch === 'M') {
        wrapNext = false
        if (y === 0) scrollDown(1)
        else y--
      } else if (ch === 'c') {
        cells = grid(cols, rows)
        x = y = 0
        wrapNext = false
      } else if (ch === 'D') {
        wrapNext = false
        lineFeed()
      } else if (ch === 'E') {
        x = 0
        wrapNext = false
        lineFeed()
      }
      return
    }
    if (mode === 'csi') {
      const c = ch.charCodeAt(0)
      if (c >= 0x40 && c <= 0x7e) {
        mode = 'text'
        csi(ch)
      } else if (c === 0x1b) mode = 'esc'
      else if (params.length < 64) params += ch
      return
    }
    if (mode === 'skip1') {
      mode = 'text'
      return
    }
    // A string: ends with BEL or ESC \ .
    if (ch === '\u0007') mode = 'text'
    else if (strEsc && ch === '\\') {
      mode = 'text'
      strEsc = false
    } else strEsc = ch === '\u001b'
  }

  return {
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    write(data) {
      for (const ch of data) feed(ch)
    },
    resize(c, r) {
      const nc = Math.max(1, Math.floor(c))
      const nr = Math.max(1, Math.floor(r))
      if (nc === cols && nr === rows) return
      const next = grid(nc, nr)
      for (let i = 0; i < Math.min(rows, nr); i++) for (let j = 0; j < Math.min(cols, nc); j++) next[i][j] = cells[i][j]
      cells = next
      cols = nc
      rows = nr
      x = clampX(x)
      y = clampY(y)
      wrapNext = false
    },
    lines() {
      return cells.map(r => r.join('').replace(/\s+$/, ''))
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the screen

const OPTION_RE = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/
const RULE_RE = /^\s*[─━-]{8,}\s*$/
const FOOTER_RE = /Enter to (?:select|confirm)|Esc to cancel/i
const CHIP_RE = /^\s*[☐☑✔☒]\s*(.+?)\s*$/

/**
 * A question claude is waiting on: its footer ("Enter to select · ↑/↓ to navigate · Esc to cancel"
 * or "Enter to confirm") with the numbered options above it (claude's own AskUserQuestion, a
 * permission prompt, the trust menu). A number typed answers it. Null when none is up.
 */
export function readMenu(lines: string[]): ChatMenu | null {
  let f = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) {
      f = i
      break
    }
  }
  if (f < 0) return null
  const block = lines.slice(Math.max(0, f - 40), f)
  const first = block.findIndex(l => OPTION_RE.test(l))
  if (first < 0) return null

  const options: ChatMenu['options'] = []
  for (let i = first; i < block.length; i++) {
    const l = block[i]
    const m = OPTION_RE.exec(l)
    if (m) options.push({ n: Number(m[1]), label: m[2], description: '', selected: /^\s*❯/.test(l) })
    else if (l.trim() && !RULE_RE.test(l) && options.length && /^\s{3,}\S/.test(l)) {
      const last = options[options.length - 1]
      last.description = last.description ? `${last.description} ${l.trim()}` : l.trim()
    }
  }

  // What is asked: the nearest line above the options that is neither a rule nor the header chip.
  let header = ''
  let question = ''
  for (let i = first - 1; i >= 0; i--) {
    const l = block[i]
    if (!l.trim() || RULE_RE.test(l)) continue
    const chip = CHIP_RE.exec(l)
    if (chip) {
      header = chip[1]
      break
    }
    if (!question) question = l.trim()
  }
  const multi = options.some(o => /^\[[ xX✔]\]/.test(o.label))
  return { header, question, options, hint: lines[f].trim(), multi }
}

const SPINNER_RE = /^\s*[✻✽✶✢✳·*⏺]\s+(\S.*?…)\s*(?:\(([^)]*)\))?\s*$/

/** What claude says it is doing while it works: "Pollinating… (5s · ↓ 167 tokens)". Null when it isn't working. */
export function readStatus(lines: string[]): ChatStatus | null {
  // Only while its footer says it can be interrupted: the spinner glyphs also mark finished lines.
  if (!lines.some(l => /esc to interrupt/i.test(l))) return null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SPINNER_RE.exec(lines[i])
    if (!m) continue
    const extra = m[2] ?? ''
    const time = /(?:(\d+)m\s*)?(\d+)s/.exec(extra)
    const tokens = /([\d.,]+k?)\s*tokens/i.exec(extra)
    return { text: m[1], secs: time ? Number(time[1] ?? 0) * 60 + Number(time[2]) : null, tokens: tokens?.[1] ?? null }
  }
  return null
}
