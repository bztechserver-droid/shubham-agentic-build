// o6e65 S9a: the CRM files as a Windows drive through WinFsp, called DIRECTLY by this agent (koffi + the installed, signed winfsp-x64.dll; no program of ours, no WebDAV, no 50 MB limit).
//
// This file is the PURE half: what a WinFsp file-system callback must answer for the CRM's tree, as plain functions over plain buffers (no koffi, no Windows), so a fake driver can test
// every answer. winfsp-native.ts is the thin koffi half that hands real WinFsp calls to these; winfsp-bridge.ts carries the blocking questions to the agent's main thread.
//
// LICENCE NOTE: WinFsp is GPLv3 with a FLOSS exception (or a commercial licence). We neither bundle nor copy any of its code: we only call the DLL the user installed. The structure layouts
// below (volume parameters, file info, directory info, the 64-slot interface table) are INTERFACE FACTS read from WinFsp's own signed managed assembly (winfsp-msil.dll, Fsp.Interop.*) and
// checked live against winfsp-x64.dll 2.1.
//
// What the drive does: BROWSE, OPEN, READ (any size), and (S9b) SAVE: a new file, a changed file (a new version), a new folder, a rename or move. A save is written to a staging file on this PC
// and, when the program closes it, moved into the agent's spool (spool.ts) and acknowledged: the spool sends it to the CRM in the background. Where the agent keeps no spool the drive is READ-ONLY
// (every change refused with STATUS_MEDIA_WRITE_PROTECTED, the volume marked read-only for WinFsp), never a fake success. Nothing is ever deleted: a DELETE of anything but a file made in this
// very session that no one has saved yet is refused.

/** NTSTATUS values as signed 32-bit numbers (what koffi hands back and forth). */
export const NT = {
  SUCCESS: 0,
  BUFFER_OVERFLOW: 0x80000005 | 0,
  NO_MORE_FILES: 0x80000006 | 0,
  INVALID_DEVICE_REQUEST: 0xc0000010 | 0,
  END_OF_FILE: 0xc0000011 | 0,
  OBJECT_NAME_NOT_FOUND: 0xc0000034 | 0,
  ACCESS_DENIED: 0xc0000022 | 0,
  MEDIA_WRITE_PROTECTED: 0xc00000a2 | 0,
  INVALID_HANDLE: 0xc0000008 | 0,
  OBJECT_NAME_INVALID: 0xc0000033 | 0,
  OBJECT_NAME_COLLISION: 0xc0000035 | 0,
  SHARING_VIOLATION: 0xc0000043 | 0,
  DISK_FULL: 0xc000007f | 0,
  DIRECTORY_NOT_EMPTY: 0xc0000101 | 0,
  CANNOT_DELETE: 0xc0000121 | 0,
  FILE_IS_A_DIRECTORY: 0xc00000ba | 0,
  NOT_A_DIRECTORY: 0xc0000103 | 0,
  UNEXPECTED_NETWORK_ERROR: 0xc00000c4 | 0,
  IO_DEVICE_ERROR: 0xc0000185 | 0,
} as const

export const FILE_ATTRIBUTE_READONLY = 0x1
export const FILE_ATTRIBUTE_DIRECTORY = 0x10
export const FILE_ATTRIBUTE_ARCHIVE = 0x20
export const FILE_ATTRIBUTE_NORMAL = 0x80

/** An error that is a WinFsp status: the worker's callbacks answer it as it is (never a fake success, never a vague I/O error when the reason is known). */
export class FsStatusError extends Error {
  nt: number
  constructor(nt: number, message = `status ${(nt >>> 0).toString(16)}`) {
    super(message)
    this.name = 'FsStatusError'
    this.nt = nt
  }
}

/** One file or folder as WinFsp needs it. `mtime`/`ctime` are milliseconds since 1970 (0 = unknown). */
export interface FsEntry {
  name: string
  dir: boolean
  size: number
  mtime: number
  ctime: number
}

/** What a read needs from the CRM, as BLOCKING calls (the worker waits for the agent's main thread, see winfsp-bridge.ts). Paths are WinFsp's: "\\", "\\projects\\Alpha\\a.txt". */
export interface FsOps {
  /** The entry at `path`, or null when there is none. */
  stat(path: string): FsEntry | null
  /** The children of a folder whose names sort after `marker` (null: from the start), in WinFsp's order; `more` says there are further ones after the last given. */
  list(path: string, marker: string | null): { entries: FsEntry[]; more: boolean }
  /** Fills `into` from `offset` with up to `into.length` bytes of the file; returns how many (0 at the end). Throws on a failure of the CRM. */
  read(path: string, offset: number, into: Uint8Array): number
  /** S9b: present when this agent keeps a spool (saves are possible); absent = read-only. */
  writes?: FsWriteOps
}

/**
 * S9b: what a SAVE needs of the agent, as BLOCKING calls like the reads (the worker waits for the main thread). Paths are WinFsp's. A refusal throws FsStatusError with the status to answer.
 * Each answer carries the entry as it is now (the size and time after a write, for WinFsp's file info).
 */
export interface FsWriteOps {
  /** A new, empty file or folder at `path` (its folder must exist and allow it). The file is held on this PC; it is saved when its last handle closes with bytes in it. `sid` names the open file for the calls below (0 for a folder: nothing to write). */
  create(path: string, dir: boolean): { sid: number; entry: FsEntry }
  /** A file opened to be written (`truncate`: its content is dropped first). One call per open handle; each is paired with one `release`. */
  open(path: string, truncate: boolean): { sid: number; entry: FsEntry }
  /** Bytes at `offset` (or at the end), at most WRITE_PART. */
  write(sid: number, offset: number, data: Uint8Array, toEnd: boolean): { written: number; entry: FsEntry }
  /** The file made this long (shorter drops bytes, longer reads as zeros). */
  setSize(sid: number, size: number): FsEntry
  /** One handle closed. The last one saves what was written (into the spool), or, with `del`, drops a file made in this session that was never saved. */
  release(sid: number, del: boolean): void
  /** A rename or a move. A CRM file is never replaced by it; a file waiting to be saved that is renamed over a document becomes a new version of that document. */
  rename(from: string, to: string, replace: boolean): void
  /** May this be deleted? Only a file made in this session that nobody saved yet (`sid` its open handle, or 0 with its `path`), or a program's own little side file. */
  canDelete(sid: number, path: string): boolean
  /** Deletes what `canDelete` allowed, for a delete on a handle that holds no save session (a program's side file, opened to be deleted). Anything else is left alone. */
  remove(path: string): void
}

/** The most bytes one write is handed to the agent in one call (a bound on the shared buffer, as READ_PART is for reads). */
export const WRITE_PART = 1024 * 1024

/** The most bytes one WinFsp read is asked of the agent in one call: a bound on every buffer between the worker and the main thread. */
export const READ_PART = 1024 * 1024

/** FILETIME: 100 ns ticks since 1601 (ms since 1970 → ticks). An unknown time is "now" (WinFsp and Explorer want a time). */
export const filetime = (ms: number, now = Date.now()): bigint => BigInt(ms > 0 ? ms : now) * 10_000n + 116_444_736_000_000_000n

/** FSP_FSCTL_FILE_INFO is 72 bytes: attributes, reparse tag, allocation size, file size, four times, index number, hard links, EA size. */
export const FILE_INFO_BYTES = 72

export function fileInfoInto(buf: Uint8Array, at: number, e: FsEntry, now = Date.now(), readOnly = true): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const ro = readOnly ? FILE_ATTRIBUTE_READONLY : 0
  dv.setUint32(at + 0, e.dir ? FILE_ATTRIBUTE_DIRECTORY | ro : FILE_ATTRIBUTE_ARCHIVE | ro, true)
  dv.setUint32(at + 4, 0, true)
  const size = BigInt(e.dir ? 0 : Math.max(0, Math.floor(e.size)))
  dv.setBigUint64(at + 8, (size + 4095n) & ~4095n, true)
  dv.setBigUint64(at + 16, size, true)
  const created = filetime(e.ctime || e.mtime, now)
  const written = filetime(e.mtime || e.ctime, now)
  dv.setBigUint64(at + 24, created, true)
  dv.setBigUint64(at + 32, written, true)
  dv.setBigUint64(at + 40, written, true)
  dv.setBigUint64(at + 48, written, true)
  dv.setBigUint64(at + 56, 0n, true)
  dv.setUint32(at + 64, 0, true)
  dv.setUint32(at + 68, 0, true)
}

/** FSP_FSCTL_DIR_INFO: Size (u16) at 0, the file info at 8, 24 bytes of padding, then the UTF-16 name from 104. WinFsp's AddDirInfo copies one of these into the reply buffer. */
export const DIR_INFO_HEADER = 104
export function dirInfoOf(e: FsEntry, now = Date.now(), readOnly = true): Buffer {
  const name = Buffer.from(e.name, 'utf16le')
  const b = Buffer.alloc(DIR_INFO_HEADER + name.length)
  b.writeUInt16LE(b.length, 0)
  fileInfoInto(b, 8, e, now, readOnly)
  name.copy(b, DIR_INFO_HEADER)
  return b
}

/**
 * A self-relative security descriptor: owner and group Everyone, one ACE giving Everyone full access. The volume has no ACLs of its own (and is read-only); WinFsp still wants a VALID descriptor
 * with an owner and a group from GetSecurityByName (without them its access check answered STATUS_UNKNOWN_REVISION / INVALID_SECURITY_DESCR in the live spike).
 */
export const SECURITY_DESCRIPTOR_EVERYONE = Buffer.from([
  1, 0, 0x04, 0x80, 48, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, // revision, control (DACL present | self relative), owner @48, group @60, no SACL, DACL @20
  2, 0, 28, 0, 1, 0, 0, 0, // ACL: revision 2, size 28, one ACE
  0, 0, 20, 0, 0xff, 0x01, 0x1f, 0x00, // ACCESS_ALLOWED_ACE, size 20, FILE_ALL_ACCESS
  1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, // SID S-1-1-0 in the ACE
  1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, // owner
  1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, // group
])

/** The CRM's names under a folder sort by this (case-insensitive ordinal), and `marker` comparisons use it too. */
export const byName = (a: string, b: string): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** What the drive says about itself: a label, a size and no free space (it is read-only). */
export const VOLUME = { label: 'CRM files', total: 1n << 40n, free: 0n, /** S9b: a drive that takes saves says it has room (Explorer refuses a copy to a drive with none); the spool's own cap is the real limit. */ freeWritable: 1n << 39n }

export interface OpenResult {
  status: number
  entry?: FsEntry
}

/**
 * The answers for WinFsp's callbacks, over `ops`. Every function returns plain values: the koffi half writes them into WinFsp's buffers. Names arrive as WinFsp gives them: "\\" for the root,
 * "\\a\\b" below it (never a trailing backslash except the root).
 */
export function createFsAnswers(ops: FsOps) {
  const norm = (p: string) => (p.length > 1 && p.endsWith('\\') ? p.slice(0, -1) : p)
  const readOnly = !ops.writes
  return {
    /** True when saves are possible (the volume is not read-only). */
    readOnly,
    /** GetSecurityByName: does the path exist, and what are its attributes (WinFsp asks before every open). */
    getSecurityByName(path: string): { status: number; attributes: number } {
      const e = safeStat(ops, norm(path))
      if (e === 'error') return { status: NT.UNEXPECTED_NETWORK_ERROR, attributes: 0 }
      if (!e) return { status: NT.OBJECT_NAME_NOT_FOUND, attributes: 0 }
      const ro = readOnly ? FILE_ATTRIBUTE_READONLY : 0
      return { status: NT.SUCCESS, attributes: e.dir ? FILE_ATTRIBUTE_DIRECTORY | ro : FILE_ATTRIBUTE_ARCHIVE | ro }
    },
    /** Open: the entry, or why not. A write-style open is not asked here: the volume is read-only and WinFsp refuses it first. */
    open(path: string): OpenResult {
      const e = safeStat(ops, norm(path))
      if (e === 'error') return { status: NT.UNEXPECTED_NETWORK_ERROR }
      if (!e) return { status: NT.OBJECT_NAME_NOT_FOUND }
      return { status: NT.SUCCESS, entry: e }
    },
    getFileInfo(path: string): OpenResult {
      return this.open(path)
    },
    /** ReadDirectory: the DirInfo records after `marker`, in order; the caller adds them until WinFsp's buffer is full (it asks again with the last name as the marker). */
    readDirectory(path: string, marker: string | null, now = Date.now()): { status: number; records: Buffer[]; more: boolean } {
      try {
        const r = ops.list(norm(path), marker)
        return { status: NT.SUCCESS, records: r.entries.map(e => dirInfoOf(e, now, readOnly)), more: r.more }
      } catch {
        return { status: NT.UNEXPECTED_NETWORK_ERROR, records: [], more: false }
      }
    },
    /** Read: up to `into.length` bytes at `offset`, never past the end; END_OF_FILE at or after it. Asked of the agent in parts of at most READ_PART bytes. */
    read(path: string, offset: number, into: Uint8Array, known?: FsEntry): { status: number; bytes: number } {
      // `known` is the entry Open found: one question to the agent per read, not two.
      const e = known ?? safeStat(ops, norm(path))
      if (e === 'error') return { status: NT.UNEXPECTED_NETWORK_ERROR, bytes: 0 }
      if (!e) return { status: NT.OBJECT_NAME_NOT_FOUND, bytes: 0 }
      if (e.dir) return { status: NT.FILE_IS_A_DIRECTORY, bytes: 0 }
      if (offset >= e.size) return { status: NT.END_OF_FILE, bytes: 0 }
      const want = Math.min(into.length, e.size - offset)
      let got = 0
      try {
        while (got < want) {
          const part = into.subarray(got, got + Math.min(READ_PART, want - got))
          const n = ops.read(norm(path), offset + got, part)
          if (n <= 0) break
          got += n
        }
      } catch {
        return { status: got > 0 ? NT.SUCCESS : NT.UNEXPECTED_NETWORK_ERROR, bytes: got }
      }
      return got > 0 ? { status: NT.SUCCESS, bytes: got } : { status: NT.END_OF_FILE, bytes: 0 }
    },
  }
}

function safeStat(ops: FsOps, path: string): FsEntry | null | 'error' {
  try {
    return ops.stat(path)
  } catch {
    return 'error'
  }
}
