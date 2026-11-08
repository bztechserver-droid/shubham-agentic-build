import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const refuse = (): never => { throw Object.assign(new Error('Private execution storage or its exclusive writer could not be proved.'), { status: 409, code: 'execution-intent-uncertain' }) }
interface WindowsSecurity {
  protect(file: string, directory: boolean): void
  assert(file: string): void
  flush(directory: string): void
  replace(from: string, to: string): void
}
let windows: WindowsSecurity | null = null
function windowsSecurity(): WindowsSecurity {
  if (windows) return windows
  const koffi = createRequire(import.meta.url)('koffi')
  const kernel = koffi.load('kernel32.dll'), security = koffi.load('advapi32.dll')
  const convert = security.func('bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16,uint32_t,_Out_ void**,_Out_ uint32_t*)')
  const set = security.func('bool __stdcall SetFileSecurityW(str16,uint32_t,void*)')
  const get = security.func('bool __stdcall GetFileSecurityW(str16,uint32_t,void*,uint32_t,_Out_ uint32_t*)')
  const stringify = security.func('bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void*,uint32_t,uint32_t,_Out_ void**,_Out_ uint32_t*)')
  const free = kernel.func('void* __stdcall LocalFree(void*)')
  const create = kernel.func('intptr_t __stdcall CreateFileW(str16,uint32_t,uint32_t,void*,uint32_t,uint32_t,intptr_t)')
  const flush = kernel.func('bool __stdcall FlushFileBuffers(intptr_t)')
  const close = kernel.func('bool __stdcall CloseHandle(intptr_t)')
  const move = kernel.func('bool __stdcall MoveFileExW(str16,str16,uint32_t)')
  const sid = /S-1-5-21-[0-9-]+/.exec(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }))?.[0]
  if (!sid) return refuse()
  windows = {
    protect(file, directory) {
      const descriptor = [null], length = [0], inherit = directory ? 'OICI' : ''
      if (!convert(`O:${sid}D:P(A;${inherit};FA;;;SY)(A;${inherit};FA;;;${sid})`, 1, descriptor, length)) return refuse()
      try { if (!set(file, 0x80000005, descriptor[0])) return refuse() } finally { free(descriptor[0]) }
      this.assert(file)
    },
    assert(file) {
      const descriptor = Buffer.alloc(65536), length = [0], pointer = [null], chars = [0]
      if (!get(file, 5, descriptor, descriptor.length, length) || !stringify(descriptor, 1, 5, pointer, chars)) return refuse()
      try {
        const sddl = String(koffi.decode(pointer[0], 'char16_t', -1))
        if (!sddl.startsWith(`O:${sid}D:`)) return refuse()
        const rules = [...sddl.matchAll(/\(([^)]+)\)/g)].map(match => match[1].split(';'))
        if (!rules.length || rules.some(rule => rule[0] !== 'A' || rule[2] !== 'FA' || !['SY', sid].includes(rule[5]))
          || !rules.some(rule => rule[5] === sid)) return refuse()
      } finally { free(pointer[0]) }
    },
    flush(directory) {
      const handle = create(directory, 0xc0000000, 7, null, 3, 0x02000000, 0)
      if (handle === -1) return refuse()
      try { if (!flush(handle)) return refuse() } finally { close(handle) }
    },
    replace(from, to) { if (!move(from, to, 1 | 8)) return refuse() },
  }
  return windows
}

export function assertPrivatePath(file: string): void {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return refuse()
  if (process.platform === 'win32') windowsSecurity().assert(file)
  else if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return refuse()
}
export function protectPath(file: string): void {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return refuse()
  if (process.platform === 'win32') windowsSecurity().protect(file, stat.isDirectory())
  else fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600)
  assertPrivatePath(file)
}
export function syncExecutionDirectory(directory: string): void {
  assertPrivatePath(directory)
  if (process.platform === 'win32') return windowsSecurity().flush(directory)
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export function writePrivateAtomic(file: string, data: string, beforeCommit?: () => void): void {
  if (!path.isAbsolute(file)) return refuse()
  const temporary = `${file}.${randomUUID()}.next`, directory = path.dirname(file)
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { protectPath(temporary); fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { beforeCommit?.() } catch (error) {
    // No rename was dispatched; remove only this freshly created, same-directory staging file.
    try { fs.unlinkSync(temporary) } catch { /* The authoritative file stays untouched. */ }
    throw error
  }
  if (process.platform === 'win32') windowsSecurity().replace(temporary, file)
  else fs.renameSync(temporary, file)
  // The floor document's parent may contain legacy app files. Protect the new file, not unrelated paths.
  assertPrivatePath(file)
  if (process.platform === 'win32') windowsSecurity().flush(directory)
  else { const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) } }
}

/** A streamed, fsynced fresh transcript is committed without replacing an existing conversation. */
export function commitPreparedTranscript(temporary: string, file: string): void {
  if (path.dirname(temporary) !== path.dirname(file) || fs.existsSync(file)) return refuse()
  assertPrivatePath(temporary)
  if (process.platform === 'win32') {
    // Move without REPLACE_EXISTING: a collided native SID must fail closed.
    const koffi = createRequire(import.meta.url)('koffi'), kernel = koffi.load('kernel32.dll')
    const move = kernel.func('bool __stdcall MoveFileExW(str16,str16,uint32_t)')
    if (!move(temporary, file, 8)) return refuse()
    windowsSecurity().flush(path.dirname(file))
  } else {
    fs.linkSync(temporary, file); fs.unlinkSync(temporary)
    const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
}

/** An OS-owned exclusive listener fences writers by lifetime, independent of PID reuse or stale lock files. */
export async function openExecutionStorage(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); protectPath(directory)
  const port = 23000 + Number.parseInt(createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 6), 16) % 15000
  const server = net.createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', reject); resolve() })
  })
  let closed = false, failed = false
  server.on('error', () => { failed = true })
  const assertExclusiveWriter = () => { if (closed || failed || !server.listening) return refuse(); assertPrivatePath(directory) }
  const assertPrivateStorage = async (dir: string) => {
    assertExclusiveWriter()
    if (path.resolve(dir) !== path.resolve(directory)) return refuse()
    for (const item of fs.readdirSync(directory)) assertPrivatePath(path.join(directory, item))
  }
  syncExecutionDirectory(directory)
  return { directory, assertExclusiveWriter, assertPrivateStorage,
    syncDirectory: async (dir: string) => { assertExclusiveWriter(); syncExecutionDirectory(dir) },
    close() { closed = true; server.close() } }
}
