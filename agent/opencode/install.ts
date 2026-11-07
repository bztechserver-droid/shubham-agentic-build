import { createHash } from 'node:crypto'
import { readFileSync, statSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'

export const OPENCODE_VERSION = '1.19.4'
export const OPENCODE_ARCHIVE_SHA256 = '93b899277bd6f68803009e32bf71772ce43c34b18adf1e93b9b4d8780fdf62e5'
export const OPENCODE_ARCHIVE_BYTES = 81744896
export const OPENCODE_EXE_SHA256 = '41c848c0986720c02d39b015bd2672e454a221052f6947854bc508d8765d9711'
export const OPENCODE_EXE_BYTES = 211699592
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Read only the pinned archive's root executable; no archive-controlled paths are written. */
function unpack(archive: Buffer): Buffer {
  let end = archive.length - 22
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid bundled archive')
  let at = archive.readUInt32LE(end + 16)
  for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid archive directory')
    const nameLength = archive.readUInt16LE(at + 28), extra = archive.readUInt16LE(at + 30), comment = archive.readUInt16LE(at + 32)
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (name === 'opencode.exe') {
      const method = archive.readUInt16LE(at + 10), length = archive.readUInt32LE(at + 20), size = archive.readUInt32LE(at + 24), local = archive.readUInt32LE(at + 42)
      if (size !== OPENCODE_EXE_BYTES || archive.readUInt16LE(at + 8) & 1 || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid executable archive entry')
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      if (start + length > archive.length) throw new Error('Truncated bundled archive')
      const compressed = archive.subarray(start, start + length)
      const binary = method === 8 ? inflateRawSync(compressed, { maxOutputLength: OPENCODE_EXE_BYTES }) : method === 0 ? compressed : null
      if (!binary || binary.length !== OPENCODE_EXE_BYTES || digest(binary) !== OPENCODE_EXE_SHA256) throw new Error('Bundled executable integrity verification failed')
      return binary
    }
    at += 46 + nameLength + extra + comment
  }
  throw new Error('Bundled executable is missing')
}
export interface OpenCodeInstall { executable: string; version: string }
/** Only a release-manifest-pinned executable. Never PATH, ambient login, or an installer. */
export function findOpenCode(root = path.resolve(import.meta.dirname, '../..')): OpenCodeInstall | null {
  if (process.platform !== 'win32') return null
  try {
    const dir = path.join(root, 'tools', 'opencode', OPENCODE_VERSION)
    const pin = JSON.parse(readFileSync(path.join(dir, 'pin.json'), 'utf8'))
    if (pin.version !== OPENCODE_VERSION || pin.archiveSha256 !== OPENCODE_ARCHIVE_SHA256 || pin.archiveBytes !== OPENCODE_ARCHIVE_BYTES || pin.executableSha256 !== OPENCODE_EXE_SHA256) return null
    const executable = path.join(dir, 'opencode.exe')
    if (!existsSync(executable) || digest(readFileSync(executable)) !== OPENCODE_EXE_SHA256) {
      const bundled = path.join(dir, 'opencode-windows-x64.zip')
      if (statSync(bundled).size !== OPENCODE_ARCHIVE_BYTES) return null
      const archive = readFileSync(bundled)
      if (digest(archive) !== OPENCODE_ARCHIVE_SHA256) return null
      const binary = unpack(archive), temporary = path.join(dir, `opencode-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, binary, { flag: 'wx' })
        if (digest(readFileSync(temporary)) !== OPENCODE_EXE_SHA256) return null
        renameSync(temporary, executable)
      } finally { rmSync(temporary, { force: true }) }
    }
    if (digest(readFileSync(executable)) !== OPENCODE_EXE_SHA256) return null
    return { executable, version: OPENCODE_VERSION }
  } catch { return null }
}
