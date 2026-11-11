import type { CrmNode } from '../../shared/crm-files.ts'
import { legalWindowsName, namesOf } from './dav-crm.ts'
import type { CrmFilesService } from './service.ts'
import type { AsyncFsHandler } from './winfsp-bridge.ts'
import { byName, type FsEntry } from './winfsp-ops.ts'

// o6e65 S9a: the CRM tree as the drive's main-thread side: it answers the worker's questions (winfsp-bridge.ts) from the CRM files service. Names are what the Windows WebDAV way shows
// (legalWindowsName/namesOf: forbidden characters become "_", names that differ only by case are told apart by id), so the same file has the same name in both ways.
//
// Reads go through a READ-AHEAD cache of fixed blocks: a read is served from 4 MiB blocks fetched with ranged requests; the next block is fetched ahead when a file is read in order, hiding the
// CRM's latency. MEMORY IS BOUNDED, said here once: at most MAX_BLOCKS blocks (16 × 4 MiB = 64 MiB) are kept (the oldest are dropped), plus the blocks being fetched; nothing else is held.

export const BLOCK_BYTES = 4 * 1024 * 1024
export const MAX_BLOCKS = 16

const entryOf = (name: string, n: CrmNode): FsEntry => {
  const m = Date.parse(n.modifiedAt ?? n.createdAt ?? '')
  const c = Date.parse(n.createdAt ?? n.modifiedAt ?? '')
  return { name, dir: n.isFolder, size: n.isFolder ? 0 : (n.size ?? 0), mtime: Number.isFinite(m) ? m : 0, ctime: Number.isFinite(c) ? c : 0 }
}

const notFound = () => Object.assign(new Error('not found'), { notFound: true })

export interface CrmFsHandler extends AsyncFsHandler {
  /** Blocks held now (tests: the bound). */
  heldBlocks(): number
}

export interface CrmFsOptions {
  /** Tests: smaller blocks / fewer kept. */
  blockBytes?: number
  maxBlocks?: number
}

export function createCrmFsHandler(service: () => CrmFilesService | null, opt: CrmFsOptions = {}): CrmFsHandler {
  const BLOCK = opt.blockBytes ?? BLOCK_BYTES
  const MAX = opt.maxBlocks ?? MAX_BLOCKS
  const svc = (): CrmFilesService => {
    const s = service()
    if (!s) throw new Error('the CRM files are not ready')
    return s
  }

  /** The children of a folder under their Windows names (a Map from name to node), sorted by name. */
  async function kidsOf(id: string): Promise<[string, CrmNode][]> {
    const { children } = await svc().children(id)
    return [...namesOf(children, legalWindowsName, true)].sort((a, b) => byName(a[0], b[0]))
  }

  async function resolve(path: string): Promise<{ node: CrmNode; name: string } | null> {
    const parts = path.split('\\').filter(Boolean)
    let node = (await svc().children('root')).node
    let name = ''
    for (const part of parts) {
      if (!node.isFolder) return null
      const want = part.toLowerCase()
      const hit = (await kidsOf(node.id)).find(([n]) => n.toLowerCase() === want)
      if (!hit) return null
      ;[name, node] = hit
    }
    return { node, name }
  }

  // ---- the read-ahead cache ----
  const blocks = new Map<string, Promise<Buffer>>() // insertion order = age
  const keyOf = (n: CrmNode, i: number) => `${n.id}|${n.modifiedAt ?? ''}|${n.size ?? ''}|${i}`
  function block(n: CrmNode, i: number): Promise<Buffer> {
    const k = keyOf(n, i)
    const had = blocks.get(k)
    if (had) {
      blocks.delete(k)
      blocks.set(k, had) // most recently used
      return had
    }
    const size = n.size ?? 0
    const start = i * BLOCK
    const len = Math.min(BLOCK, size - start)
    const p = svc().fileBytes(n.id, start, len)
    blocks.set(k, p)
    p.catch(() => blocks.delete(k)) // a failed fetch is not kept
    while (blocks.size > MAX) blocks.delete(blocks.keys().next().value as string)
    return p
  }

  return {
    heldBlocks: () => blocks.size,

    async stat(path) {
      const r = await resolve(path)
      return r ? entryOf(r.name, r.node) : null
    },

    async list(path, marker) {
      const r = await resolve(path)
      if (!r || !r.node.isFolder) throw notFound()
      const kids = await kidsOf(r.node.id)
      const after = marker === null ? kids : kids.filter(([n]) => byName(n, marker) > 0)
      return { entries: after.map(([n, node]) => entryOf(n, node)), more: false }
    },

    async read(path, offset, length) {
      const r = await resolve(path)
      if (!r || r.node.isFolder) throw notFound()
      const size = r.node.size ?? 0
      if (offset >= size || length <= 0) return new Uint8Array(0)
      const end = Math.min(size, offset + length)
      const out = Buffer.alloc(end - offset)
      let at = offset
      while (at < end) {
        const i = Math.floor(at / BLOCK)
        // in order: the next block is on its way before it is asked for
        if ((i + 1) * BLOCK < size && blocks.has(keyOf(r.node, i - 1))) void block(r.node, i + 1).catch(() => undefined)
        const b = await block(r.node, i)
        const from = at - i * BLOCK
        const take = Math.min(b.length - from, end - at)
        if (take <= 0) throw new Error('the CRM sent less than it said')
        b.copy(out, at - offset, from, from + take)
        at += take
      }
      return out
    },
  }
}
