import type { DriveCommit, DriveMode, DriveUpload, DriveUploadInfo } from './drive.ts'
import { DriveError } from './drive-error.ts'

// F-097: how ONE file goes up (the page's queue, src/drive/uploads.ts, runs several of these). A small file is one call; a larger one
// goes in the store's pieces, and one that was cut off (the tab went to the background, the connection dropped, the page was closed)
// asks the store how much it has and carries on from there; the store keeps an upload for 24 hours. No page code here, so it is tested
// against a pretend store (shared/drive-upload.test.ts).

/** A file up to this many bytes goes in one call (the store's limit for it). */
export const SMALL_BYTES = 8 * 1024 * 1024
/** What the page keeps in the browser's own storage so a closed tab can go on: larger files are kept only while the tab lives. */
export const KEEP_BYTES = 100 * 1024 * 1024

export type UploadApi = {
  uploadStart(start: { path: string; size: number; mode?: DriveMode; modified?: number }): Promise<DriveUpload>
  uploadPiece(id: string, offset: number, piece: Blob, o: { signal: AbortSignal; onProgress: (sent: number) => void }): Promise<{ received: number }>
  uploadCommit(id: string): Promise<DriveCommit>
  uploadInfo(id: string): Promise<DriveUploadInfo>
  putFile(path: string, body: Blob, o: { mode?: DriveMode; modified?: number; signal: AbortSignal; onProgress: (sent: number) => void }): Promise<DriveCommit>
}

export type UploadJob = {
  /** Where it goes: "folder/name.ext". */
  path: string
  size: number
  mode: DriveMode
  modified?: number
  /** The store's upload id once one was started: kept so a later try carries on instead of starting over. */
  sessionId?: string
}

export type UploadHooks = {
  signal: AbortSignal
  /** The store's upload id, as soon as there is one (the queue keeps it with the file). */
  onSession: (id: string | undefined) => void
  /** Bytes of the file that are there now (the store's count plus the piece in flight). */
  onProgress: (sent: number, total: number) => void
}

const MAX_OFFSET_FIXES = 5

/** Sends the file. Resolves with the store's answer; rejects with a DriveError (the queue decides what that means: wait, ask, or fail). */
export async function sendFile(api: UploadApi, file: Blob, job: UploadJob, hooks: UploadHooks): Promise<DriveCommit> {
  const { signal, onProgress } = hooks
  if (job.size <= SMALL_BYTES && !job.sessionId) {
    const commit = await api.putFile(job.path, file, { mode: job.mode, modified: job.modified, signal, onProgress: sent => onProgress(Math.min(sent, job.size), job.size) })
    onProgress(job.size, job.size)
    return commit
  }

  // The store's upload: the one a cut-off try left, if it still has it, else a new one.
  let id = job.sessionId
  let received = 0
  let pieceBytes = 0
  if (id) {
    try {
      const info = await api.uploadInfo(id)
      received = info.received
    } catch (e) {
      if (!(e instanceof DriveError) || e.code !== 'notfound') throw e
      id = undefined
      hooks.onSession(undefined)
    }
  }
  if (!id) {
    const started = await api.uploadStart({ path: job.path, size: job.size, mode: job.mode, modified: job.modified })
    id = started.id
    received = started.received
    pieceBytes = started.pieceBytes
    hooks.onSession(id)
  }
  if (!pieceBytes) pieceBytes = 4 * 1024 * 1024
  onProgress(received, job.size)

  let fixes = 0
  while (received < job.size) {
    if (signal.aborted) throw new DriveError('Cancelled.', 'aborted')
    const end = Math.min(job.size, received + pieceBytes)
    const base = received
    try {
      const r = await api.uploadPiece(id, base, file.slice(base, end), { signal, onProgress: sent => onProgress(Math.min(base + sent, job.size), job.size) })
      received = r.received
    } catch (e) {
      // The store has a different amount than we thought (a piece arrived but its answer didn't): carry on from what it says.
      if (e instanceof DriveError && e.code === 'offset' && typeof e.received === 'number' && fixes++ < MAX_OFFSET_FIXES) {
        received = e.received
        onProgress(received, job.size)
        continue
      }
      throw e
    }
    onProgress(received, job.size)
  }
  const commit = await api.uploadCommit(id)
  hooks.onSession(undefined)
  return commit
}

/** What the queue does with an error from sendFile. */
export type UploadFate =
  | { kind: 'wait' } // the connection or the app is away: try again when it is back
  | { kind: 'ask'; why: 'exists' | 'case' } // the name is taken: Replace, Keep both or Skip
  | { kind: 'fail'; message: string } // refused: say why
  | { kind: 'cancelled' }

export function fateOf(e: unknown): UploadFate {
  if (e instanceof DriveError) {
    if (e.code === 'aborted') return { kind: 'cancelled' }
    if (e.code === 'offline') return { kind: 'wait' }
    if (e.code === 'exists' || e.code === 'case') return { kind: 'ask', why: e.code }
    return { kind: 'fail', message: e.message }
  }
  // A network failure the browser reports without our wrapper (a TypeError from fetch) is the connection being away too.
  if (e instanceof TypeError) return { kind: 'wait' }
  return { kind: 'fail', message: e instanceof Error ? e.message : 'The upload failed.' }
}

/** How long to wait before the n-th retry of a file that could not get through (1 is the first): 2, 5, 10, 20, 30 s, then every 30 s. */
export const retryDelayMs = (n: number) => [2000, 5000, 10_000, 20_000, 30_000][Math.min(Math.max(1, n), 5) - 1]
