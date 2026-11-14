import { randomBytes } from 'node:crypto'
import type { CardGoneReason, FastServerFrame, TalkCard } from '../../shared/fast.ts'
import type { Origin } from './fast.ts'

// F-221 (ob98a): live talk's tap-to-send cards. The rule that rules everything: spoken words never approve, pay, delete or publish.
//   - A hand-off made while the asking connection HOLDS (its `hold` latch, shared/fast.ts) is typed nowhere: it waits on his screen as a card with
//     the exact words ('handoff').
//   - A message the Orchestrator wants to send to another chat while live talk's direct line holds its tools (talk-latch.ts) waits the same way
//     ('relay'). It is filed with the hub, not with a socket: the page reads it with its order (and in GET /talk/cards).
// Only his tap sends a card: POST /agentic/talk/cards/<id>/send, with his signed-in CRM session (index.ts), the version he was shown, once. The
// marker "he tapped Send" is written by that route alone; every other text the hub types has lookalikes made harmless (neutralizeMarks).
// Cards live in memory only: an Update drops them, which is the safe side (nothing was sent).

/** A card waits this long for his tap, then it expires. */
export const CARD_TTL_MS = 10 * 60_000
/** At most this many cards wait at once: the oldest goes (as expired) for a new one. */
export const MAX_CARDS = 20
/** The longest hand-off card text, his edit included (the hand-off limit). */
export const CARD_TEXT_MAX = 4000

/** The words only the card route writes into a chat (in its sender label: "[message from Quick (spoken, he tapped Send), order oX]"). */
export const TAPPED_MARK = 'he tapped Send'

// Review of T2: a lookalike is judged on the text as it LOOKS, its skeleton: each character decomposed to its compatibility form (NFKD: fullwidth
// and mathematical letters become plain ones, and a precomposed \u00e9 is e and its accent), then left out when it is drawn as nothing or as a gap (see
// SKIP), letters of other scripts drawn like Latin ones read as those (LOOKS_LIKE), all in lower case.
/**
 * Left out of the skeleton (fix round 2, decision 8): format characters, default-ignorable code points and the blanks drawn as nothing; every mark
 * (after NFKD the accent of a precomposed letter is one); and the modifier letters and symbols (\p{Lm} such as \u02bc \u02d1 \u0640, \p{Sk} such as \u02c2 ` ^): small
 * or drawn as nothing, they read as a gap, between the two words or inside one.
 */
const SKIP = /[\p{Cf}\p{M}\p{Lm}\p{Sk}\p{Default_Ignorable_Code_Point}\u2800\u3164\u115f\u1160\uffa0]/u
/**
 * Letters and signs of other scripts drawn like Latin ones, by the character after NFKD and before lower case (Greek capital Nu is N, small nu is v),
 * and once more after lower case (fix round 3: a capital not named here reads as its small form does).
 * Fix round 2 (decision 8): every Latin-looking lookalike of the marker's letters t, a, p, e, d, s and n that the Unicode confusables data lists for
 * Cyrillic, Greek, Armenian, Coptic, Cherokee, Lisu, Canadian syllabics, small capitals and the Latin and APL letters with no decomposition (the
 * fullwidth and mathematical ones are plain letters after NFKD). Fix round 3: the Cherokee small letters (read through their capitals, above),
 * Coptic small alfa, eie and ni, and the hooked, barred, stroked, curled and tilded Latin forms of those seven letters. A few other letters are kept
 * for words around the marker.
 */
const LOOKS_LIKE: Readonly<Record<string, string>> = {
  // t
  '\u0422': 't', '\u0442': 't', '\u04ac': 't', '\u04ad': 't', '\u03a4': 't', '\u03c4': 't', '\u2ca6': 't', '\u2ca7': 't', '\u13a2': 't', '\ua4d4': 't', '\u1d1b': 't', '\u0166': 't', '\u0167': 't',
  '\u22a4': 't', '\u27d9': 't',
  // Fix round 3: the hooked, curled, tilded and barred Latin t (their capitals are read through these, after lower case).
  '\u01ad': 't', '\u0288': 't', '\u01ab': 't', '\u0236': 't', '\u2c66': 't', '\u1d75': 't',
  // a
  '\u0410': 'a', '\u0430': 'a', '\u0391': 'a', '\u03b1': 'a', '\u0251': 'a', '\u237a': 'a', '\u13aa': 'a', '\ua4ee': 'a', '\u15c5': 'a', '\u1d00': 'a',
  // Fix round 3: Coptic small alfa, the barred and stroked a and alpha, the turned alpha, the a with a retroflex hook.
  '\u2c81': 'a', '\uab30': 'a', '\u2c65': 'a', '\u0252': 'a', '\u1d8f': 'a',
  // p
  '\u0420': 'p', '\u0440': 'p', '\u048e': 'p', '\u048f': 'p', '\u03a1': 'p', '\u03c1': 'p', '\u2ca2': 'p', '\u2ca3': 'p', '\u2374': 'p', '\u13e2': 'p', '\ua4d1': 'p', '\u146d': 'p', '\u1d18': 'p',
  // Fix round 3: the hooked, stroked, tilded and flourished Latin p.
  '\u01a5': 'p', '\u1d7d': 'p', '\ua751': 'p', '\ua753': 'p', '\ua755': 'p', '\u1d71': 'p', '\u1d88': 'p',
  // T4 phase 2 (the T2 check's last strings, Unicode's confusables data maps each to p): Latin thorn and wynn (no decomposition), Greek small
  // sho, Coptic small and capital tau rho (their capitals read through the small forms too: \u00de, \u01f7, \u03f7).
  '\u00fe': 'p', '\u01bf': 'p', '\u03f8': 'p', '\u2ccf': 'p', '\u2cce': 'p',
  // e
  '\u0415': 'e', '\u0435': 'e', '\u04bd': 'e', '\u04bf': 'e', '\u0395': 'e', '\u03b5': 'e', '\u13ac': 'e', '\ua4f0': 'e', '\u2d39': 'e', '\u212e': 'e', '\uab32': 'e', '\u22ff': 'e', '\u1d07': 'e',
  // Fix round 3: the stroked, hooked, notched and flourished Latin e, the open e (like the Greek epsilon above), Coptic small eie.
  '\u0247': 'e', '\u1d92': 'e', '\u2c78': 'e', '\uab34': 'e', '\u025b': 'e', '\u2c89': 'e',
  // d
  '\u0501': 'd', '\u13a0': 'd', '\ua4d3': 'd', '\u146f': 'd', '\u15de': 'd', '\u15ea': 'd', '\u1d05': 'd', '\u0110': 'd', '\u0111': 'd', '\u00d0': 'd',
  // Fix round 3: the hooked, tailed, curled, tilded, topbarred and insular Latin d.
  '\u0257': 'd', '\u0256': 'd', '\u0221': 'd', '\u1d6d': 'd', '\u1d81': 'd', '\u1d91': 'd', '\u018c': 'd', '\ua77a': 'd',
  // s
  '\u0405': 's', '\u0455': 's', '\u054f': 's', '\u13da': 's', '\u13d5': 's', '\ua4e2': 's', '\u01bd': 's', '\ua731': 's',
  // Fix round 3: the hooked, swash-tailed, tilded and stroked Latin s.
  '\u0282': 's', '\u023f': 's', '\u1d74': 's', '\u1d8a': 's', '\ua7a9': 's', '\ua7ca': 's',
  // n
  '\u039d': 'n', '\u03b7': 'n', '\u043f': 'n', '\u0578': 'n', '\u057c': 'n', '\ua4e0': 'n', '\u0274': 'n',
  // Fix round 3: the hooked, long-legged, curled, tilded and stroked Latin n, the eng, Coptic small ni.
  '\u0273': 'n', '\u0272': 'n', '\u019e': 'n', '\u0235': 'n', '\u1d70': 'n', '\u1d87': 'n', '\ua7a5': 'n', '\ua791': 'n', '\u014b': 'n', '\u2c9b': 'n',
  // T4 phase 2: the Canadian syllabics letter drawn as N (Unicode's confusables data: 11ABE ; 004E), past the Basic Multilingual Plane.
  '\u{11abe}': 'n',
  // Other letters (the words around the marker)
  '\u0412': 'b', '\u0392': 'b', '\u04ba': 'h', '\u04bb': 'h', '\u041d': 'h', '\u0397': 'h', '\u0406': 'i', '\u0456': 'i', '\u0399': 'i', '\u03b9': 'i', '\u0408': 'j', '\u0458': 'j', '\u041a': 'k', '\u039a': 'k',
  '\u03ba': 'k', '\u041c': 'm', '\u039c': 'm', '\u041e': 'o', '\u043e': 'o', '\u039f': 'o', '\u03bf': 'o', '\u0421': 'c', '\u0441': 'c', '\u0423': 'y', '\u0443': 'y', '\u03a5': 'y', '\u03c5': 'u', '\u0425': 'x',
  '\u0445': 'x', '\u03a7': 'x', '\u03c7': 'x', '\u0396': 'z', '\u03bd': 'v', '\u04cf': 'l', '\u051b': 'q', '\u051d': 'w',
}

/**
 * Fix round 3: the Cherokee small letters (U+AB70-ABBF, U+13F8-13FD) are drawn as smaller forms of the capitals, so they are read through those
 * (Unicode's upper case of each is its capital; the table has the capitals that look Latin).
 */
const CHEROKEE_SMALL = /[\uab70-\uabbf\u13f8-\u13fd]/u

/** The text as it looks (see above), with where each of its UTF-16 units came from in the original (start and end of that character). */
function skeleton(text: string): { s: string; from: number[]; to: number[] } {
  let s = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const ch of text) {
    const end = at + ch.length
    // Decomposed first: a modifier letter that is a small plain letter (\u1d43) reads as that letter; one that is not (\u02bc) is a gap.
    for (const k of ch.normalize('NFKD')) {
      if (SKIP.test(k)) continue
      const base = CHEROKEE_SMALL.test(k) ? k.toUpperCase() : k
      for (const u of (LOOKS_LIKE[base] ?? base).toLowerCase()) {
        if (SKIP.test(u)) continue
        // The table again after lower case (fix round 3): a capital it does not name reads as its small form does (\u01ae as \u0288, a t).
        const v = LOOKS_LIKE[u] ?? u
        s += v
        for (let i = 0; i < v.length; i++) {
          from.push(at)
          to.push(end)
        }
      }
    }
    at = end
  }
  return { s, from, to }
}

// "tapped" and "send" with nothing but non-letters between them (spaces of any kind, punctuation, or nothing), in the skeleton.
const LOOKALIKE = /tapped[^\p{L}]*send/gu

/**
 * F-221 (ob98a): a lookalike of the tapped marker made harmless: "tapped Send" becomes "tapped [Send]". Called on every text the hub types into a
 * chat except his card's own sender label: hand-off texts, direct-mode lines, messages relayed between chats, broadcasts, order replies, phone
 * asks and the heartbeat. "spoken, not tapped" is left as it is: it only lowers trust. Review of T2: it is found by how the text looks (a
 * Cyrillic a, fullwidth letters, an invisible character or a hyphen between the words), and only the original "send" is put in brackets; a "send"
 * already in brackets is left alone, so it can be called twice.
 */
export function neutralizeMarks(text: string): string {
  const k = skeleton(text)
  let out = ''
  let done = 0
  for (const m of k.s.matchAll(LOOKALIKE)) {
    const end = m.index + m[0].length
    const start = end - 'send'.length
    if (k.s[start - 1] === '[' && k.s[end] === ']') continue
    const a = k.from[start]
    const b = k.to[end - 1]
    if (a < done) continue
    out += `${text.slice(done, a)}[${text.slice(a, b)}]`
    done = b
  }
  return done ? out + text.slice(done) : text
}

/**
 * F-221: a card's words (and a direct-mode line): control characters become spaces, square brackets are removed (so the words can never close the
 * marker they are typed after, or forge one; review of T2: their fullwidth forms too), one tidy line, lookalikes made harmless.
 */
export function cleanCardText(text: string): string {
  const plain = Array.from(text, c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : /[[\]]/.test(c.normalize('NFKC')) ? '' : c)).join('')
  return neutralizeMarks(plain.replace(/\s+/g, ' ').trim())
}

/** A relay card's held tool call: the Orchestrator's chat (`from`) sending `text` to chat `sessionId`. */
export interface HeldRelay {
  tool: 'send_to_chat' | 'app_send_to_chat'
  from: string
  sessionId: string
}

export interface CardRecord {
  card: TalkCard
  /** The connection it is shown on (and goes with); null: no socket (a relay held for a direct-mode line, read by polling). */
  conn: string | null
  /** A hand-off card: where it was asked (his tap sends it as an order from there). */
  origin?: Origin
  /** A relay card: the held tool call. */
  relay?: HeldRelay
  /** A relay card: the spoken orders that held it (GET /talk/ask/<orderId> lists it). */
  orders: string[]
  /** His tap is being carried out: a second tap waits its turn (409), a drop meanwhile takes effect when it is over. */
  sending: boolean
  /** A drop asked for while it was being sent (applied if the send does not go through). */
  doomed: CardGoneReason | null
}

export interface NewCard {
  kind: TalkCard['kind']
  to: string
  text: string
  via: TalkCard['via']
  conn: string | null
  origin?: Origin
  relay?: HeldRelay
  orders?: string[]
}

export type CardTake = { ok: true; rec: CardRecord } | { ok: false; status: 404 | 409; reason: string }

export interface TalkCards {
  /** A new card: shown on its connection (a `card` frame) when it has one. */
  create(c: NewCard): TalkCard
  get(id: string): CardRecord | null
  /** The cards waiting now (oldest first), all or those of one connection or one spoken order. */
  list(filter?: { conn?: string; order?: string }): TalkCard[]
  /** One card goes (his drop on the page); false when there is no such card. */
  dropCard(id: string, reason: CardGoneReason): boolean
  /** A connection's cards go: one (`card`) or all. How many went. */
  dropConn(conn: string, reason: CardGoneReason, card?: string): number
  /** His tap: the card, if it is still there and is the version he saw. It is his alone until settle(). */
  take(id: string, version: number): CardTake
  /** The tap is over: sent (the card is used up: card-gone 'sent', with the order) or not (it waits again, so he can tap again). */
  settle(id: string, sent: boolean, orderId?: string): void
  /** Cards past their 10 minutes go (the hub calls this every second). */
  sweep(): void
}

export interface TalkCardsDeps {
  now(): number
  /** A frame to a connection (fast.ts tell); false when it is closed. */
  tell(conn: string, frame: FastServerFrame): boolean
  log?: { info(m: string): void }
  /** Tests: shorter. */
  ttlMs?: number
  max?: number
}

export function createTalkCards(deps: TalkCardsDeps): TalkCards {
  const ttl = deps.ttlMs ?? CARD_TTL_MS
  const max = deps.max ?? MAX_CARDS
  /** In the order they were made: the first is the oldest. */
  const cards = new Map<string, CardRecord>()
  const copy = (c: TalkCard): TalkCard => ({ ...c })
  const live = (r: CardRecord) => r.card.expiresAt > deps.now()

  /** A card goes: card-gone to its connection while that is open. The log has its id, kind and why; never its words. */
  function gone(r: CardRecord, reason: CardGoneReason, orderId?: string) {
    cards.delete(r.card.id)
    if (r.conn) deps.tell(r.conn, { t: 'card-gone', id: r.card.id, reason, ...(orderId ? { orderId } : {}) })
    deps.log?.info(`talk card ${r.card.id} (${r.card.kind}): ${reason}${orderId ? ` as order ${orderId}` : ''}`)
  }

  /** A drop: at once, or (while his tap is being carried out) when the tap is over and did not send it. */
  function drop(r: CardRecord, reason: CardGoneReason): boolean {
    if (r.sending) {
      r.doomed ??= reason
      return true
    }
    gone(r, reason)
    return true
  }

  function sweep() {
    for (const r of [...cards.values()]) if (!live(r) && !r.sending) gone(r, 'expired')
  }

  return {
    create(c) {
      sweep()
      // Too many waiting: the oldest one not being sent makes room.
      while (cards.size >= max) {
        const oldest = [...cards.values()].find(r => !r.sending)
        if (!oldest) break
        gone(oldest, 'expired')
      }
      const at = deps.now()
      const card: TalkCard = { id: `c${randomBytes(6).toString('hex')}`, version: 1, kind: c.kind, to: c.to, text: c.text, via: c.via, createdAt: at, expiresAt: at + ttl }
      const r: CardRecord = { card, conn: c.conn, ...(c.origin ? { origin: c.origin } : {}), ...(c.relay ? { relay: c.relay } : {}), orders: [...(c.orders ?? [])], sending: false, doomed: null }
      cards.set(card.id, r)
      if (r.conn) deps.tell(r.conn, { t: 'card', card: copy(card) })
      deps.log?.info(`talk card ${card.id} (${card.kind}) is waiting for his tap`)
      return copy(card)
    },
    get(id) {
      const r = cards.get(id)
      return r && live(r) ? r : null
    },
    list(filter = {}) {
      return [...cards.values()]
        .filter(r => live(r) && (filter.conn === undefined || r.conn === filter.conn) && (filter.order === undefined || r.orders.includes(filter.order)))
        .map(r => copy(r.card))
    },
    dropCard(id, reason) {
      const r = cards.get(id)
      return r ? drop(r, reason) : false
    },
    dropConn(conn, reason, card) {
      let n = 0
      for (const r of [...cards.values()]) {
        if (r.conn !== conn || (card !== undefined && r.card.id !== card)) continue
        if (drop(r, reason)) n++
      }
      return n
    },
    take(id, version) {
      const r = cards.get(id)
      if (!r || !live(r)) {
        if (r && !r.sending) gone(r, 'expired')
        return { ok: false, status: 404, reason: 'That card is gone: it was sent, dropped or has expired.' }
      }
      if (r.sending) return { ok: false, status: 409, reason: 'That card is being sent now.' }
      if (r.card.version !== version) return { ok: false, status: 409, reason: 'The card changed. Check it and tap Send again.' }
      r.sending = true
      return { ok: true, rec: r }
    },
    settle(id, sent, orderId) {
      const r = cards.get(id)
      if (!r) return
      r.sending = false
      if (sent) return gone(r, 'sent', orderId)
      if (r.doomed) return gone(r, r.doomed)
    },
    sweep,
  }
}
