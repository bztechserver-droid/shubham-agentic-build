import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const unavailable = (): never => { throw new Error('Current Windows execution ownership is unavailable') }
const DWORD_MAX = 0xffffffff, MAX_TABLE = 2 * 1024 * 1024
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= DWORD_MAX
const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535

/** MIB_TCPTABLE_OWNER_PID: DWORD count, followed by six-DWORD IPv4 rows.
 * Only an exact single LISTEN / 127.0.0.1 / network-order port / owning PID is admitted. */
export function tableOwnsLoopbackListener(table: Buffer, pid: number, port: number): boolean {
  if (!validPid(pid) || !validPort(port) || table.length < 4 || table.length > MAX_TABLE) return false
  const count = table.readUInt32LE(0)
  if (count > (MAX_TABLE - 4) / 24 || 4 + count * 24 > table.length) return false
  let matches = 0
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 24
    if (table.readUInt32LE(offset) === 2 && table.readUInt32BE(offset + 4) === 0x7f000001
      && table.readUInt16BE(offset + 8) === port && table.readUInt32LE(offset + 20) === pid) matches++
  }
  return matches === 1
}

let windows: ReturnType<typeof loadWindows> | null = null
function loadWindows() {
  if (process.platform !== 'win32') return unavailable()
  const koffi = createRequire(import.meta.url)('koffi'), kernel = koffi.load('kernel32.dll'), ip = koffi.load('iphlpapi.dll')
  return {
    table: ip.func('uint32_t __stdcall GetExtendedTcpTable(_Out_ void*, _Inout_ uint32_t*, bool, uint32_t, uint32_t, uint32_t)'),
    open: kernel.func('intptr_t __stdcall CreateFileW(str16,uint32_t,uint32_t,void*,uint32_t,uint32_t,void*)'),
    info: kernel.func('bool __stdcall GetFileInformationByHandle(intptr_t,_Out_ void*)'),
    read: kernel.func('bool __stdcall ReadFile(intptr_t,_Out_ void*,uint32_t,_Out_ uint32_t*,void*)'),
    close: kernel.func('bool __stdcall CloseHandle(intptr_t)'),
    openProcess: kernel.func('intptr_t __stdcall OpenProcess(uint32_t,bool,uint32_t)'),
    processTimes: kernel.func('bool __stdcall GetProcessTimes(intptr_t,_Out_ void*,_Out_ void*,_Out_ void*,_Out_ void*)'),
    exitCode: kernel.func('bool __stdcall GetExitCodeProcess(intptr_t,_Out_ uint32_t*)'),
  }
}

/** One running process instance, from the kernel directly (no shell): its PID and exact creation time (100 ns
 * FILETIME), or null when that PID is not running now. A PID reused by another process has another creation time.
 * Microseconds instead of the ~0.8 s a PowerShell process query takes. */
export function processIdentity(pid: number): string | null {
  if (!validPid(pid)) return null
  const os = api()
  // PROCESS_QUERY_LIMITED_INFORMATION: enough for times and exit code of the same user's processes.
  const handle = os.openProcess(0x1000, false, pid)
  if (!handle) return null
  try {
    const code = [0]
    if (!os.exitCode(handle, code) || code[0] !== 259) return null // STILL_ACTIVE
    const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8)
    if (!os.processTimes(handle, created, exited, kernel, user)) return null
    const at = created.readBigUInt64LE(0)
    return at > 0n ? `${pid}:${at}` : null
  } finally { os.close(handle) }
}
const api = () => windows ??= loadWindows()

/** Fresh local kernel table read. No shell, network request, probe or cached listener evidence. */
export function ownsLoopbackListener(pid: number, port: number): boolean {
  if (!validPid(pid) || !validPort(port)) return false
  const size = [0], os = api()
  if (os.table(null, size, false, 2, 3, 0) !== 122) return unavailable()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!Number.isInteger(size[0]) || size[0] < 4 || size[0] > MAX_TABLE) return unavailable()
    const table = Buffer.alloc(size[0]), status = os.table(table, size, false, 2, 3, 0)
    if (status === 122) continue
    if (status !== 0 || size[0] > table.length) return unavailable()
    return tableOwnsLoopbackListener(table.subarray(0, size[0]), pid, port)
  }
  return unavailable()
}

/** SHA-256 is computed from a handle that denies all writes for its lifetime. Every use reopens
 * the path and compares its actual volume/file identity. Atomic replacement is detected even
 * with identical size, timestamps or bytes. No mtime cache or expiry-based trust is used. */
export function pinImmutableBinary(file: string) {
  if (!path.isAbsolute(file) || !/^[A-Za-z]:[\\/]/.test(file)) return unavailable()
  const os = api()
  const open = () => {
    // GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, OPEN_EXISTING.
    const handle = os.open(file, 0x80000000, 5, null, 3, 0, null)
    if (handle === -1 || handle === -1n) return unavailable()
    return handle
  }
  const identity = (handle: number | bigint) => {
    const info = Buffer.alloc(52)
    if (!os.info(handle, info) || info.readUInt32LE(0) & (0x10 | 0x400)
      || !(info.readUInt32LE(44) || info.readUInt32LE(48))
      || info.readUInt32LE(32) !== 0 || info.readUInt32LE(36) === 0 || info.readUInt32LE(36) > 1024 * 1024 * 1024) return unavailable()
    return { key: `${info.readUInt32LE(28)}:${info.readUInt32LE(44)}:${info.readUInt32LE(48)}`, bytes: info.readUInt32LE(36) }
  }
  const handle = open()
  let closed = false
  try {
    const pinned = identity(handle), digest = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024)
    let total = 0
    while (total < pinned.bytes) {
      const read = [0], length = Math.min(chunk.length, pinned.bytes - total)
      if (!os.read(handle, chunk, length, read, null) || read[0] < 1 || read[0] > length) return unavailable()
      digest.update(chunk.subarray(0, read[0])); total += read[0]
    }
    const sha256 = digest.digest('hex')
    const assertCurrent = () => {
      if (closed) return unavailable()
      const current = open()
      try {
        const observed = identity(current)
        if (observed.key !== pinned.key || observed.bytes !== pinned.bytes) return unavailable()
      } finally { os.close(current) }
    }
    assertCurrent()
    return { sha256, assertCurrent, close() { if (!closed) { closed = true; os.close(handle) } } }
  } catch (error) { closed = true; os.close(handle); throw error }
}
