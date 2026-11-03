import { copyFile, lstat, mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BackupItem, BackupMeta, BackupTarget } from './backup-target.ts'

// F-097 part D, the fallback with no Google keys: a copy of the pool in a plain folder (a Google Drive for desktop folder such as G:\Common Drive
// is synced by Google's own program). It keeps the etag of every copy in a small index file beside it so the nightly check can tell what is current,
// and a removed copy goes to "_removed/<time>/", never gone.

const INDEX = '.common-drive-backup.json'

export function localTarget(dir: string, now: () => number = Date.now): BackupTarget {
  const root = path.resolve(dir)
  const abs = (rel: string) => path.join(root, ...rel.split('/').filter(Boolean))
  let index: Record<string, BackupItem> | null = null

  async function load(): Promise<Record<string, BackupItem>> {
    if (index) return index
    try {
      index = JSON.parse(await readFile(path.join(root, INDEX), 'utf8')) as Record<string, BackupItem>
    } catch {
      index = {}
    }
    return index
  }
  async function save() {
    await mkdir(root, { recursive: true })
    const tmp = path.join(root, `${INDEX}.tmp`)
    await writeFile(tmp, JSON.stringify(index ?? {}))
    await rename(tmp, path.join(root, INDEX))
  }

  return {
    label: `the folder ${root}`,
    async ensureDir(rel) {
      await mkdir(abs(rel), { recursive: true })
      const ix = await load()
      if (rel) ix[rel] = { etag: '', size: 0, kind: 'dir' }
      await save()
    },
    async put(rel, src, meta: BackupMeta) {
      await mkdir(path.dirname(abs(rel)), { recursive: true })
      const tmp = `${abs(rel)}.sad-backup-part`
      await copyFile(src, tmp)
      await utimes(tmp, meta.mtime / 1000, meta.mtime / 1000)
      await rename(tmp, abs(rel))
      const ix = await load()
      ix[rel] = { etag: meta.etag, size: meta.size, kind: 'file' }
      await save()
    },
    async remove(rel) {
      const ix = await load()
      const from = abs(rel)
      if (await lstat(from).then(() => true, () => false)) {
        const to = path.join(root, '_removed', new Date(now()).toISOString().replace(/[:.]/g, '-'), ...rel.split('/'))
        await mkdir(path.dirname(to), { recursive: true })
        await rename(from, to)
      }
      for (const k of Object.keys(ix)) if (k === rel || k.startsWith(`${rel}/`)) delete ix[k]
      await save()
    },
    async move(from, to) {
      const ix = await load()
      if (!(await lstat(abs(from)).then(() => true, () => false))) return false
      await mkdir(path.dirname(abs(to)), { recursive: true })
      await rename(abs(from), abs(to))
      for (const k of Object.keys(ix)) {
        if (k === from || k.startsWith(`${from}/`)) {
          ix[to + k.slice(from.length)] = ix[k]
          delete ix[k]
        }
      }
      await save()
      return true
    },
    async list() {
      const ix = await load()
      const out = new Map<string, BackupItem>()
      for (const [rel, item] of Object.entries(ix)) {
        // Only what is really there counts.
        const st = await stat(abs(rel)).catch(() => null)
        if (!st) continue
        out.set(rel, item)
      }
      return out
    },
  }
}
