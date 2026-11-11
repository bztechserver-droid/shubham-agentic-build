import type { DraftMirrorState, DraftReport } from '../../shared/agentic.ts'

// F-193 (11 Nov 2026, Shubham: "make the chat to terminal such that it is exact in sync: if I type here then it should come there, it should be
// as such I'm typing on terminal"): the chat box and a Claude chat's terminal input line as ONE input. The terminal's input line is the one
// truth; this keeps it equal to what the person has in the chat box, and tells every chat box what the line holds.
//
// Only keys proved on the real Claude Code 2.1.322 are typed (a private claude.exe in a scratch pty, C:\saw\mirror-20261111\probe-keys*.log):
//  - text: bracketed pastes of at most CHUNK characters with no line break. Claude turns a paste of more than 800 characters, or with more than
//    two line breaks (fewer on a terminal of 11 rows or less), into a "[Pasted text #N]" chip; a chunk never gets there.
//  - a line break: Ctrl+J (Claude's chat:newline); a delete: Backspace (one character);
//  - clear everything: Ctrl+K (to the line's end, and the line break there) then Ctrl+U (to the line's start, and the line break before),
//    each repeated: that empties any input from any cursor place.
// Never Esc (stops a turn), Ctrl+C, Enter (submits; only the sender presses it, at Send), Up (history), Tab, Ctrl+L (only redraws), Ctrl+S
// (stashes, and Claude puts it back after the next submit). No key while a menu or prompt is up, while the screen cannot be read, or while a
// message is being delivered, and none during a burst of output (a menu may be on its way). Logs say counts and states, never the words.

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const CTRL_J = '\n'
const BACKSPACE = '\u007f'
const CTRL_K = '\u000b'
const CTRL_U = '\u0015'
/** Characters per paste; Claude's chip begins above 800. */
const CHUNK = 400
/** What the line is kept equal to at most; longer goes in at Send, the old way (Claude's box reader stops at 64 rows). */
export const MIRROR_MAX_CHARS = 1500
export const MIRROR_MAX_LINES = 40
/** Another agent's message waits (refused, try again shortly) while he typed in a chat box this recently. Lead's choice (3e), 11 Nov. */
export const MIRROR_TYPING_MS = 20_000
/** A text just sent is never typed back by a late copy of itself for this long. */
export const MIRROR_FENCE_MS = 10_000
/** The mirror's own text taken out for another message must be typed back within this, or the mirror stops (the chat box keeps it). */
export const MIRROR_RESTORE_MS = 20_000
/**
 * A take-out that no message follows (its paste was refused right after: a question came up, his own send was on its way): once nothing
 * holds keys and the line is still empty, his text goes back at once, looked at this long after the take-out and then every UNUSED_POLL_MS.
 * Lead, 11 Nov: "after a take-out, if the paste is then refused, type his words back at once".
 */
export const MIRROR_UNUSED_MS = 400
const UNUSED_POLL_MS = 200

/** What may be typed: line breaks as \n, a tab as four spaces (Claude does the same to a paste), no control or direction-override characters. */
export function mirrorText(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
}
/** The comparison key: the screen cannot show whitespace exactly (a wrap and a line break look alike), so it is left out, as the sender does. */
// oxlint-disable-next-line no-misleading-character-class
export const mirrorKey = (s: string) => s.replace(/[\s\u200b-\u200f\u2060-\u2064\ufe00-\ufe0f]/g, '')

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
/** User-perceived characters: one Backspace takes one. */
export const graphemes = (s: string): string[] => (segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s))

/** The keys that type `text` at the cursor: pastes of at most CHUNK characters (never split inside a character), Ctrl+J for each line break. */
export function typingKeys(text: string): string {
  let out = ''
  text.split('\n').forEach((line, i) => {
    if (i > 0) out += CTRL_J
    let chunk = ''
    for (const g of graphemes(line)) {
      if (chunk.length + g.length > CHUNK) {
        out += PASTE_START + chunk + PASTE_END
        chunk = ''
      }
      chunk += g
    }
    if (chunk) out += PASTE_START + chunk + PASTE_END
  })
  return out
}
/** Empties the input from any cursor place: enough Ctrl+K and Ctrl+U for every row twice over; more are no-ops. */
export const clearKeys = (rows: number) => {
  const n = 2 * Math.max(1, Math.floor(rows)) + 2
  return CTRL_K.repeat(n) + CTRL_U.repeat(n)
}
/** Backspaces over what differs, then the new tail: valid only with the cursor at the end of `from`. */
export function editKeys(from: string, to: string): string {
  const p = commonPrefix(from, to)
  return BACKSPACE.repeat(graphemes(from).length - p.length) + typingKeys(graphemes(to).slice(p.length).join(''))
}
/** The characters two texts share at their start. */
export function commonPrefix(a: string, b: string): { length: number; text: string } {
  const x = graphemes(a)
  const y = graphemes(b)
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  return { length: p, text: x.slice(0, p).join('') }
}
/** Too long to keep in the box: it goes in at Send, as before. */
const tooLong = (t: string) => t.length > MIRROR_MAX_CHARS || t.split('\n').length > MIRROR_MAX_LINES
/**
 * "!" at the start of an empty box is Claude's shell mode ("#" was its memory note) and "/" opens its command list: never typed live; Send
 * puts it in as before. (With the "/" list open the sender cannot read the box, so a live "/..." could not be sent with Enter only.)
 */
const modeStart = (t: string) => /^[!#/]/.test(t)

/** The terminal's input box as it is drawn now. */
export interface MirrorBox {
  /** Its typed text (Claude's grey suggestion and placeholder blanked), the rows joined with single spaces. */
  text: string
  /** A "[Pasted text #N]" chip is in it. */
  chip: boolean
  /** How many screen rows it takes. */
  rows: number
  /** The terminal cursor (Claude parks it at the input cursor) is after the last typed character; null: cannot be told. */
  atEnd: boolean | null
}

/** What the mirror needs from its chat: chats.ts gives the real one, the tests a fake Claude. */
export interface MirrorHost {
  /** Raw keys into the terminal. Not a person's keystroke: the input epoch is not touched. */
  write(data: string): boolean
  /** The box now; null when none is drawn (a menu, another screen) or the screen cannot be read. */
  read(): MirrorBox | null
  /** Why no key may be typed now (a menu, a delivery, the chat gone), or null. */
  hold(): string | null
  /** Counts a person's keys into this terminal (chats.input/press): a change means someone else typed. */
  epoch(): number
  /** Milliseconds since the terminal last printed. */
  quietMs(): number
  /** Diagnostics: counts and states only. */
  log?(line: string): void
}

export interface MirrorClient {
  send(m: DraftReport): void
}

export interface MirrorOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The agent-side switch (input-mirror.off, SAD_INPUT_MIRROR=0): no keys, no take-out, every page keeps the old way. */
  off?: () => boolean
  /** Why this chat is not mirrored (Codex, Codex in Claude Code...), or null. */
  unsupported?: () => string | null
  /** Quiet wanted before a look at the screen (settleMs) and before a key (quietMs: a menu being drawn is output). */
  settleMs?: number
  quietMs?: number
  /** How long a typed edit may take to show on the screen, and how often it is looked at meanwhile. */
  verifyMs?: number
  pollMs?: number
  restoreMs?: number
}

export type TakeOut = 'none' | 'taken' | 'typing' | 'failed' | 'foreign'

export interface InputMirror {
  /** A mode=draft socket joins: told at once what the line holds. Returns detach. */
  attach(client: MirrorClient): () => void
  /** A chat box's whole text. `base`: the line version that chat box last saw; `seal`: this exact text is being sent now. */
  set(client: MirrorClient, seq: number, text: string, base: number, seal?: boolean): void
  /** The terminal printed, or a person typed in it: look again once it settles. */
  poke(): void
  /** The line holds exactly the mirror's own confirmed text (not empty), read now. */
  owned(): boolean
  /** He typed in a chat box in the last MIRROR_TYPING_MS. */
  typing(): boolean
  /** The mirror is typing or taking out right now: the line is between two states and nothing else may be pasted. */
  busy(): boolean
  /**
   * Before another message goes in: take the mirror's own text out of the line (one cycle, a hard time-out), to be typed back after it.
   * 'none': nothing in the line; 'foreign': the line holds text that is not the mirror's (never touched); 'typing': he typed in the last
   * MIRROR_TYPING_MS (refuse: try again shortly); 'failed': the line did not empty in time (refuse; the mirror's text is put back).
   * `force`: his own send from a chat box (no typing wait, nothing typed back).
   */
  takeOut(force?: boolean): Promise<TakeOut>
  /** A delivery ended: what was submitted (null: nothing, or not known) and whether it was his own send from a chat box. */
  delivered(submitted: string | null, human: boolean): void
  /** The line holds exactly `text` (whitespace aside) and no chip: his Send may press Enter only. */
  holds(text: string): boolean
  state(): DraftMirrorState
  dispose(): void
}

export function createInputMirror(host: MirrorHost, o: MirrorOptions = {}): InputMirror {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const off = () => o.off?.() === true
  const unsupported = () => o.unsupported?.() ?? null
  const settleMs = o.settleMs ?? 150
  const wantQuiet = o.quietMs ?? 100
  const verifyMs = o.verifyMs ?? 1500
  const pollMs = o.pollMs ?? 40
  const restoreMs = o.restoreMs ?? MIRROR_RESTORE_MS
  const clients = new Set<MirrorClient>()
  /** The newest text a chat box asked for (who asked, with which seq), and whether the line shows it already. */
  let desired: string | null = null
  let applied = true
  let asker: { client: MirrorClient; seq: number } | null = null
  /** The mirror's own text in the line, read back after typing it, and the person-key count then. null: the line is not the mirror's. */
  let model: string | null = null
  let modelEpoch = -1
  /** Every change of the line counts up; `foreign` is the count at the last change the mirror did not make. */
  let line = 0
  let foreign = 0
  let seen: { key: string; chip: boolean } | null = null
  let lastReport = ''
  let stopped: string | null = null
  let paused: string | null = null
  /** The mirror's text is out of the line for another message; typed back after it. */
  let heldOut = false
  /**
   * After a take-out, until his text is typed back: the line may hold that other message. It is never cleared, never offered to a chat box
   * as his words; his text goes back only into an empty line (Lead, 11 Nov: the chat box stays the truth, his words are never lost).
   */
  let guard = false
  let restoreTimer: ReturnType<typeof setTimeout> | null = null
  /** Looks whether a message followed the take-out at all (MIRROR_UNUSED_MS). */
  let unusedTimer: ReturnType<typeof setTimeout> | null = null
  let lastSetAt = -Infinity
  /** His own send of this (whitespace-free) text was just submitted; `sealed`: his chat box said so, so no late copy can follow. */
  let sent: { key: string; until: number; sealed: boolean } | null = null
  let sealKey: { key: string; until: number } | null = null
  /** A text skipped as a late copy of a send: looked at again when the fence ends (it may have been new typing after all). */
  let skipped: { client: MirrorClient; seq: number; text: string } | null = null
  let fenceTimer: ReturnType<typeof setTimeout> | null = null
  let lookTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const counts = { applied: 0, cleared: 0, retried: 0, takenOut: 0, restored: 0 }

  // One worker: an edit, a take-out or a clean-up never overlap. A job still waiting when the chat ends answers its fallback.
  const jobs: { run: () => Promise<void>; cancel: () => void }[] = []
  let pumping = false
  /** A kick while the worker runs: it looks once more before it rests. */
  let again = false
  /**
   * The mirror's own keys are on their way or being read back (an edit, a clean-up, a take-out): the line is between two states. Not
   * `pumping`: the worker also runs a moment after its last job (its idle tail), and a message pasted right after a take-out answered must not
   * be refused for that (live in build 1923, 11 Nov evening: every agent message to a chat with an open mirror was refused).
   */
  let editing = 0
  async function editingWhile<T>(fn: () => Promise<T>): Promise<T> {
    editing++
    try {
      return await fn()
    } finally {
      editing--
    }
  }
  async function pump(): Promise<void> {
    if (disposed) return
    if (pumping) {
      again = true
      return
    }
    pumping = true
    again = false
    try {
      for (let pass = 0; pass < 200 && !disposed; pass++) {
        const job = jobs.shift()
        if (job) {
          await job.run()
          continue
        }
        if (!(await step())) break
      }
    } finally {
      pumping = false
      if (!disposed) tellState()
    }
    if ((jobs.length || again) && !disposed) void pump()
  }
  const exclusive = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (disposed) return Promise.resolve(fallback)
    return new Promise<T>(resolve => {
      jobs.push({ run: () => fn().then(resolve, () => resolve(fallback)), cancel: () => resolve(fallback) })
      void pump()
    })
  }

  const ownedBox = (b: MirrorBox | null): boolean =>
    !!b && model !== null && modelEpoch === host.epoch() && !b.chip && b.atEnd !== false && mirrorKey(b.text) === mirrorKey(model)

  function state(): DraftMirrorState {
    if (off()) return 'off'
    if (unsupported()) return 'unsupported'
    if (stopped) return 'stopped'
    if (desired !== null && tooLong(desired)) return 'too-long'
    if (heldOut || paused || (desired !== null && modeStart(desired))) return 'paused'
    if (desired !== null && !applied) return 'syncing'
    return 'synced'
  }
  const reason = (): string | undefined => {
    if (off() || unsupported()) return unsupported() ?? undefined
    if (stopped) return stopped
    if (heldOut) return 'delivering'
    if (desired !== null && modeStart(desired) && !tooLong(desired)) return 'mode'
    return paused ?? undefined
  }

  function tell(kind: DraftReport['from'], text: string, exact: boolean, chip: boolean, only?: MirrorClient, ack?: { client: MirrorClient; seq: number } | null) {
    const st = state()
    const why = reason()
    const sig = JSON.stringify([kind, text, exact, chip, st, why ?? null, line, ack?.seq ?? null])
    if (!only && sig === lastReport) return
    if (!only) lastReport = sig
    for (const c of only ? [only] : [...clients]) {
      try {
        c.send({ t: 'draft', v: 1, text, from: kind, seq: ack && ack.client === c ? ack.seq : null, exact, chip, state: st, line, ...(why ? { reason: why } : {}) })
      } catch {
        // That page is gone; its detach follows.
      }
    }
  }
  /** What the line holds now: the mirror's exact text when it is its own; while its text is out for another message, still that text. */
  function current(): { kind: DraftReport['from']; text: string; exact: boolean; chip: boolean } {
    if (heldOut || guard) return { kind: 'mirror', text: desired ?? model ?? '', exact: true, chip: false }
    const b = host.read()
    if (!b) return { kind: 'terminal', text: '', exact: false, chip: false }
    if (ownedBox(b)) return { kind: 'mirror', text: model!, exact: true, chip: false }
    return { kind: 'terminal', text: b.text, exact: false, chip: b.chip }
  }
  function tellState(only?: MirrorClient, hello = false) {
    const c = current()
    tell(hello ? 'hello' : c.kind, c.text, c.exact, c.chip, only)
  }
  const stop = (why: string) => {
    stopped = why
    host.log?.(`input mirror stopped (${why}); applied ${counts.applied}, cleared ${counts.cleared}, retried ${counts.retried}, taken out ${counts.takenOut}, typed back ${counts.restored}`)
  }
  /** Counts a change of the line; true when it changed since last seen. */
  const note = (b: MirrorBox) => {
    const key = mirrorKey(b.text)
    if (seen && seen.key === key && seen.chip === b.chip) return false
    seen = { key, chip: b.chip }
    line++
    return true
  }

  /** A hold that stops keys; `allow`: the delivery that asked for a take-out does not stop its own take-out. */
  const holding = (allow?: string) => {
    const h = host.hold()
    return h !== null && h !== allow
  }
  /**
   * Waits for a quiet terminal (a menu being drawn is output), then checks, right before writing, that nothing holds keys, a box is there,
   * nobody typed in the terminal since `epoch` and (`still`) the text being made is still the newest.
   */
  async function typeSafely(keys: string, epoch: number, allow?: string, still: () => boolean = () => true): Promise<boolean> {
    if (!keys) return true
    for (let waited = 0; host.quietMs() < wantQuiet && waited < 1000; waited += 20) await sleep(20)
    if (holding(allow) || !host.read() || host.epoch() !== epoch || !still()) return false
    return host.write(keys)
  }
  /** Reads the line until it shows `want` (whitespace aside) with the cursor after it, or a person types, or a menu comes, or time is up. */
  async function readBack(want: string, epoch: number, allow?: string): Promise<'ok' | 'interrupted' | 'timeout'> {
    const key = mirrorKey(want)
    for (let waited = 0; waited <= verifyMs; waited += pollMs) {
      await sleep(pollMs)
      if (host.epoch() !== epoch || holding(allow)) return 'interrupted'
      const b = host.read()
      if (b && !b.chip && mirrorKey(b.text) === key && b.atEnd !== false) return 'ok'
    }
    return 'timeout'
  }

  /**
   * Deletes, then types: written apart, each read back before the next (real Claude 2.1.322 lost a Ctrl+K/U run followed by a paste in the
   * same write while it was still taking in typed keys: the old text stayed and the paste went after it).
   */
  async function edit(del: string, delWant: string, add: string, want: string, epoch: number): Promise<'ok' | 'interrupted' | 'timeout' | 'held'> {
    const still = () => desired === want
    if (del) {
      if (!(await typeSafely(del, epoch, undefined, still))) return 'held'
      const r = await readBack(delWant, epoch)
      if (r !== 'ok') return r
    }
    if (add && !(await typeSafely(add, epoch, undefined, still))) return 'held'
    return readBack(want, epoch)
  }

  /** The line made `want`: an edit at the end when the line is the mirror's own, else clear it all and type it all; read back; one retry. */
  async function apply(want: string): Promise<'ok' | 'paused' | 'stopped'> {
    const first = host.read()
    if (!first || host.hold()) return 'paused'
    const epoch = host.epoch()
    if (model !== null && model === want && ownedBox(first)) return 'ok'
    if (!first.chip && !ownedBox(first) && mirrorKey(first.text) === mirrorKey(want)) {
      // Not the mirror's, but already the chat box's words (typed back after a failed take-out, or the same words typed there): the
      // mirror's own from now on (a take-out puts back what the chat box has anyway).
      model = want
      modelEpoch = epoch
      return 'ok'
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const b = attempt === 0 ? first : host.read()
      if (!b || host.hold()) return 'paused'
      if (guard && (b.chip || (b.text !== '' && !ownedBox(b)))) {
        // The other message is still in the line: his text waits for it to go.
        paused = 'other-message'
        return 'paused'
      }
      // A pasted block typed in the terminal is never cleared: its words exist nowhere else.
      if (b.chip) {
        stop('chip')
        return 'stopped'
      }
      const own = attempt === 0 && ownedBox(b)
      if (attempt === 1) counts.retried++
      if (!own) counts.cleared++
      let r: Awaited<ReturnType<typeof edit>>
      if (own) {
        const p = commonPrefix(model!, want)
        r = await edit(BACKSPACE.repeat(graphemes(model!).length - p.length), p.text, typingKeys(graphemes(want).slice(p.length).join('')), want, epoch)
      } else r = await edit(clearKeys(b.rows), '', typingKeys(want), want, epoch)
      model = null
      if (r === 'held') return 'paused'
      if (r === 'ok') {
        model = want
        modelEpoch = epoch
        counts.applied++
        return 'ok'
      }
      if (r === 'interrupted') return 'paused'
    }
    stop('verify')
    return 'stopped'
  }

  /** Takes the mirror's own text out of the line (too long now, "!" first, a late copy of a send). Never touches text that is not its own. */
  async function removeOwn(): Promise<void> {
    const b = host.read()
    if (!b || !ownedBox(b) || b.text === '') return
    const epoch = host.epoch()
    if (!(await typeSafely(clearKeys(b.rows), epoch))) return
    counts.cleared++
    if ((await readBack('', epoch)) === 'ok') {
      model = ''
      modelEpoch = epoch
    } else model = null
  }

  /** One pass of the worker: the newest text made the line's. False: nothing to do, or it has to wait. */
  async function step(): Promise<boolean> {
    if (off() || unsupported() || stopped || heldOut || applied || desired === null) return false
    const want = desired
    const by = asker
    if (tooLong(want) || modeStart(want)) {
      await editingWhile(removeOwn)
      if (desired === want) applied = true
      return true
    }
    const hold = host.hold()
    if (hold) {
      paused = hold
      return false
    }
    const r = await editingWhile(() => apply(want))
    if (r === 'paused') {
      paused ??= 'busy'
      return false
    }
    paused = null
    if (r === 'stopped') return false
    if (guard) {
      guard = false
      clearRestore()
      counts.restored++
    }
    if (desired === want) applied = true
    const b = host.read()
    if (b) note(b)
    tell('mirror', want, true, false, undefined, by)
    return true
  }

  /** The line looked at after it settled: a change the mirror did not make is said to every chat box. */
  function look() {
    lookTimer = null
    if (disposed) return
    if (pumping) {
      schedule()
      return
    }
    const b = host.read()
    const hold = host.hold()
    if (!b || hold) {
      const was = paused
      paused = hold ?? 'unreadable'
      if (paused !== was) tellState()
      return
    }
    const empty = b.text === '' && !b.chip
    // After a take-out's hard time-out an empty line still gets his text back.
    if (guard && empty && stopped === 'restore-timeout') stopped = null
    // A menu went away, the screen is readable again, or the other message left the line: the newest text is typed (at the end, below,
    // once a change made in the terminal has been taken into account: that may cancel it).
    const wasPaused = paused !== null
    paused = null
    if (heldOut || guard) {
      // His text goes back once the line is empty; until then nothing in the line is his, nor anybody's to take.
      if (guard && !applied) void pump()
      if (wasPaused) tellState()
      return
    }
    const changed = note(b)
    if (changed && ownedBox(b)) tell('mirror', model!, true, false)
    else if (changed) {
      // Not the mirror's doing: typed, or sent, in the terminal.
      const was = model
      if (was !== null && was !== '' && empty) sent = { key: mirrorKey(was), until: now() + MIRROR_FENCE_MS, sealed: false }
      model = empty ? '' : null
      modelEpoch = host.epoch()
      // Emptied while a chat box's newest text waited (a send went through meanwhile): typing into an empty line takes nothing from anyone.
      // Anything else typed there wins over what was waiting: nothing of it is overwritten.
      if (!(empty && desired !== null && !applied)) {
        foreign = line
        desired = null
        applied = true
      }
      if (stopped && stopped !== 'chip') stopped = null
      tell('terminal', b.text, false, b.chip)
    } else if (wasPaused) tellState()
    if (!applied && desired !== null) void pump()
  }
  function schedule() {
    if (lookTimer || disposed) return
    lookTimer = setTimeout(look, settleMs)
    ;(lookTimer as { unref?: () => void }).unref?.()
  }
  function clearRestore() {
    if (restoreTimer) clearTimeout(restoreTimer)
    restoreTimer = null
    if (unusedTimer) clearTimeout(unusedTimer)
    unusedTimer = null
  }
  /** Another message went in after the mirror's text was taken out (or none came): typed back, only into an empty line (the guard), by the worker. */
  function giveBack() {
    heldOut = false
    if (unusedTimer) clearTimeout(unusedTimer)
    unusedTimer = null
    void exclusive(async () => {
      await sleep(settleMs)
      const b = host.read()
      if (b && b.text === '' && !b.chip) {
        model = ''
        modelEpoch = host.epoch()
      }
      paused = null
      applied = false
      schedule()
    }, undefined)
  }
  /**
   * After a take-out: if nothing holds keys (no delivery on its way, no question) and the line is still empty, no message followed it (the
   * caller's paste was refused): his text goes back now instead of after MIRROR_RESTORE_MS. A message on its way holds keys ('delivering')
   * until delivered() gives back; one stuck in the line makes it not empty: both wait as before.
   */
  function watchUnused(since: number) {
    const check = () => {
      unusedTimer = null
      if (disposed || !heldOut) return
      const b = host.read()
      if (host.hold() === null && b && b.text === '' && !b.chip) {
        host.log?.(`input mirror: nothing followed a take-out; typed back (taken out ${counts.takenOut})`)
        giveBack()
        return
      }
      if (now() - since < restoreMs) {
        unusedTimer = setTimeout(check, UNUSED_POLL_MS)
        ;(unusedTimer as { unref?: () => void }).unref?.()
      }
    }
    unusedTimer = setTimeout(check, MIRROR_UNUSED_MS)
    ;(unusedTimer as { unref?: () => void }).unref?.()
  }
  function fenceEnds() {
    if (fenceTimer) clearTimeout(fenceTimer)
    fenceTimer = setTimeout(() => {
      fenceTimer = null
      const s = skipped
      skipped = null
      if (s && clients.has(s.client)) api.set(s.client, s.seq, s.text, line)
    }, MIRROR_FENCE_MS)
    ;(fenceTimer as { unref?: () => void }).unref?.()
  }

  const api: InputMirror = {
    attach(client) {
      clients.add(client)
      const b = host.read()
      if (b && !heldOut && !pumping) note(b)
      tellState(client, true)
      return () => {
        clients.delete(client)
        if (asker?.client === client) asker = null
      }
    },

    set(client, seq, text, base, seal) {
      if (disposed) return
      if (off() || unsupported()) {
        tellState(client)
        return
      }
      const want = mirrorText(text)
      const key = mirrorKey(want)
      if (seal) {
        sealKey = { key, until: now() + MIRROR_FENCE_MS }
        if (sent && now() < sent.until && key !== '' && sent.key.startsWith(key)) {
          // His send came before this seal: what the mirror typed in the line since is a late copy; take it out (only the mirror's own text).
          sent.sealed = true
          desired = null
          applied = true
          skipped = null
          void exclusive(() => editingWhile(removeOwn), undefined)
          return
        }
      } else if (sent && !sent.sealed && now() < sent.until && key !== '' && sent.key.startsWith(key)) {
        // A copy of what was just sent (or part of it) that crossed the Send on the network: never typed back.
        skipped = { client, seq, text }
        fenceEnds()
        tellState(client)
        return
      }
      lastSetAt = now()
      if (base < foreign && heldOut === false) {
        const c = current()
        if (mirrorKey(c.text) !== key) {
          // Typed in the terminal after this chat box last saw the line: not overwritten. That chat box is told what the line holds now.
          tell(c.kind, c.text, c.exact, c.chip, client)
          return
        }
      }
      if (stopped && stopped !== 'chip') stopped = null
      if (stopped === 'chip' && !host.read()?.chip) stopped = null
      skipped = null
      desired = want
      applied = false
      asker = { client, seq }
      void pump()
    },

    poke() {
      if (disposed || (clients.size === 0 && desired === null && model === null && !heldOut)) return
      schedule()
    },

    owned() {
      if (off() || heldOut) return false
      const b = host.read()
      return !!b && ownedBox(b) && b.text !== ''
    },

    typing: () => !off() && now() - lastSetAt < MIRROR_TYPING_MS,

    busy: () => !off() && editing > 0,

    takeOut(force = false) {
      if (off() || disposed) return Promise.resolve('none' as TakeOut)
      return exclusive(() => editingWhile(async (): Promise<TakeOut> => {
        const b = host.read()
        if (!b || (b.text === '' && !b.chip)) return 'none'
        if (heldOut || !ownedBox(b)) return 'foreign'
        if (!force && now() - lastSetAt < MIRROR_TYPING_MS) return 'typing'
        const restoreText = desired ?? model ?? ''
        const epoch = host.epoch()
        heldOut = true
        if (!(await typeSafely(clearKeys(b.rows), epoch, 'delivering'))) {
          heldOut = false
          return 'failed'
        }
        counts.takenOut++
        if ((await readBack('', epoch, 'delivering')) !== 'ok') {
          // Not empty in time: nothing of the other message is typed; the mirror's text is put back as it was.
          heldOut = false
          model = null
          desired = restoreText
          applied = false
          host.log?.(`input mirror: a take-out did not empty the line in time (taken out ${counts.takenOut})`)
          return 'failed'
        }
        model = ''
        modelEpoch = epoch
        if (force) {
          // His own send: the chat box's text goes in with the send itself; nothing is typed back.
          heldOut = false
          desired = null
          applied = true
          return 'taken'
        }
        desired = restoreText
        applied = false
        guard = true
        clearRestore()
        restoreTimer = setTimeout(() => {
          // Hard time-out: not typed back yet. The mirror stops (the chat box keeps his words; the line stays guarded, so the other
          // message is never cleared and his text still goes back once the line is empty).
          restoreTimer = null
          if (!heldOut && !guard) return
          heldOut = false
          stop('restore-timeout')
          tellState()
        }, restoreMs)
        ;(restoreTimer as { unref?: () => void }).unref?.()
        watchUnused(now())
        return 'taken'
      }), 'none')
    },

    delivered(submitted, human) {
      if (disposed) return
      if (human) {
        if (submitted !== null) {
          const key = mirrorKey(mirrorText(submitted))
          const sealed = !!sealKey && now() < sealKey.until && sealKey.key !== '' && key.startsWith(sealKey.key)
          sent = { key, until: now() + MIRROR_FENCE_MS, sealed }
          sealKey = null
          desired = null
          applied = true
          heldOut = false
          guard = false
          clearRestore()
          model = ''
          modelEpoch = host.epoch()
        }
        schedule()
        return
      }
      if (!heldOut) {
        schedule()
        return
      }
      giveBack()
    },

    holds(text) {
      const b = host.read()
      const key = mirrorKey(mirrorText(text))
      return !!b && !b.chip && key !== '' && mirrorKey(b.text) === key
    },

    state,

    dispose() {
      disposed = true
      if (lookTimer) clearTimeout(lookTimer)
      if (fenceTimer) clearTimeout(fenceTimer)
      clearRestore()
      clients.clear()
      for (const job of jobs.splice(0)) job.cancel()
    },
  }
  return api
}
