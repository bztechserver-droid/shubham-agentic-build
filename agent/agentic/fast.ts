import { MAX_ASKS_PER_MIN, orderTurn, parseClientFrame, type CardGoneReason, type FastModel, type FastServerFrame, type FastState, type HandoffPhase } from '../../shared/fast.ts'
import { namesFor, type Names } from '../../shared/fast-names.ts'
import type { WsSocket } from '../api.ts'

// F-086/F-087: the fast Assistant's session: who owns it, the two sockets (the page's and Chris's), the turn frames out, and the way a request handed
// to the Orchestrator finds its way back to where it was asked. The warm process itself is the host's (Connection: fast-host.ts); this talks to it
// through FastHostLike. The frames are in shared/fast.ts and agent/agentic/FAST-PROTOCOL.md.
//
// One owner at a time (a second client taking it puts the first at 'taken-over'). Asks are rate limited. A turn's frames go to the owner who asked,
// and only to it. A hand-off remembers where it was asked (the origin), so the Orchestrator's answer is shown there and then told by the Assistant in
// a turn of its own (id `o:<orderId>`); if nobody is there, the caller (orders) is told, and sends it as a Heartbeat / notification instead.
// F-221 (ob98a), live talk: each connection has a HOLD latch (the `hold` frame). While the owner's latch is on, the hub makes every hand-off of its
// asks a tap-to-send card (talk-cards.ts) instead of typing it. A connection's cards go with it: closed, taken over, its `drop` or its `stop`. An
// origin is only given for an ask that is really with the process now (never one cut off or still waiting to be written), so a late tool call of a
// turn that was cut off is never credited to the next ask.

export type HostEvent = Extract<FastServerFrame, { t: 'delta' | 'flush' | 'tool' | 'done' | 'error' }>
export type HostState = 'off' | 'starting' | 'ready' | 'paused' | 'unavailable'
export interface HostStatus {
  state: HostState
  reason?: string | null
  model?: FastModel | null
}

export type HostResult = { ok: true } | { ok: false; reason: string }

/** What the session needs from the host (Connection's fast-host.ts has exactly these). */
export interface FastHostLike {
  state(): HostState
  status(): HostStatus
  ask(turn: { id: string; text: string; model: FastModel; snapshot?: string; heard?: string }, emit: (e: HostEvent) => void): HostResult
  interrupt(id?: string): void
  deliver(note: string, turnId: string, emit: (e: HostEvent) => void): HostResult
  /** Claims the process for a client (starts it when memory allows). */
  open(who: string): Promise<HostResult>
  close(who: string): void
}

export interface FastDeps {
  /** The host; null when the Assistant is off (then the sockets are refused: ws() returns null). */
  host: FastHostLike | null
  /** The live snapshot text for the next turn (fast-brief.ts buildSnapshot of what the hub knows). */
  snapshot(): string | Promise<string>
  /** The names in force (Settings: What the chats are called), read at each use so a change takes hold at once. Left out: the old names. */
  names?(): Names
  now?(): number
  log?: { info(m: string): void; warn(m: string): void }
  /**
   * F-221 (ob98a): the tap-to-send cards (talk-cards.ts). With them this session can hold hand-offs as cards, and every state frame says
   * `holds: true`; a connection's cards are dropped when it closes, is taken over, or sends drop or stop. Left out (the old-app reader): no cards.
   */
  cards?: { dropConn(conn: string, reason: CardGoneReason, card?: string): number }
}

/** Where a request was asked: the owner's id and the ask. */
export interface Origin {
  kind: 'web' | 'phone'
  clientId: string
  askId: string
  /** F-221 (ob98a): the connection it was asked on (its cards are its own), whether that connection's HOLD latch is on, and how he asked. */
  conn: string
  hold: boolean
  via: 'voice' | 'typed'
}

export interface FastSession {
  /** The page's socket (kind web) or Chris's (kind phone); null when the Assistant is off. */
  socket(kind: 'web' | 'phone'): ((ws: WsSocket) => void) | null
  /** The host changed state (starting / ready / paused / unavailable): every connection is told. */
  hostState(status: HostStatus): void
  /**
   * The origin for a hand_off made right now: the owner and the turn it is in. Null when nobody owns the Assistant, and (F-221) when no ask of the
   * owner is with the process now: it was cut off (cancel), it still waits for the snapshot or the process, or the turn running is the hub's own o:.
   */
  currentOrigin(): Origin | null
  /** A hand-off was made (the hand_off tool, or his tap on a card): tells the origin's client. */
  handedOff(orderId: string, origin: Origin, line: string): void
  /** F-221 (ob98a): a frame to one connection by its id (a card shown or gone); false when it is closed or unknown. */
  tell(conn: string, frame: FastServerFrame): boolean
  progress(orderId: string, phase: HandoffPhase, sec: number, words?: string): void
  /** The Orchestrator answered (or the order was stopped). Returns 'told' when the Assistant is telling it where it was asked, 'no-listener' when nobody is there. */
  answered(orderId: string, request: string, reply: string, cancelled?: boolean): 'told' | 'no-listener'
  /** How many clients are connected (for the status). */
  clients(): number
  /** The hand-offs made here that have no answer yet. */
  openOrderIds(): string[]
  close(): void
}

interface Conn {
  /** F-221: this connection's own id (its cards are filed under it); never sent to a client, never taken from one. */
  id: string
  ws: WsSocket
  kind: 'web' | 'phone'
  clientId: string | null
  asks: number[]
  closed: boolean
  /** The host's open() for this client while it runs (a cold process starting): an ask that arrives meanwhile waits for it. */
  opening: Promise<HostResult> | null
  /** F-221 (ob98a): the HOLD latch (the `hold` frame); it counts only while this connection owns the Assistant. */
  hold: boolean
  /** F-221: the hub's own turns (o:<orderId>) told on this connection and not over yet: the only o: ids its cancel may name. */
  told: Set<string>
}

/** The ask being answered: who asked, how, whether a cancel cut it off, and (F-221) whether it has been given to the process yet. */
interface Active {
  id: string
  conn: Conn
  cancelled: boolean
  via: 'voice' | 'typed'
  sent: boolean
}

/** The note the Assistant is given when the big chat has answered: not his words, an answer to something it handed over. Worded with the names in force. */
export function answerNote(orderId: string, request: string, reply: string, cancelled?: boolean, n: Names = namesFor('old')): string {
  const ask = request.replace(/\s+/g, ' ').trim().slice(0, 200)
  const who = n.big.charAt(0).toUpperCase() + n.big.slice(1)
  const head = cancelled ? `[${who}'s request was stopped] You handed over (${orderId}): "${ask}".` : `[${who} answered] You handed over (${orderId}): "${ask}". Its answer:`
  const body = reply.length > 6000 ? `${reply.slice(0, 6000)}\n(cut: the full text is on his screen)` : reply
  return cancelled ? `${head}\nTell him in one sentence that it was stopped.` : `${head}\n${body}\nTell him the part he needs in one to three short sentences; the full text is already on his screen.`
}

export function createFastSession(deps: FastDeps): FastSession {
  const now = deps.now ?? Date.now
  const conns = new Set<Conn>()
  let owner: Conn | null = null
  let active: Active | null = null
  let model: FastModel = 'haiku'
  const origins = new Map<string, { conn: Conn; origin: Origin }>()
  let seq = 0
  /**
   * F-221 (ob98a, review of T2): the hold of each client id (web:<tab> / phone:<device>), kept across its connections. A reconnect (`start
   * {resume:true}`) takes it back at once: the page sends the asks it queued during the blip right after that start, before it can send hold again,
   * and those must be held too. Fix round 2 (decision 7): a resume can only RAISE hold, never lower it; a plain start begins with hold off (the page
   * and the bar send hold right after every start). Fix round 3: it is sticky per client id and owned by the connection that raised it (or took it
   * back with a resume): only that connection's `hold {on:false}` or its `stop` (End) clears it. Another connection with the same id (its plain
   * start, its own hold off, its stop) never does, and a connection that closed (a blip) leaves it for the next one. The newest 64 ids are kept.
   */
  const holds = new Map<string, { owner: string }>()
  const HOLDS_KEPT = 64
  const holdKey = (c: Conn) => `${c.kind}:${c.clientId}`
  /** This connection holds, and its client id with it: this connection owns that hold now. */
  function raiseHold(c: Conn) {
    c.hold = true
    if (!c.clientId) return
    const k = holdKey(c)
    holds.delete(k)
    holds.set(k, { owner: c.id })
    for (const old of holds.keys()) {
      if (holds.size <= HOLDS_KEPT) break
      holds.delete(old)
    }
  }
  /** This connection lets go (hold off, or End); its client id's hold goes too, but only when this connection owns it. */
  function lowerHold(c: Conn) {
    c.hold = false
    if (c.clientId && holds.get(holdKey(c))?.owner === c.id) holds.delete(holdKey(c))
  }

  const send = (c: Conn, f: FastServerFrame) => {
    if (c.closed) return
    try {
      c.ws.sendText(JSON.stringify(f))
    } catch {
      // A socket that cannot be written is closing; onClose will clear it.
    }
  }
  const who = (c: Conn) => `${c.kind}:${c.clientId ?? '?'}`
  /** F-221 (ob98a): every state frame says whether this hub can hold hand-offs as cards (the page offers live talk only then). */
  const state = (s: FastState, more: { reason?: string; model?: FastModel } = {}): FastServerFrame => ({ t: 'state', state: s, ...more, ...(deps.cards ? { holds: true } : {}) })
  /** F-221: a connection's cards go (closed, taken over, its drop or stop); the store sends card-gone while the connection is still open. */
  const dropCards = (c: Conn, reason: CardGoneReason, card?: string) => {
    try {
      deps.cards?.dropConn(c.id, reason, card)
    } catch (e) {
      deps.log?.warn(`fast Assistant: the cards of ${who(c)} could not be dropped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function stateFor(c: Conn): FastServerFrame {
    const host = deps.host
    if (!host) return state('off')
    if (c.clientId && owner && owner !== c) return state('taken-over')
    const st = host.status()
    // A switched-on host with no process yet ('off') is usable: the first start wakes it, which is what hello's fast.ready says too.
    if (st.state === 'off') return state('ready', st.model ? { model: st.model } : {})
    const map: Record<HostState, FastState> = { off: 'off', starting: 'starting', ready: 'ready', paused: 'paused', unavailable: 'unavailable' }
    return state(map[st.state] ?? 'unavailable', { ...(st.reason ? { reason: st.reason } : {}), ...(st.model ? { model: st.model } : {}) })
  }

  /** Wake the process for this client (a cold start takes a moment); asks that come meanwhile wait on `c.opening`. */
  function open(c: Conn): Promise<HostResult> {
    const p = Promise.resolve(deps.host!.open(who(c))).catch((e: unknown): HostResult => ({ ok: false, reason: e instanceof Error ? e.message : 'The Assistant could not be started.' }))
    c.opening = p
    void p.then(() => {
      if (c.opening === p) c.opening = null
    })
    return p
  }

  function release(c: Conn) {
    if (owner !== c) return
    owner = null
    if (active?.conn === c) {
      deps.host?.interrupt(active.id)
      active = null
    }
    deps.host?.close(who(c))
  }

  function forward(c: Conn, turnId: string) {
    return (e: HostEvent) => {
      // Frames of a turn go only to the client that asked, and only while it still owns the Assistant.
      if (owner !== c) return
      send(c, e)
      if (e.t === 'done' || (e.t === 'error' && e.id === turnId)) {
        if (active?.id === turnId) active = null
        c.told.delete(turnId)
      }
    }
  }

  function onFrame(c: Conn, raw: string) {
    const host = deps.host
    if (!host) return send(c, { t: 'error', status: 503, message: 'The Assistant is off.' })
    const p = parseClientFrame(raw)
    if (!p.ok) return send(c, { t: 'error', status: p.status, message: p.message })
    const f = p.frame
    switch (f.t) {
      case 'ping':
        return send(c, { t: 'pong' })
      case 'start': {
        if (f.client !== c.kind) return send(c, { t: 'error', status: 400, message: `This socket is for the ${c.kind}; start says ${f.client}.` })
        c.clientId = f.id
        if (f.model) model = f.model
        // F-221 (review of T2): a reconnect holds as this client did before the blip, and owns that hold from now (fix round 3); it never lowers
        // hold (fix round 2). A plain start begins with this connection's hold off and leaves the client's sticky hold as it is (fix round 3).
        if (!f.resume) c.hold = false
        else if (c.hold || holds.has(holdKey(c))) raiseHold(c)
        // A reconnect never takes it from a client that has it; a plain start does.
        if (owner && owner !== c && f.resume) return send(c, stateFor(c))
        // It is his from this moment, before the process is up: the host says 'starting' meanwhile, and an ask sent then waits for ready.
        const opening = open(c)
        if (owner && owner !== c) {
          const old = owner
          release(old)
          send(old, state('taken-over'))
          // F-221 (ob98a): cards follow ownership: the screen that lost the Assistant loses its cards (it is told card-gone, taken-over).
          dropCards(old, 'taken-over')
          deps.log?.info(`fast Assistant: ${who(c)} took it from ${who(old)}`)
        }
        owner = c
        void (async () => {
          const opened = await opening
          if (c.closed) {
            host.close(who(c))
            return
          }
          if (owner !== c) return
          if (!opened.ok) {
            // No process (memory is low, or it cannot start): the client is told, and sends its asks to the big chat.
            owner = null
            host.close(who(c))
            return send(c, state('paused', { reason: opened.reason }))
          }
          send(c, stateFor(c))
        })()
        return
      }
      case 'ask': {
        if (owner !== c) return send(c, { t: 'error', id: f.id, status: 409, message: owner ? 'Another screen has the Assistant now.' : 'Say start first.' })
        const t = now()
        c.asks = c.asks.filter(x => t - x < 60_000)
        if (c.asks.length >= MAX_ASKS_PER_MIN) return send(c, { t: 'error', id: f.id, status: 429, message: 'That is too many questions in a minute.' })
        const st = host.state()
        if (st === 'paused' || st === 'unavailable') return send(c, { t: 'error', id: f.id, status: 503, message: host.status().reason ?? 'The Assistant is not available right now.' })
        c.asks.push(t)
        // No process yet (it idled out, or the start is still going): it is woken, and this ask waits for it rather than being refused.
        if (st === 'off' && !c.opening) void open(c)
        // A new ask cuts the old one off (the host ends it with done {cancelled}).
        // F-221 (ob98a): it is no origin for a hand-off until it has been given to the process (`sent`): a late call of the turn before is not its.
        const entry: Active = { id: f.id, conn: c, cancelled: false, via: f.via, sent: false }
        active = entry
        const text = f.text
        const sonnet = f.thorough === true
        const heard = f.heard
        void (async () => {
          if (c.opening) {
            const o = await c.opening
            if (!o.ok) {
              if (active === entry) active = null
              return send(c, { t: 'error', id: entry.id, status: 503, message: o.reason })
            }
          }
          let snap = ''
          try {
            snap = await deps.snapshot()
          } catch {
            // Asked without the snapshot rather than not at all.
          }
          // Cut off while the snapshot was being made (a cancel, a newer ask, the client left): it was never sent, and says so.
          if (entry.cancelled || active !== entry || owner !== c) {
            if (owner === c) send(c, { t: 'done', id: entry.id, text: '', cancelled: true })
            return
          }
          const asked = host.ask({ id: entry.id, text, model: sonnet ? 'sonnet' : model, ...(snap ? { snapshot: snap } : {}), ...(heard ? { heard } : {}) }, forward(c, entry.id))
          if (!asked.ok) {
            active = null
            send(c, { t: 'error', id: entry.id, status: 503, message: asked.reason })
            return
          }
          entry.sent = true
        })()
        return
      }
      case 'cancel': {
        if (owner !== c) return
        // F-221 (ob98a): barge-in on the hub's own turn that tells a hand-off's answer: only one told on this connection, and only while it runs.
        if (f.id.startsWith('o:')) {
          if (c.told.has(f.id)) host.interrupt(f.id)
          return
        }
        if (active?.id === f.id) {
          active.cancelled = true
          host.interrupt(f.id)
        }
        return
      }
      case 'stop': {
        if (owner === c) {
          release(c)
          send(c, state('stopped'))
        }
        // F-221: End (or a stop word) drops this connection's cards too, and (fix round 3) lets go of its hold, its client's too when it owns it.
        lowerHold(c)
        dropCards(c, 'dropped')
        return
      }
      case 'hold':
        // F-221 (ob98a): the HOLD latch. It counts only while this connection owns the Assistant (currentOrigin says so); kept for its reconnect
        // (fix round 3: sticky per client id; only the connection that owns it lowers it).
        if (f.on) raiseHold(c)
        else lowerHold(c)
        return
      case 'drop':
        dropCards(c, 'dropped', f.card)
        return
    }
  }

  return {
    socket(kind) {
      if (!deps.host) return null
      return ws => {
        const c: Conn = { id: `k${++seq}`, ws, kind, clientId: null, asks: [], closed: false, opening: null, hold: false, told: new Set() }
        conns.add(c)
        send(c, stateFor(c))
        ws.onText(raw => onFrame(c, raw))
        ws.onClose(() => {
          c.closed = true
          conns.delete(c)
          release(c)
          for (const [id, o] of origins) if (o.conn === c) origins.delete(id)
          // F-221 (ob98a): its cards go with it (nobody is left to tap them).
          dropCards(c, 'closed')
        })
      }
    },
    hostState() {
      for (const c of conns) send(c, stateFor(c))
    },
    currentOrigin() {
      // F-221 (ob98a): fail closed. Only an ask that is with the process now: not one a cancel cut off, not one still waiting for the snapshot or
      // the process (the turn before it may still be running, and its late tool call would be credited here), never the hub's own o: turn.
      if (!owner || !owner.clientId || !active || active.conn !== owner || active.cancelled || !active.sent) return null
      return { kind: owner.kind, clientId: owner.clientId, askId: active.id, conn: owner.id, hold: owner.hold, via: active.via }
    },
    handedOff(orderId, origin, line) {
      const c = owner && owner.clientId === origin.clientId ? owner : null
      if (!c) return
      origins.set(orderId, { conn: c, origin })
      send(c, { t: 'handoff', id: origin.askId, orderId, line })
    },
    tell(conn, frame) {
      for (const c of conns) {
        if (c.id !== conn || c.closed) continue
        send(c, frame)
        return true
      }
      return false
    },
    progress(orderId, phase, sec, words) {
      const o = origins.get(orderId)
      if (o) send(o.conn, { t: 'handoff-progress', orderId, phase, sec, ...(words ? { words } : {}) })
    },
    answered(orderId, request, reply, cancelled) {
      const o = origins.get(orderId)
      const host = deps.host
      // The origin first; else whoever owns the Assistant now (a reconnect after a restart); else nobody.
      const c = o && !o.conn.closed && owner === o.conn ? o.conn : owner && !owner.closed ? owner : null
      if (!c || !host || host.state() !== 'ready') return 'no-listener'
      origins.delete(orderId)
      send(c, { t: 'handoff-answer', orderId, text: reply, ...(cancelled ? { cancelled: true } : {}) })
      // The text is on his screen now; if the Assistant cannot tell it too (it is restarting), that is logged and the screen has it.
      // F-221 (ob98a): this connection may cut the telling off (cancel o:<orderId>) while it runs.
      const turn = orderTurn(orderId)
      c.told.add(turn)
      const told = host.deliver(answerNote(orderId, request, reply, cancelled, deps.names?.()), turn, forward(c, turn))
      if (!told.ok) {
        c.told.delete(turn)
        deps.log?.warn(`fast Assistant: could not tell the answer of ${orderId}: ${told.reason}`)
      }
      return 'told'
    },
    clients: () => conns.size,
    openOrderIds: () => [...origins.keys()],
    close() {
      for (const c of [...conns]) {
        try {
          c.ws.close(1001, 'The app is stopping')
        } catch {
          // Already closed.
        }
      }
      conns.clear()
      owner = null
      active = null
      origins.clear()
    },
  }
}
