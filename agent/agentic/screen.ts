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
  /**
   * The visible lines as typed: the dim and grey cells (claude's placeholder and its suggested next prompt, which sit in the
   * input box but are not text anyone typed) blanked out. A cursor drawn in reverse video on a line that has such text
   * (the first letter of a suggestion) is blanked too; on a line without any it stays (a draft with the cursor in it).
   */
  typedLines(): string[]
  /** F-193: where the terminal cursor is (column, row from 0). Claude Code 2.1.322 parks it at its input cursor, hidden or not. */
  cursor(): { x: number; y: number }
}

// A cell is its character, plus one of these when it was printed dim or grey (GHOST) or in reverse video (INVERSE). The marks ride along
// with the character through every move, erase, insert and scroll below, and are cut off again when the lines are read.
const GHOST = '\u0001'
const INVERSE = '\u0002'
const unmark = (s: string) => s.replaceAll(GHOST, '').replaceAll(INVERSE, '')
/** Whether an RGB colour is a grey in the range claude uses for its quiet text (153,153,153 and 136,136,136 in the recordings); white and black are not. */
const greyRgb = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) <= 12 && r >= 60 && r <= 200

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
  // How the next character is printed (SGR): dim, a grey foreground, reverse video.
  let dim = false
  let grey = false
  let inverse = false
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
    if (noWidth(ch)) {
      // Zero-width is not absent text. Keep accents/selectors/joiners on their
      // preceding cell, including at the wrap margin and across PTY chunks.
      // Cap a cell's payload; truncation fails ownership closed, not by
      // deleting the same characters from the expected message.
      const previous = wrapNext ? x : x - 1
      if (previous >= 0 && cells[y][previous].length < 128) cells[y][previous] += ch
      return
    }
    if (wrapNext) {
      x = 0
      lineFeed()
      wrapNext = false
    }
    cells[y][x] = ch + (dim || grey ? GHOST : '') + (inverse ? INVERSE : '')
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
      case 'm':
        for (let i = 0; i < nums.length; i++) {
          const v = nums[i]
          if (v === 0) dim = grey = inverse = false
          else if (v === 2) dim = true
          else if (v === 22) dim = false
          else if (v === 7) inverse = true
          else if (v === 27) inverse = false
          else if (v === 90) grey = true
          else if (v === 39 || (v >= 30 && v <= 37) || (v >= 91 && v <= 97)) grey = false
          else if (v === 38 || v === 48) {
            // An extended colour: 5;n (the 256 palette) or 2;r;g;b. Only a foreground can be grey.
            const kind = nums[i + 1]
            if (kind === 2) {
              if (v === 38) grey = greyRgb(nums[i + 2], nums[i + 3], nums[i + 4])
              i += 4
            } else if (kind === 5) {
              if (v === 38) grey = nums[i + 2] === 8 || (nums[i + 2] >= 238 && nums[i + 2] <= 250)
              i += 2
            }
          }
        }
        break
      default:
      // Modes (h, l), reports (n, c), scroll regions (r): nothing on screen.
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
      return cells.map(r => unmark(r.join('')).replace(/\s+$/, ''))
    },
    cursor() {
      return { x, y }
    },
    typedLines() {
      return cells.map(r => {
        const quiet = r.some(c => c.includes(GHOST))
        return r
          .map(c => (c.includes(GHOST) || (quiet && c.includes(INVERSE)) ? ' ' : unmark(c)))
          .join('')
          .replace(/\s+$/, '')
      })
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
  return findMenu(lines)?.menu ?? null
}

/** A menu and where it sits in the lines: the line of its first option and of its footer. */
export interface MenuAt {
  menu: ChatMenu
  first: number
  footer: number
}

/**
 * readMenu, with its place. The options must be the ones that END AT THE FOOTER: walking up from the footer, only blank
 * lines, rules and indented description lines may come between it and the last option, and the numbers must run down to 1
 * without a gap. Anything else on the way (a "❯" line that is no option, a line of plain text: the next screen of a
 * dialog drawn under an older menu) means these options are not what the footer belongs to, so there is no menu to answer.
 * Options from an older screen, left above a newer footer, are therefore never picked up.
 */
export function findMenu(lines: string[]): MenuAt | null {
  let f = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) {
      f = i
      break
    }
  }
  if (f < 0) return null
  let at = -1
  let next = 0
  for (let i = f - 1; i >= Math.max(0, f - 40); i--) {
    const l = lines[i]
    const m = OPTION_RE.exec(l)
    if (m) {
      const n = Number(m[1])
      if (next && n !== next) return null
      at = i
      next = n - 1
      if (n === 1) break
      continue
    }
    if (!l.trim() || RULE_RE.test(l)) continue
    if (/^\s{3,}\S/.test(l) && !/^\s*❯/.test(l)) continue
    return null
  }
  if (at < 0 || next !== 0) return null
  const block = lines.slice(0, f)
  const first = at

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
  for (let i = first - 1; i >= Math.max(0, f - 40); i--) {
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
  return { menu: { header, question, options, hint: lines[f].trim(), multi }, first, footer: f }
}

const SPINNER_RE = /^\s*[✻✽✶✢✳·*⏺]\s+(\S.*?…)\s*(?:\(([^)]*)\))?\s*$/
const INTERRUPT_RE = /esc to interrupt/i
// Claude varies the verb (Crunched, Cooked, Worked, ...). The completion shape,
// not a particular verb or the optional middle dot, establishes a finished turn.
const FINISHED_RE = /^\s*(?:[✻✽✶✢✳·*⏺]\s+)?[a-z][a-z -]*\s+for\s+<?(?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?(?:ms|s)\s*(?:[·•]\s*)?done(?:\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)?\s*$/i

/** The newest input box separates response/activity rows from typed draft and footer rows. */
function activityFrame(lines: readonly string[]): { body: readonly string[]; footer: readonly string[] } {
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!RULE_RE.test(lines[i - 1]) || !/^\s*❯(?!\s*\d{1,2}\.\s)/.test(lines[i])) continue
    const end = lines.findIndex((line, n) => n > i && RULE_RE.test(line))
    if (end >= 0) return { body: lines.slice(0, i - 1), footer: lines.slice(end + 1) }
  }
  return { body: lines, footer: [] }
}

/** Explicit turn evidence on the rendered Claude screen; null during an incomplete paint. */
export function readTurnState(lines: readonly string[]): 'running' | 'idle' | null {
  const { body, footer } = activityFrame(lines)
  if (footer.some(line => INTERRUPT_RE.test(line))) return 'running'
  for (let i = body.length - 1; i >= 0; i--) {
    if (FINISHED_RE.test(body[i])) return 'idle'
    // A newer spinner prevents an older completed turn from ending the new one.
    if (SPINNER_RE.test(body[i])) return null
    if (INTERRUPT_RE.test(body[i])) return 'running'
  }
  return null
}

/** What claude says it is doing while it works: "Pollinating… (5s · ↓ 167 tokens)". Null when it isn't working. */
export function readStatus(lines: string[]): ChatStatus | null {
  const { body, footer } = activityFrame(lines)
  let interrupt = footer.some(line => INTERRUPT_RE.test(line))
  for (let i = body.length - 1; i >= 0; i--) {
    // Neither an older spinner nor its old interrupt footer survives a newer completion.
    if (FINISHED_RE.test(body[i])) return null
    if (INTERRUPT_RE.test(body[i])) interrupt = true
    const m = SPINNER_RE.exec(body[i])
    if (!m) continue
    if (!interrupt) return null
    const extra = m[2] ?? ''
    const time = /(?:(\d+)m\s*)?(\d+)s/.exec(extra)
    const tokens = /([\d.,]+k?)\s*tokens/i.exec(extra)
    return { text: m[1], secs: time ? Number(time[1] ?? 0) * 60 + Number(time[2]) : null, tokens: tokens?.[1] ?? null }
  }
  return null
}
