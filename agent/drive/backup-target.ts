// F-097 part D: where a backup copy of the pool goes. Two kinds share this shape: Google Drive (google.ts) and a plain folder (backup-local.ts, the
// fallback when there are no Google keys: a copy into G:). The backup engine (backup.ts) only knows this.

export interface BackupMeta {
  size: number
  /** The pool's etag for this content: kept with the copy, so a later pass can tell what is current. */
  etag: string
  /** ms since the epoch. */
  mtime: number
}

export interface BackupItem {
  etag: string
  size: number
  kind: 'file' | 'dir'
}

export interface BackupTarget {
  /** A name for messages: "Google Drive (someone@…)" or the folder. Never a secret. */
  label: string
  /** Makes the folder (and those above it) if it is not there. */
  ensureDir(path: string): Promise<void>
  /** Copies the file in (a new copy or over the old one: Google keeps the old as a revision). */
  put(path: string, src: string, meta: BackupMeta): Promise<void>
  /** Takes the copy away without losing it: Google's trash, or a folder beside the copy. */
  remove(path: string): Promise<void>
  /** Renames or moves a copy; false when this target cannot (the engine then puts the new one and removes the old). */
  move(from: string, to: string): Promise<boolean>
  /** Everything the backup holds now, by path (for the nightly check). */
  list(): Promise<Map<string, BackupItem>>
}
