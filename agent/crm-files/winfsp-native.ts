import { createRequire } from 'node:module'
import type * as Koffi from 'koffi'
import { byName, createFsAnswers, dirInfoOf, DIR_INFO_HEADER, FILE_INFO_BYTES, fileInfoInto, filetime, NT, SECURITY_DESCRIPTOR_EVERYONE, VOLUME, WRITE_PART, type FsEntry, type FsOps } from './winfsp-ops.ts'

// o6e65 S9a: the thin koffi half of the in-process WinFsp drive. It runs ONLY inside the drive's worker thread (winfsp-worker.ts): koffi loads the installed, signed winfsp-x64.dll; WinFsp's own
// dispatcher threads call the callbacks below; koffi runs each on this worker's JS thread (it queues the call and returns the value to WinFsp's thread: proved in the spike); the answers come from
// winfsp-ops.ts, which asks the agent through the blocking bridge (winfsp-bridge.ts).
//
// LICENCE NOTE: WinFsp is GPLv3 with a FLOSS exception (or commercial). We do not bundle or copy any of its code; we only call the DLL the user installed. The layouts below are interface facts
// from its signed managed assembly (Fsp.Interop.*, winfsp-msil.dll), checked live against winfsp-x64.dll 2.1:
//   VolumeParams 504 bytes (Version@0 SectorSize@2 SectorsPerAllocationUnit@4 MaxComponentLength@6 CreationTime@8 SerialNumber@16 timeouts@20..32 Flags@36 Prefix@40[192 WCHAR] FileSystemName@424[16 WCHAR]
//   AdditionalFlags@456 ... Reserved@484/488); the interface table holds 64 function pointers (512 bytes), 33 named: EVERY slot we do not serve gets a stub (a NULL slot made Create fail with
//   STATUS_INVALID_DEVICE_REQUEST in the live spike); GetSecurityByName must return a valid security descriptor with owner and group; out-parameters are written with koffi.encode; the dispatcher is
//   stopped through koffi's .async form (the synchronous call can wait for callbacks that need this very thread).
//
// SAVES (S9b): where the agent keeps a spool (ops.writes) the volume takes saves: Create, Overwrite, Write, SetFileSize, SetBasicInfo, SetDelete, Rename, Cleanup and Flush are served (winfsp-crm.ts
// keeps the bytes in a staging file and moves them into the spool when the program closes the file). CreateEx and OverwriteEx are left NULL then, so WinFsp calls the plain Create and Overwrite.
// Where there is no spool the volume is declared read-only (WinFsp refuses writes itself) and every write-type call that reaches us answers STATUS_MEDIA_WRITE_PROTECTED, never a success.
// Nothing is ever deleted.

export const WINFSP_DLL = 'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll'
const VOLUME_PARAMS_BYTES = 504
// Flags bits (Fsp.Interop.VolumeParams): CasePreservedNames 1, UnicodeOnDisk 2, ReadOnlyVolume 9
const FLAGS = (1 << 1) | (1 << 2)
const READ_ONLY_FLAG = 1 << 9
// What the callbacks of a change are told: GrantedAccess bits that write, CreateOptions' directory bit, Cleanup's delete bit.
const WRITE_ACCESS = 0x2 | 0x4 // FILE_WRITE_DATA | FILE_APPEND_DATA
const FILE_DIRECTORY_FILE = 0x1
const CLEANUP_DELETE = 0x1

const SLOT_NAMES = [
  'GetVolumeInfo', 'SetVolumeLabel', 'GetSecurityByName', 'Create', 'Open', 'Overwrite', 'Cleanup', 'Close', 'Read', 'Write', 'Flush', 'GetFileInfo', 'SetBasicInfo', 'SetFileSize', 'CanDelete', 'Rename',
  'GetSecurity', 'SetSecurity', 'ReadDirectory', 'ResolveReparsePoints', 'GetReparsePoint', 'SetReparsePoint', 'DeleteReparsePoint', 'GetStreamInfo', 'GetDirInfoByName', 'Control', 'SetDelete',
  'CreateEx', 'OverwriteEx', 'GetEa', 'SetEa', 'Obsolete0', 'DispatcherStopped',
] as const

export interface NativeMountOptions {
  /** The drive letter, "Y:" or "T:". */
  letter: string
  ops: FsOps
  dll?: string
  label?: string
  log?: (line: string) => void
}

export interface NativeMount {
  stop(): Promise<void>
}

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`

export async function mountNative(o: NativeMountOptions): Promise<NativeMount> {
  const koffi = createRequire(import.meta.url)('koffi') as typeof Koffi
  const log = o.log ?? (() => undefined)
  const winfsp = koffi.load(o.dll ?? WINFSP_DLL)
  const Create = winfsp.func('int32_t FspFileSystemCreate(str16 devicePath, void *volumeParams, void *iface, _Out_ void **fileSystem)')
  const SetMountPoint = winfsp.func('int32_t FspFileSystemSetMountPoint(void *fileSystem, str16 mountPoint)')
  const StartDispatcher = winfsp.func('int32_t FspFileSystemStartDispatcher(void *fileSystem, uint32_t threadCount)')
  const StopDispatcher = winfsp.func('void FspFileSystemStopDispatcher(void *fileSystem)')
  const RemoveMountPoint = winfsp.func('void FspFileSystemRemoveMountPoint(void *fileSystem)')
  const Delete = winfsp.func('void FspFileSystemDelete(void *fileSystem)')
  const AddDirInfo = winfsp.func('bool FspFileSystemAddDirInfo(void *dirInfo, void *buffer, uint32_t length, _Inout_ uint32_t *bytesTransferred)')

  const view = (ptr: unknown, len: number) => Buffer.from(koffi.view(ptr as never, len))
  const address = (ptr: unknown) => Number(koffi.address(ptr as never))
  const answers = createFsAnswers(o.ops)
  /** One open file: its path as WinFsp last gave it, its entry, and (S9b) the agent's save session when it was opened to be written. */
  type Context = { path: string; entry: FsEntry; sid: number; released: boolean }
  const contexts = new Map<number, Context>()
  const writes = o.ops.writes
  let nextContext = 1
  const label = Buffer.from((o.label ?? VOLUME.label).slice(0, 31), 'utf16le')

  // Each callback: never throws into WinFsp (an exception becomes an I/O error), never answers a write with success.
  const guard = <A extends unknown[]>(name: string, fn: (...a: A) => number, failure: number = NT.IO_DEVICE_ERROR) =>
    (...a: A): number => {
      try {
        return fn(...a)
      } catch (e) {
        // A refusal the agent gave as a WinFsp status is answered as it is.
        const status = (e as { nt?: unknown })?.nt
        if (typeof status === 'number') return status
        log(`winfsp ${name}: ${(e as Error).message}`)
        return failure
      }
    }

  const proto = (decl: string) => koffi.proto(decl)
  const P = {
    GetVolumeInfo: proto('int32_t GetVolumeInfo(void *fs, void *volumeInfo)'),
    GetSecurityByName: proto('int32_t GetSecurityByName(void *fs, str16 name, void *attrs, void *sd, void *sdSize)'),
    Open: proto('int32_t Open(void *fs, str16 name, uint32_t createOptions, uint32_t granted, void *pContext, void *fileInfo)'),
    Close: proto('void Close(void *fs, void *context)'),
    Cleanup: proto('void Cleanup(void *fs, void *context, str16 name, uint32_t flags)'),
    Read: proto('int32_t Read(void *fs, void *context, void *buffer, uint64_t offset, uint32_t length, void *bytesTransferred)'),
    GetFileInfo: proto('int32_t GetFileInfo(void *fs, void *context, void *fileInfo)'),
    GetSecurity: proto('int32_t GetSecurity(void *fs, void *context, void *sd, void *sdSize)'),
    ReadDirectory: proto('int32_t ReadDirectory(void *fs, void *context, str16 pattern, str16 marker, void *buffer, uint32_t length, void *bytesTransferred)'),
    GetDirInfoByName: proto('int32_t GetDirInfoByName(void *fs, void *context, str16 fileName, void *dirInfo)'),
    Flush: proto('int32_t Flush(void *fs, void *context, void *fileInfo)'),
    Create: proto('int32_t Create(void *fs, str16 name, uint32_t createOptions, uint32_t granted, uint32_t attrs, void *sd, uint64_t allocSize, void *pContext, void *fileInfo)'),
    Overwrite: proto('int32_t Overwrite(void *fs, void *context, uint32_t attrs, uint8_t replaceAttrs, uint64_t allocSize, void *fileInfo)'),
    Write: proto('int32_t Write(void *fs, void *context, void *buffer, uint64_t offset, uint32_t length, uint8_t writeToEnd, uint8_t constrained, void *bytesTransferred, void *fileInfo)'),
    SetBasicInfo: proto('int32_t SetBasicInfo(void *fs, void *context, uint32_t attrs, uint64_t created, uint64_t accessed, uint64_t written, uint64_t changed, void *fileInfo)'),
    SetFileSize: proto('int32_t SetFileSize(void *fs, void *context, uint64_t newSize, uint8_t setAllocation, void *fileInfo)'),
    SetDelete: proto('int32_t SetDelete(void *fs, void *context, str16 name, uint8_t deleteFile)'),
    Rename: proto('int32_t Rename(void *fs, void *context, str16 name, str16 newName, uint8_t replaceIfExists)'),
    Stub: proto('int32_t Stub(void *a, void *b, void *c, void *d, void *e, void *f)'),
  }
  /** One handle of a save session ends (Cleanup, or Close when Cleanup was not seen): the agent saves what was written. It cannot fail WinFsp (these are void callbacks); a trouble is logged. */
  const release = (c: { path: string; sid: number; released: boolean }, del: boolean) => {
    c.released = true
    try {
      writes?.release(c.sid, del)
    } catch (e) {
      log(`winfsp save of ${c.path}: ${(e as Error).message}`)
    }
  }
  const keep: unknown[] = []
  const reg = (fn: (...a: never[]) => unknown, p: unknown) => {
    const cb = koffi.register(fn as never, koffi.pointer(p as never))
    keep.push(cb)
    return cb
  }

  const sd = SECURITY_DESCRIPTOR_EVERYONE
  /** Writes the descriptor if the caller's buffer holds it (the size is IN/OUT); asks for a bigger buffer otherwise. */
  const putSecurity = (sdPtr: unknown, sizePtr: unknown): number => {
    if (!sizePtr) return NT.SUCCESS
    const cap = Number(koffi.decode(sizePtr as never, 'uint64_t'))
    koffi.encode(sizePtr as never, 'uint64_t', sd.length)
    if (sdPtr) {
      if (cap < sd.length) return NT.BUFFER_OVERFLOW
      sd.copy(view(sdPtr, sd.length))
    }
    return NT.SUCCESS
  }

  const cb = {
    GetVolumeInfo: reg(
      guard('GetVolumeInfo', (_fs: unknown, vi: unknown) => {
        const b = view(vi, 88)
        b.writeBigUInt64LE(VOLUME.total, 0)
        b.writeBigUInt64LE(answers.readOnly ? VOLUME.free : VOLUME.freeWritable, 8)
        b.writeUInt16LE(label.length, 16)
        label.copy(b, 18)
        return NT.SUCCESS
      }),
      P.GetVolumeInfo,
    ),
    GetSecurityByName: reg(
      guard('GetSecurityByName', (_fs: unknown, name: string, attrsOut: unknown, sdPtr: unknown, sdSize: unknown) => {
        const r = answers.getSecurityByName(name)
        if (r.status !== NT.SUCCESS) return r.status
        if (attrsOut) koffi.encode(attrsOut as never, 'uint32_t', r.attributes)
        return putSecurity(sdPtr, sdSize)
      }),
      P.GetSecurityByName,
    ),
    Open: reg(
      guard('Open', (_fs: unknown, name: string, _options: number, granted: number, pContext: unknown, fileInfo: unknown) => {
        const r = answers.open(name)
        if (r.status !== NT.SUCCESS || !r.entry) return r.status
        let entry = r.entry
        let sid = 0
        // Opened to be written: the agent starts a save session for it (one handle, paired with Cleanup).
        if (writes && !entry.dir && (granted & WRITE_ACCESS) !== 0) {
          const w = writes.open(name, false)
          sid = w.sid
          entry = w.entry
        }
        const id = nextContext++
        contexts.set(id, { path: name, entry, sid, released: false })
        koffi.encode(pContext as never, 'uintptr_t', id)
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, entry, Date.now(), answers.readOnly)
        return NT.SUCCESS
      }),
      P.Open,
    ),
    Close: reg((_fs: unknown, ctx: unknown) => {
      const c = contexts.get(address(ctx))
      if (c && c.sid && !c.released) release(c, false)
      contexts.delete(address(ctx))
    }, P.Close),
    Cleanup: reg((_fs: unknown, ctx: unknown, _name: string | null, flags: number) => {
      const c = contexts.get(address(ctx))
      if (c && c.sid && !c.released) release(c, (flags & CLEANUP_DELETE) !== 0)
      // A delete on a handle with no save session (a program's side file opened to be deleted): the agent drops it if it is one it allowed.
      else if (c && !c.sid && !c.released && writes && (flags & CLEANUP_DELETE) !== 0) {
        c.released = true
        try {
          writes.remove(c.path)
        } catch (e) {
          log(`winfsp delete of ${c.path}: ${(e as Error).message}`)
        }
      }
    }, P.Cleanup),
    GetFileInfo: reg(
      guard('GetFileInfo', (_fs: unknown, ctx: unknown, fileInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c) return NT.OBJECT_NAME_NOT_FOUND
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), answers.readOnly)
        return NT.SUCCESS
      }),
      P.GetFileInfo,
    ),
    GetSecurity: reg(guard('GetSecurity', (_fs: unknown, _ctx: unknown, sdPtr: unknown, sdSize: unknown) => putSecurity(sdPtr, sdSize)), P.GetSecurity),
    Read: reg(
      guard('Read', (_fs: unknown, ctx: unknown, buffer: unknown, offset: bigint | number, length: number, outBytes: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c) return NT.OBJECT_NAME_NOT_FOUND
        const r = answers.read(c.path, Number(offset), view(buffer, length), c.entry)
        koffi.encode(outBytes as never, 'uint32_t', r.bytes)
        return r.status
      }),
      P.Read,
    ),
    ReadDirectory: reg(
      guard('ReadDirectory', (_fs: unknown, ctx: unknown, _pattern: string | null, marker: string | null, buffer: unknown, length: number, outBytes: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c) return NT.OBJECT_NAME_NOT_FOUND
        if (!c.entry.dir) return NT.NOT_A_DIRECTORY
        const r = answers.readDirectory(c.path, marker)
        if (r.status !== NT.SUCCESS) return r.status
        let used = 0
        let full = false
        for (const rec of r.records) {
          const io = [used]
          if (!AddDirInfo(rec, buffer, length, io)) {
            full = true
            break
          }
          used = io[0]
        }
        // The end of the listing is a NULL record; a cut page (more to come) or a full buffer has none: WinFsp asks again from the last name.
        if (!full && !r.more) {
          const io = [used]
          AddDirInfo(null, buffer, length, io)
          used = io[0]
        }
        koffi.encode(outBytes as never, 'uint32_t', used)
        return NT.SUCCESS
      }),
      P.ReadDirectory,
    ),
    GetDirInfoByName: reg(
      guard('GetDirInfoByName', (_fs: unknown, ctx: unknown, fileName: string, dirInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c) return NT.OBJECT_NAME_NOT_FOUND
        const base = c.path === '\\' ? '' : c.path
        const r = answers.open(`${base}\\${fileName}`)
        if (r.status !== NT.SUCCESS || !r.entry) return r.status
        const rec = dirInfoOf({ ...r.entry, name: fileName }, Date.now(), answers.readOnly)
        rec.copy(view(dirInfo, rec.length))
        return NT.SUCCESS
      }),
      P.GetDirInfoByName,
    ),
    Flush: reg(() => NT.SUCCESS, P.Flush),
    // ---- S9b: the saves (used only when the agent keeps a spool) ----
    Create: reg(
      guard('Create', (_fs: unknown, name: string, options: number, _granted: number, _attrs: number, _sd: unknown, _alloc: bigint | number, pContext: unknown, fileInfo: unknown) => {
        if (!writes) return NT.MEDIA_WRITE_PROTECTED
        const w = writes.create(name, (options & FILE_DIRECTORY_FILE) !== 0)
        const id = nextContext++
        contexts.set(id, { path: name, entry: w.entry, sid: w.sid, released: false })
        koffi.encode(pContext as never, 'uintptr_t', id)
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, w.entry, Date.now(), false)
        return NT.SUCCESS
      }),
      P.Create,
    ),
    Overwrite: reg(
      guard('Overwrite', (_fs: unknown, ctx: unknown, _attrs: number, _replace: number, _alloc: bigint | number, fileInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes || !c.sid) return NT.MEDIA_WRITE_PROTECTED
        c.entry = writes.setSize(c.sid, 0)
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), false)
        return NT.SUCCESS
      }),
      P.Overwrite,
    ),
    Write: reg(
      guard('Write', (_fs: unknown, ctx: unknown, buffer: unknown, offset: bigint | number, length: number, toEnd: number, constrained: number, outBytes: unknown, fileInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes || !c.sid) return NT.MEDIA_WRITE_PROTECTED
        let at = toEnd ? c.entry.size : Number(offset)
        let want = length
        // Constrained I/O (the cache manager's paging write) never extends the file.
        if (constrained) {
          if (at >= c.entry.size) {
            koffi.encode(outBytes as never, 'uint32_t', 0)
            fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), false)
            return NT.SUCCESS
          }
          want = Math.min(want, c.entry.size - at)
        }
        const data = view(buffer, length)
        let done = 0
        while (done < want) {
          const part = data.subarray(done, done + Math.min(WRITE_PART, want - done))
          const w = writes.write(c.sid, at, part, false)
          c.entry = w.entry
          done += w.written
          at += w.written
          if (w.written === 0) break
        }
        koffi.encode(outBytes as never, 'uint32_t', done)
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), false)
        return NT.SUCCESS
      }),
      P.Write,
    ),
    SetFileSize: reg(
      guard('SetFileSize', (_fs: unknown, ctx: unknown, newSize: bigint | number, setAllocation: number, fileInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes || !c.sid) return NT.MEDIA_WRITE_PROTECTED
        const size = Number(newSize)
        // An allocation size only matters when it is below the size (the file is cut); the size itself is not given more room than asked.
        if (!setAllocation || size < c.entry.size) c.entry = writes.setSize(c.sid, size)
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), false)
        return NT.SUCCESS
      }),
      P.SetFileSize,
    ),
    // Times and attributes the CRM does not keep: taken and forgotten (Explorer sets them after a copy), the entry answered as it is.
    SetBasicInfo: reg(
      guard('SetBasicInfo', (_fs: unknown, ctx: unknown, _attrs: number, _c: bigint, _a: bigint, _w: bigint, _ch: bigint, fileInfo: unknown) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes) return NT.MEDIA_WRITE_PROTECTED
        fileInfoInto(view(fileInfo, FILE_INFO_BYTES), 0, c.entry, Date.now(), false)
        return NT.SUCCESS
      }),
      P.SetBasicInfo,
    ),
    // A delete is only allowed for a file made in this very session that nobody saved yet (it is our own staging copy); nothing else is ever deleted.
    SetDelete: reg(
      guard('SetDelete', (_fs: unknown, ctx: unknown, _name: string | null, deleteFile: number) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes) return NT.MEDIA_WRITE_PROTECTED
        if (!deleteFile) return NT.SUCCESS
        return writes.canDelete(c.sid, c.path) ? NT.SUCCESS : NT.CANNOT_DELETE
      }),
      P.SetDelete,
    ),
    Rename: reg(
      guard('Rename', (_fs: unknown, ctx: unknown, name: string, newName: string, replace: number) => {
        const c = contexts.get(address(ctx))
        if (!c || !writes) return NT.MEDIA_WRITE_PROTECTED
        writes.rename(name, newName, replace !== 0)
        c.path = newName
        return NT.SUCCESS
      }),
      P.Rename,
    ),
    // every change is refused as write protected; every other slot is "not supported": never a fake success
    Protected: reg(() => NT.MEDIA_WRITE_PROTECTED, P.Stub),
    Unsupported: reg(() => NT.INVALID_DEVICE_REQUEST, P.Stub),
  }

  const members: Record<string, unknown> = {}
  for (const n of SLOT_NAMES) members[n] = n in P ? koffi.pointer(P[n as keyof typeof P]) : 'void *'
  members.Reserved = koffi.array('void *', 31)
  const Iface = koffi.struct('SAD_FSP_FILE_SYSTEM_INTERFACE', members as never)
  if (koffi.sizeof(Iface) !== 512) throw new Error(`the WinFsp interface table is ${koffi.sizeof(Iface)} bytes here, not 512`)
  const refused: Record<string, unknown> = {}
  const refuse = (name: keyof typeof P) => (refused[name] ??= reg(() => NT.MEDIA_WRITE_PROTECTED, P[name]))
  const WRITES = new Set(['SetVolumeLabel', 'Create', 'Overwrite', 'Write', 'SetBasicInfo', 'SetFileSize', 'CanDelete', 'Rename', 'SetSecurity', 'SetDelete', 'CreateEx', 'OverwriteEx', 'SetEa', 'SetReparsePoint', 'DeleteReparsePoint'])
  const SERVED_WHEN_WRITABLE = new Set(['Create', 'Overwrite', 'Write', 'SetBasicInfo', 'SetFileSize', 'SetDelete', 'Rename'])
  const values: Record<string, unknown> = {}
  for (const n of SLOT_NAMES) {
    if (n === 'DispatcherStopped') values[n] = null
    // With saves, WinFsp must call the plain Create and Overwrite: their Ex forms are left NULL.
    else if (writes && (n === 'CreateEx' || n === 'OverwriteEx')) values[n] = null
    else if (n in cb && (!(WRITES.has(n)) || (writes && SERVED_WHEN_WRITABLE.has(n)) )) values[n] = cb[n as keyof typeof cb]
    // A change this drive does not take: refused as write protected. A slot whose function has its OWN prototype (Create, Write, ...) needs a refusal of that same shape (koffi checks the types).
    else if (WRITES.has(n) && n in P) values[n] = refuse(n as keyof typeof P)
    else values[n] = WRITES.has(n) ? cb.Protected : cb.Unsupported
  }
  values.Reserved = new Array(31).fill(null)
  const iface = koffi.alloc(Iface, 1)
  koffi.encode(iface, Iface, values)

  const params = Buffer.alloc(VOLUME_PARAMS_BYTES)
  params.writeUInt16LE(VOLUME_PARAMS_BYTES, 0)
  params.writeUInt16LE(512, 2) // SectorSize
  params.writeUInt16LE(1, 4) // SectorsPerAllocationUnit
  params.writeUInt16LE(255, 6) // MaxComponentLength
  params.writeBigUInt64LE(filetime(0), 8)
  params.writeUInt32LE(0x43524d46, 16) // serial "CRMF"
  params.writeUInt32LE(2000, 32) // FileInfoTimeout (ms): the CRM tree is cached by the agent
  params.writeUInt32LE(FLAGS | (answers.readOnly ? READ_ONLY_FLAG : 0), 36)
  Buffer.from('CRMFILES', 'utf16le').copy(params, 424)

  const out: unknown[] = [null]
  let st = Create('WinFsp.Disk', params, iface, out)
  if (st !== 0) throw new Error(`WinFsp would not make the file system (${hex(st)})`)
  const fsPtr = out[0]
  try {
    st = SetMountPoint(fsPtr, o.letter)
    if (st !== 0) throw new Error(`WinFsp could not use ${o.letter} (${hex(st)})`)
    st = StartDispatcher(fsPtr, 0)
    if (st !== 0) throw new Error(`WinFsp would not start serving (${hex(st)})`)
  } catch (e) {
    try {
      Delete(fsPtr)
    } catch {
      // nothing more to undo
    }
    throw e
  }
  log(`winfsp: ${o.letter} is served by the agent`)

  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      // Through the async form: WinFsp's threads may still be waiting for a callback that needs THIS thread's event loop.
      await new Promise<void>((resolve, reject) => (StopDispatcher as unknown as { async(fs: unknown, cb: (e: unknown) => void): void }).async(fsPtr, err => (err ? reject(err) : resolve())))
      RemoveMountPoint(fsPtr)
      Delete(fsPtr)
      log(`winfsp: ${o.letter} is gone`)
    },
  }
}

export { byName, DIR_INFO_HEADER }
