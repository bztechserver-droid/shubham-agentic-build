import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MeaningState } from '../../shared/memory.ts'
import type { Logger } from '../log.ts'

// F-051: meaning, for the memory layer's search: a small sentence-embedding model run on this
// PC (the hub) with onnxruntime-node, so no text leaves it and no key is needed. The model is
// fetched from Hugging Face into <state>/agent/models at first use (never into git or the
// build), its sha256 checked against the one Hugging Face states. Until it is ready, and if
// it can't be had (offline, or the package missing), search goes by words alone.
//
// bge-base-en-v1.5, 8-bit (110 MB): the best of the ones measured on Shubham's own words (see
// memory-search.ts), 0.3 s to load, about 150 MB of memory, 20-40 ms a query on this PC's CPU.
// SAD_MEMORY_MODEL picks another of MODELS (bge-small: 34 MB and 3x faster, a little worse).

interface ModelInfo {
  pooling: 'cls' | 'mean'
  /** Put before a query, and before a passage, as the model was trained. */
  query: string
  passage: string
  dims: number
}

export const MODELS: Record<string, ModelInfo> = {
  'Xenova/bge-base-en-v1.5': { pooling: 'cls', query: 'Represent this sentence for searching relevant passages: ', passage: '', dims: 768 },
  'Xenova/bge-small-en-v1.5': { pooling: 'cls', query: 'Represent this sentence for searching relevant passages: ', passage: '', dims: 384 },
  'Xenova/multilingual-e5-small': { pooling: 'mean', query: 'query: ', passage: 'passage: ', dims: 384 },
  'Xenova/all-MiniLM-L6-v2': { pooling: 'mean', query: '', passage: '', dims: 384 },
}
export const DEFAULT_MODEL = 'Xenova/bge-base-en-v1.5'

const FILES = ['tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
const MAX_TOKENS = 512
/** A passage is cut here: 3x faster than 512 on this CPU, and a wiki section or a turn's opening fits. */
const PASSAGE_TOKENS = 320
const BATCH = 8
/** After a failed download or load, the next try waits this long. */
const RETRY_MS = 10 * 60 * 1000

export interface EmbedderStatus {
  state: MeaningState
  model: string
  /** 0..1 while downloading. */
  progress: number | null
  error: string | null
}

export interface Embedder {
  readonly model: string
  status(): EmbedderStatus
  /** Starts the download and load if they haven't started; true once the model can be used. */
  ready(): Promise<boolean>
  /** Unit vectors, in the order given; null when the model isn't ready (it starts getting ready). */
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null>
  close(): void
}

export interface EmbedderOptions {
  /** <state>/agent/models */
  dir: string
  model?: string
  log?: Logger
  /** CPU threads for one inference (2: the screen and the chats keep the rest). */
  threads?: number
  /** Tests: a stand-in for the Hugging Face download. */
  fetch?: typeof fetch
  /** Tests: where the files come from. */
  baseUrl?: string
}

// The two packages are loaded only when meaning is first wanted, and only on the hub.
type Ort = typeof import('onnxruntime-node')
interface TokenizerLike {
  encode(text: string, o?: { add_special_tokens?: boolean; return_token_type_ids?: boolean }): { ids: number[]; token_type_ids?: number[] }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Meaning switched off (tests, and a PC that isn't the hub): search goes by words. */
export function noMeaning(): Embedder {
  return {
    model: 'none',
    status: () => ({ state: 'off', model: 'none', progress: null, error: null }),
    ready: async () => false,
    embed: async () => null,
    close() {},
  }
}

export function createEmbedder(o: EmbedderOptions): Embedder {
  const model = o.model && MODELS[o.model] ? o.model : DEFAULT_MODEL
  const info = MODELS[model]
  const dir = path.join(o.dir, ...model.split('/'))
  const doFetch = o.fetch ?? fetch
  const base = o.baseUrl ?? `https://huggingface.co/${model}/resolve/main`
  let state: MeaningState = 'waiting'
  let progress: number | null = null
  let error: string | null = null
  let failedAt = 0
  let starting: Promise<boolean> | null = null
  let ort: Ort | null = null
  let session: import('onnxruntime-node').InferenceSession | null = null
  let tokenizer: TokenizerLike | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let closed = false

  /** Fetches one of the model's files (progress: the big one's share fetched so far). */
  async function download(file: string) {
    const to = path.join(dir, ...file.split('/'))
    if (existsSync(to) && statSync(to).size > 0) return
    mkdirSync(path.dirname(to), { recursive: true })
    // The first answer names the file's sha256 (X-Linked-Etag) and where it is; the second is the file.
    let url = `${base}/${file}`
    let sha: string | null = null
    let res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 5; hops++) {
      const etag = (res.headers.get('x-linked-etag') ?? '').replace(/"/g, '')
      if (/^[0-9a-f]{64}$/i.test(etag)) sha = etag.toLowerCase()
      const next = res.headers.get('location')
      if (!next) throw new Error(`${file}: a redirect with nowhere to go`)
      url = new URL(next, url).toString()
      res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10 * 60_000) })
    }
    if (!res.ok || !res.body) throw new Error(`${file}: Hugging Face answered ${res.status}`)
    const size = Number(res.headers.get('content-length')) || 0
    const part = `${to}.part`
    let got = 0
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        got += chunk.length
        if (size > 1_000_000) progress = Math.min(0.99, got / size)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, createWriteStream(part))
      if (sha) {
        const hash = createHash('sha256')
        await pipeline(createReadStream(part), hash)
        const digest = hash.digest('hex')
        if (digest !== sha) throw new Error(`${file}: its sha256 is ${digest.slice(0, 12)}…, not the ${sha.slice(0, 12)}… Hugging Face states`)
      }
      renameSync(part, to)
    } catch (e) {
      rmSync(part, { force: true })
      throw e
    }
  }

  async function start(): Promise<boolean> {
    try {
      state = 'downloading'
      progress = 0
      for (const file of FILES) await download(file)
      progress = null
      state = 'loading'
      ort = (await import('onnxruntime-node')) as Ort
      const { Tokenizer } = (await import('@huggingface/tokenizers')) as unknown as {
        Tokenizer: new (json: unknown, config: unknown) => TokenizerLike
      }
      tokenizer = new Tokenizer(JSON.parse(readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')), JSON.parse(readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8')))
      session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model_quantized.onnx'), {
        intraOpNumThreads: o.threads ?? 2,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      })
      if (closed) {
        void session.release()
        session = null
        return false
      }
      state = 'ready'
      error = null
      o.log?.info(`memory: meaning search ready (${model})`)
      return true
    } catch (e) {
      state = 'failed'
      progress = null
      failedAt = Date.now()
      const m = message(e)
      error = /Cannot find (package|module) 'onnxruntime-node'|Cannot find (package|module) '@huggingface\/tokenizers'/.test(m)
        ? "The packages for meaning search aren't installed here (npm install); search goes by words"
        : m
      o.log?.warn(`memory: meaning search unavailable, words only: ${error}`)
      return false
    } finally {
      starting = null
    }
  }

  function ready(): Promise<boolean> {
    if (state === 'ready') return Promise.resolve(true)
    if (closed) return Promise.resolve(false)
    if (starting) return starting
    if (state === 'failed' && Date.now() - failedAt < RETRY_MS) return Promise.resolve(false)
    starting = start()
    return starting
  }

  /** Token ids for one text, cut to `max` (its last, the separator, kept). */
  function encode(text: string, max: number) {
    const e = tokenizer!.encode(text, { add_special_tokens: true, return_token_type_ids: true })
    let ids = e.ids
    let types = e.token_type_ids ?? ids.map(() => 0)
    if (ids.length > max) {
      ids = [...ids.slice(0, max - 1), ids[ids.length - 1]]
      types = [...types.slice(0, max - 1), types[types.length - 1]]
    }
    return { ids, types }
  }

  async function runBatch(texts: string[], max: number): Promise<Float32Array[]> {
    const o2 = ort!
    const s = session!
    const enc = texts.map(t => encode(t, max))
    const L = Math.max(...enc.map(e => e.ids.length))
    const n = texts.length
    const ids = new BigInt64Array(n * L)
    const mask = new BigInt64Array(n * L)
    const types = new BigInt64Array(n * L)
    enc.forEach((e, b) => {
      for (let i = 0; i < e.ids.length; i++) {
        ids[b * L + i] = BigInt(e.ids[i])
        mask[b * L + i] = 1n
        types[b * L + i] = BigInt(e.types[i] ?? 0)
      }
    })
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      input_ids: new o2.Tensor('int64', ids, [n, L]),
      attention_mask: new o2.Tensor('int64', mask, [n, L]),
    }
    if (s.inputNames.includes('token_type_ids')) feeds.token_type_ids = new o2.Tensor('int64', types, [n, L])
    const out = await s.run(feeds)
    const h = out[s.outputNames[0]]
    const data = h.data as Float32Array
    const D = h.dims[2]
    return enc.map((e, b) => {
      const v = new Float32Array(D)
      if (info.pooling === 'cls') for (let k = 0; k < D; k++) v[k] = data[b * L * D + k]
      else {
        for (let i = 0; i < e.ids.length; i++) for (let k = 0; k < D; k++) v[k] += data[(b * L + i) * D + k]
        for (let k = 0; k < D; k++) v[k] /= e.ids.length
      }
      let norm = 0
      for (let k = 0; k < D; k++) norm += v[k] * v[k]
      norm = Math.sqrt(norm) || 1
      for (let k = 0; k < D; k++) v[k] /= norm
      return v
    })
  }

  return {
    model,
    status: () => ({ state, model, progress, error }),
    ready,
    async embed(texts, kind) {
      if (!texts.length) return []
      if (!(await ready()) || !session) return null
      const prefix = kind === 'query' ? info.query : info.passage
      // One inference at a time; short texts batched with short ones (less padding).
      const job = queue.then(async () => {
        const order = texts.map((t, i) => ({ t: prefix + t, i })).sort((a, b) => a.t.length - b.t.length)
        const out = new Array<Float32Array>(texts.length)
        for (let i = 0; i < order.length; i += BATCH) {
          if (closed || !session) throw new Error('the memory layer stopped')
          const batch = order.slice(i, i + BATCH)
          const vecs = await runBatch(batch.map(b => b.t), kind === 'query' ? MAX_TOKENS : PASSAGE_TOKENS)
          batch.forEach((b, j) => (out[b.i] = vecs[j]))
        }
        return out
      })
      queue = job.catch(() => {})
      return job
    },
    close() {
      closed = true
      const s = session
      session = null
      if (s) void queue.finally(() => s.release().catch(() => {}))
    },
  }
}
