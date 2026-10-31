// F-051: the memory layer's search, without any I/O: the words index (BM25), the meaning
// scores (cosine over normalised vectors, made by embedder.ts) and how the two are fused.
//
// Measured on the feature log (features.html: Shubham's own words for each of 49 features,
// finding that feature among all of their notes; and 38 exact names taken from the notes,
// file names, ports, ids), first hit / mean reciprocal rank:
//                        his words        exact names
//   words alone          32 / 0.764       38 / 1.000
//   meaning alone        43 / 0.910       16 / 0.556    (bge-base-en-v1.5)
//   RRF, equal weights   42 / 0.897       25 / 0.794
//   fused as here        44 / 0.919       37 / 0.987
// Words find what is named exactly; meaning finds what is said another way, with typos and
// Hinglish. The fusion trusts words in proportion to how much of the query (by rarity) the
// best words hit holds: a query that is one file name, all found in one place, goes by words;
// a sentence most of whose words aren't found together goes by meaning.

/**
 * The words of a text, lowercased: runs of letters and digits, and code-like names
 * (shared/rustdesk/client.ts, sad-touch-mode, 100.64.0.0) both whole and in their parts.
 */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []) {
    out.push(w)
    if (/[._/-]/.test(w)) for (const part of w.split(/[._/-]+/)) if (part.length > 1) out.push(part)
  }
  return out
}

const K1 = 1.2
const B = 0.75

export interface WordHit {
  id: string
  score: number
}

/** BM25 over documents kept in memory, changed one at a time. */
export class WordIndex {
  private docs = new Map<string, { tf: Map<string, number>; len: number }>()
  private df = new Map<string, number>()
  private totalLen = 0

  get size() {
    return this.docs.size
  }

  has(id: string) {
    return this.docs.has(id)
  }

  set(id: string, text: string) {
    this.remove(id)
    const words = terms(text)
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1)
    this.docs.set(id, { tf, len: words.length })
    this.totalLen += words.length
  }

  remove(id: string) {
    const d = this.docs.get(id)
    if (!d) return
    for (const w of d.tf.keys()) {
      const n = (this.df.get(w) ?? 1) - 1
      if (n > 0) this.df.set(w, n)
      else this.df.delete(w)
    }
    this.totalLen -= d.len
    this.docs.delete(id)
  }

  /** How rare a word is; a word no document has counts as the rarest there could be. */
  idf(word: string): number {
    const n = this.docs.size
    const df = this.df.get(word)
    if (!df) return Math.log(1 + (n + 0.5) / 0.5)
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /** Best first; only documents holding at least one of the query's words. */
  search(query: string, limit = 50, filter?: (id: string) => boolean): WordHit[] {
    const q = [...new Set(terms(query))].filter(w => this.df.has(w))
    if (!q.length || !this.docs.size) return []
    const avg = this.totalLen / this.docs.size || 1
    const idfs = q.map(w => this.idf(w))
    const out: WordHit[] = []
    for (const [id, d] of this.docs) {
      if (filter && !filter(id)) continue
      let s = 0
      for (let i = 0; i < q.length; i++) {
        const f = d.tf.get(q[i])
        if (!f) continue
        s += (idfs[i] * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg))
      }
      if (s > 0) out.push({ id, score: s })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }

  /** How much of the query (weighted by rarity) document `id` holds, 0..1. */
  coverage(query: string, id: string): number {
    const d = this.docs.get(id)
    const q = [...new Set(terms(query))]
    if (!d || !q.length) return 0
    let all = 0
    let found = 0
    for (const w of q) {
      const idf = this.idf(w)
      all += idf
      if (d.tf.has(w)) found += idf
    }
    return all ? found / all : 0
  }
}

/** Cosine similarity of two vectors already normalised to length 1. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export interface FusedHit {
  id: string
  /** 0..1, for ordering this query's hits. */
  score: number
  /** The cosine, when there was a meaning score. */
  meaning: number | null
  /** This hit's share of the query's words, by rarity. */
  words: number
}

/** How much the meaning score counts against words: 0.8 with no words found together, 0.2 with all of them. */
export const meaningWeight = (coverage: number) => 0.8 - 0.6 * coverage * coverage

/**
 * Words and meaning, fused. `meaning` is best first (cosines), or null when the model isn't
 * ready (then words alone); `words` best first (BM25). `coverageOf` tells a hit's share of
 * the query's words. Each list is normalised over its own top 50.
 */
export function fuse(meaning: WordHit[] | null, words: WordHit[], coverageOf: (id: string) => number, limit = 20): FusedHit[] {
  const top = meaning?.slice(0, 50) ?? []
  const wtop = words.slice(0, 50)
  const dmax = top[0]?.score ?? 0
  const dmin = top[top.length - 1]?.score ?? 0
  const bmax = wtop[0]?.score || 1
  const cos = new Map(top.map(h => [h.id, h.score]))
  const bm = new Map(wtop.map(h => [h.id, h.score]))
  const a = meaning ? meaningWeight(wtop.length ? coverageOf(wtop[0].id) : 0) : 0
  const ids = new Set([...cos.keys(), ...bm.keys()])
  const out: FusedHit[] = []
  for (const id of ids) {
    const c = cos.get(id)
    const d = c === undefined ? 0 : dmax > dmin ? (c - dmin) / (dmax - dmin) : 1
    const w = (bm.get(id) ?? 0) / bmax
    out.push({ id, score: a * d + (1 - a) * w, meaning: c ?? null, words: bm.has(id) ? coverageOf(id) : 0 })
  }
  out.sort((x, y) => y.score - x.score)
  return out.slice(0, limit)
}

/** The best `limit` by cosine to `q` among `vectors`. */
export function nearest(q: Float32Array, vectors: Iterable<[string, Float32Array]>, limit = 50, filter?: (id: string) => boolean): WordHit[] {
  const out: WordHit[] = []
  for (const [id, v] of vectors) {
    if (filter && !filter(id)) continue
    out.push({ id, score: cosine(q, v) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------------------------
// Pages in sections

export interface Section {
  /** 0, 1, 2... in the page's order. */
  n: number
  heading: string | null
  text: string
}

const SECTION_MAX = 1400
const PIECE = 1000

/** A page's body in sections, by heading; a long section in pieces at paragraph breaks. */
export function sections(body: string): Section[] {
  const out: Section[] = []
  let heading: string | null = null
  let lines: string[] = []
  let inFence = false
  const flush = () => {
    const text = lines.join('\n').trim()
    lines = []
    if (!text) return
    for (const piece of pieces(text)) out.push({ n: out.length, heading, text: piece })
  }
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = inFence ? null : /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      heading = h[1]
      continue
    }
    lines.push(line)
  }
  flush()
  return out
}

function pieces(text: string): string[] {
  if (text.length <= SECTION_MAX) return [text]
  const out: string[] = []
  let cur = ''
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length + 2 > PIECE) {
      out.push(cur)
      cur = ''
    }
    if (para.length > SECTION_MAX) {
      for (let i = 0; i < para.length; i += PIECE) out.push(para.slice(i, i + PIECE))
      continue
    }
    cur = cur ? `${cur}\n\n${para}` : para
  }
  if (cur) out.push(cur)
  return out
}

/** A snippet of `text` near the first of the query's words it holds, about `max` characters. */
export function snippet(text: string, query: string, max = 320): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const lower = flat.toLowerCase()
  let at = -1
  for (const w of terms(query).sort((a, b) => b.length - a.length)) {
    if (w.length < 3) continue
    at = lower.indexOf(w)
    if (at >= 0) break
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3))
  const cut = flat.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${cut}${start + max < flat.length ? '…' : ''}`
}
