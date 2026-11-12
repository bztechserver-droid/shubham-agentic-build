import { statfs } from 'node:fs/promises'
import { createOfflinePins, PIN_QUOTA_MB_MAX, type AccessRemovedItem, type OfflinePins, type PinItem, type PinKind } from './offline-pins.ts'
import type { CrmPinMark, CrmPins } from '../../shared/crm-files.ts'

// ocbbf (Web, 12 Nov): "Keep on this PC" wired to the CRM files service. The engine (offline-pins.ts) does the copying, the quota, the eviction and the
// two-listing rule; this host feeds it the whole accessible tree, answers the page's questions, reads the copies offline, and hands the kept copies of
// a project whose access was removed to the "Access removed" folder (served in place from the copy, never evicted while listed).

export interface PinsHostOptions {
  /** The engine's cache folder (the state folder's crm-pins). */
  dir: string
  /** The whole accessible tree, as the service sees it now (folders and files, with versions and sizes). */
  tree(): Promise<PinItem[]>
  /** Bytes of a file's current content (the service's fileBytes). */
  fetchBytes(id: string, start: number, length: number): Promise<Buffer>
  log?: { info(m: string): void; warn(m: string): void }
  now?: () => number
  /** Run the downloads by themselves (default every 30 s). */
  syncEveryMs?: number
  /** Look at the tree again while anything is kept (default every 60 s). */
  refreshEveryMs?: number
  /** Tests: how long a kept file may be missing before it is handed over (default 30 s). */
  removalGraceMs?: number
}

/** What the service needs from the host (its methods are the page's and its routes'). */
export interface PinsHost {
  start(): Promise<void>
  close(): Promise<void>
  view(): CrmPins
  pin(id: string, kind: PinKind): Promise<CrmPins>
  unpin(id: string): Promise<CrmPins>
  setQuota(mb: number): Promise<CrmPins>
  /** Forget the copies kept for a project whose access was removed (the pins stay). */
  dropKept(projectId: string): Promise<number>
  /** The mark of a node, given the ids of its folders (its parent first, then up). */
  markOf(id: string, ancestors: readonly string[]): CrmPinMark | null
  /** A read from the finished copy, when the CRM cannot be asked (null: not here). */
  readOffline(id: string, start: number, length: number): Promise<Buffer | null>
  /** The copies kept for a project whose access was removed (a project id, "proj:<id>" or the bare id). */
  keptFor(projectId: string): { id: string; name: string; cachePath: string; size: number }[]
  /** A refresh of the tree now (after a change the service made itself). */
  refresh(): Promise<void>
  /** Waits for the downloads that are due now (the engine runs them by itself every 30 s; tests and a pin use this). */
  sync(): Promise<void>
}

export function createPinsHost(o: PinsHostOptions): PinsHost {
  const names = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false
  const freeBytes = async (dir: string): Promise<number> => {
    try {
      const s = await statfs(dir)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      // The disk cannot be asked: nothing is downloaded (the quota alone does not know the disk).
      return 0
    }
  }
  const accessRemoved = {
    // Kept in place: the finished copy stays on disk and is listed under "Access removed". The engine deletes only what it was not given.
    async handOver(item: AccessRemovedItem): Promise<{ keep: boolean }> {
      o.log?.info(`pins: ${item.name} lost its access in the CRM; kept on this PC under Access removed`)
      return { keep: item.cachePath !== null }
    },
  }
  const engine: OfflinePins = createOfflinePins({
    dir: o.dir,
    deps: {
      fetchBytes: (id, start, length) => o.fetchBytes(id, start, length),
      freeBytes,
      accessRemoved,
      now: o.now,
      log: o.log,
    },
    syncEveryMs: o.syncEveryMs ?? 30_000,
    removalGraceMs: o.removalGraceMs,
  })

  async function refresh(): Promise<void> {
    const items = await o.tree()
    names.clear()
    for (const it of items) names.set(it.id, it.name)
    await engine.reconcile(items)
  }
  /** Looks at the tree while anything is kept (a removal and a changed file are seen this way). Failures are said once in the log; the next look tries again. */
  function tick(): void {
    if (closed || engine.listPins().length === 0) return
    refresh().catch(e => o.log?.warn(`pins: the tree could not be read (${e instanceof Error ? e.message : String(e)})`))
  }

  function view(): CrmPins {
    const s = engine.status()
    const settings = engine.settings()
    return {
      status: {
        pinnedFiles: s.pinnedFiles,
        pinnedBytes: s.pinnedBytes,
        cacheBytes: s.cacheBytes,
        quotaBytes: s.quotaBytes,
        pinnedOverQuota: s.pinnedOverQuota,
        queued: s.queued,
        waitingRetry: s.waitingRetry,
        waitingForSpace: s.waitingForSpace,
        sizeUnknown: s.sizeUnknown,
        heldAfterRemoval: s.heldAfterRemoval,
      },
      quotaMb: settings.quotaMb,
      pins: engine.listPins().map(p => ({ id: p.id, kind: p.kind === 'folder' ? 'folder' : 'file', name: names.get(p.id) ?? p.id, since: p.since })),
    }
  }

  return {
    async start() {
      await engine.start()
      // A kept folder's copies come back after a restart: look at the tree once, then keep looking while something is kept.
      tick()
      timer = setInterval(tick, o.refreshEveryMs ?? 60_000)
      timer.unref?.()
    },
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      await engine.close()
    },
    view,
    async pin(id, kind) {
      await engine.pin({ id, kind })
      await refresh()
      void engine.sync().catch(() => undefined)
      return view()
    },
    async unpin(id) {
      await engine.unpin(id)
      await refresh()
      return view()
    },
    async setQuota(mb) {
      if (!Number.isInteger(mb) || mb < 1 || mb > PIN_QUOTA_MB_MAX) throw new Error(`The limit is between 1 MB and ${PIN_QUOTA_MB_MAX} MB.`)
      await engine.setSettings({ quotaMb: mb })
      void engine.sync().catch(() => undefined)
      return view()
    },
    dropKept: projectId => engine.dropKept(projectId),
    markOf(id, ancestors) {
      const explicit = engine.listPins().some(p => p.id === id)
      if (!explicit && !engine.isPinned(id, ancestors)) return null
      return { via: explicit ? 'self' : 'folder', ready: id.startsWith('file:') && engine.cached(id) !== null }
    },
    async readOffline(id, start, length) {
      if (!id.startsWith('file:') || length <= 0) return null
      return engine.readCached(id, null, start, length)
    },
    keptFor(projectId) {
      return engine.pinnedUnder(projectId).map(k => ({ id: k.id, name: k.name, cachePath: k.cachePath, size: k.size }))
    },
    refresh,
    sync: () => engine.sync(),
  }
}
