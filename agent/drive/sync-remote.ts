import { createReadStream } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { DriveEntry } from '../../shared/drive.ts'
import type { SyncRemote } from './sync.ts'
import type { DriveStore } from './store.ts'

// F-097 part C: the SyncRemote that talks to a store in this very process: the hub's own sync folder, and the tests.
// (The one for another PC speaks the page API over HTTP or the member link; it satisfies the same interface.)

export function storeRemote(store: DriveStore, by: string): SyncRemote {
  return {
    rev: async () => store.rev(),
    changes: (since, waitMs, signal) => store.changes(since, { limit: 2000, waitMs, signal }),
    list: (path, cursor) => store.list(path, { cursor, limit: 1000 }),
    async stat(path) {
      try {
        return await store.stat(path)
      } catch (e) {
        if ((e as { code?: string }).code === 'notfound') return null
        throw e
      }
    },
    async download(path, dest): Promise<DriveEntry> {
      const { abs, entry } = await store.fileOf(path)
      await copyFile(abs, dest)
      return entry
    },
    async upload(path, src, opt) {
      const up = await store.startUpload({ path, size: opt.size, mode: opt.mode, baseEtag: opt.baseEtag, modified: opt.modified }, { by })
      try {
        let offset = 0
        let parts: Buffer[] = []
        let held = 0
        const send = async (all: boolean) => {
          while (held >= up.pieceBytes || (all && held > 0)) {
            const buf = Buffer.concat(parts, held)
            const piece = buf.subarray(0, up.pieceBytes)
            const rest = buf.subarray(piece.length)
            parts = rest.length ? [rest] : []
            held = rest.length
            await store.putPiece(up.id, offset, Readable.from([piece]))
            offset += piece.length
          }
        }
        for await (const chunk of createReadStream(src)) {
          parts.push(chunk as Buffer)
          held += (chunk as Buffer).length
          await send(false)
        }
        await send(true)
        return await store.commitUpload(up.id)
      } catch (e) {
        await store.abortUpload(up.id)
        throw e
      }
    },
    async mkdir(path) {
      await store.mkdir(path, { by })
    },
    async remove(path) {
      await store.remove(path, { by })
    },
  }
}
