import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CRM_FILES_MAX_UPLOAD,
  CRM_UPLOAD_LIMIT_MB_MAX,
  CRM_UPLOAD_LOW_FREE_MB,
  CRM_UPLOAD_REASONS,
  type CrmUploadCrmLimit,
  type CrmUploadLimitFrom,
  type CrmUploadSettings,
} from '../../shared/crm-files.ts'
import { CrmFilesError, crmLimitFrom } from './service.ts'

// oa2f8 (Shubham, 11 Nov 2026): the uploads' settings, kept by the agent in <agent state>/crm-uploads.json (beside the default waiting folder, never inside it: the folder can move).
//   limitMb   the most one file may be. null (the default) = follow the CRM: the limit the CRM itself said, else its known rule (CRM_FILES_MAX_UPLOAD, 500 MB). A number is used as it is,
//             but never above what the CRM said it takes (a bigger file would go up to Google Drive only to be refused by the CRM at the end).
//   dir       the waiting folder. null (the default) = the agent's own folder. It changes only while no upload waits in the folder in use (nothing is ever moved between folders).
//   lowFreeMb the warning line: the page warns when the waiting folder's disk would have less than this free once the uploads on their way are in. 5 GB by default.
//   crmLimit  what the CRM last said its limit is (not a setting: what was said). The CRM has no route that tells it, so it is taken where the CRM says it by itself: in its refusal of a
//             REAL record that is too big ("file_size must not exceed 524288000 bytes (500 MB)", sam-crm-be middleware/fileValidation.js), or in its upload token's answer, should the CRM
//             ever add the number there. The agent never asks the CRM for it (no request of its own; Lead, 11 Nov 2026).

export const UPLOAD_SETTINGS_FILE = 'crm-uploads.json'
const MB = 1024 * 1024
/** The most the warning line may be set to (10 TB). */
const LOW_FREE_MB_MAX = 10 * 1024 * 1024

export interface StoredUploadSettings extends CrmUploadSettings {
  v: 1
  crmLimit: CrmUploadCrmLimit | null
}

export function defaultUploadSettings(): StoredUploadSettings {
  return { v: 1, limitMb: null, dir: null, lowFreeMb: CRM_UPLOAD_LOW_FREE_MB, crmLimit: null }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi

/** The settings on the disk; the default for anything missing or not understood (a bad file never stops the uploads, and is written over at the next change). */
export async function readUploadSettings(file: string): Promise<StoredUploadSettings> {
  const s = defaultUploadSettings()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return s
  }
  if (!isObject(raw)) return s
  if (raw.limitMb === null || whole(raw.limitMb, 1, CRM_UPLOAD_LIMIT_MB_MAX)) s.limitMb = raw.limitMb
  if (raw.dir === null || (typeof raw.dir === 'string' && path.isAbsolute(raw.dir) && raw.dir.length <= 240)) s.dir = raw.dir
  if (whole(raw.lowFreeMb, 0, LOW_FREE_MB_MAX)) s.lowFreeMb = raw.lowFreeMb
  const c = raw.crmLimit
  if (isObject(c) && whole(c.bytes, 1, Number.MAX_SAFE_INTEGER) && whole(c.at, 0, Number.MAX_SAFE_INTEGER) && (c.how === 'refused' || c.how === 'token')) {
    s.crmLimit = { bytes: c.bytes, at: c.at, how: c.how }
  }
  return s
}

/** Written whole, through a temporary file (a crash leaves the old settings or the new ones, never half). */
export async function writeUploadSettings(file: string, s: StoredUploadSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 1))
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file)
      return
    } catch (e) {
      // Windows: a scanner may hold the old file for a moment.
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
      await new Promise(r => setTimeout(r, 25 * (i + 1)))
    }
  }
}

/** The limit in force now, and where it comes from. */
export function limitOf(s: Pick<StoredUploadSettings, 'limitMb' | 'crmLimit'>): { bytes: number; from: CrmUploadLimitFrom } {
  const crm = s.crmLimit?.bytes
  if (s.limitMb !== null) {
    const mine = s.limitMb * MB
    return crm !== undefined && crm < mine ? { bytes: crm, from: 'crm' } : { bytes: mine, from: 'setting' }
  }
  return crm !== undefined ? { bytes: crm, from: 'crm' } : { bytes: CRM_FILES_MAX_UPLOAD, from: 'default' }
}

/** The CRM's limit in its own words (service.ts has it: it reads the CRM's answers). */
export { crmLimitFrom }

const bad = (why: string) => new CrmFilesError(400, 'failed', why)

export function checkLimitMb(v: unknown): number | null {
  if (v === null) return null
  if (!whole(v, 1, CRM_UPLOAD_LIMIT_MB_MAX)) throw bad(`The size limit is a whole number of MB from 1 to ${CRM_UPLOAD_LIMIT_MB_MAX}, or empty to follow the CRM.`)
  return v
}

export function checkLowFreeMb(v: unknown): number {
  if (!whole(v, 0, LOW_FREE_MB_MAX)) throw bad(`The warning line is a whole number of MB from 0 to ${LOW_FREE_MB_MAX}.`)
  return v
}

/**
 * A waiting folder the person typed: a whole path to a folder on this PC's own disks (no network folder: a part must be on the disk before it is acknowledged), not inside the app's own
 * folders (`notInside`: an update replaces them). The agent's own folder, or an empty text, is null (the default).
 */
export function checkDir(v: unknown, defaultDir: string, notInside: string[] = [], platform: NodeJS.Platform = process.platform): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw bad('The folder is a text (a whole path), or empty for the agent\'s own folder.')
  const d = v.trim()
  if (!d) return null
  if (d.length > 240) throw bad(CRM_UPLOAD_REASONS.dirBad('the path is too long.'))
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(d)) throw bad(CRM_UPLOAD_REASONS.dirBad('it has characters a folder name can not have.'))
  const p = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(d)) throw bad(CRM_UPLOAD_REASONS.dirBad('a network folder is not allowed. Choose a folder on this PC\'s own disks.'))
    if (!/^[A-Za-z]:[\\/]/.test(d)) throw bad(CRM_UPLOAD_REASONS.dirBad('give the whole path, from the drive letter (for example D:\\CRM uploads).'))
  } else if (!p.isAbsolute(d)) throw bad(CRM_UPLOAD_REASONS.dirBad('give the whole path, from /.'))
  const full = p.resolve(d)
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(full, p.resolve(defaultDir))) return null
  for (const root of notInside) {
    const r = p.resolve(root)
    const rel = p.relative(r, full)
    if (same(full, r) || (rel && !rel.startsWith('..') && !p.isAbsolute(rel))) throw bad(CRM_UPLOAD_REASONS.dirBad('it is inside the app\'s own folder, which an update replaces.'))
  }
  return full
}

/** The folder can be made and written to (a small file of the agent's own is written and removed again), and its disk's free space can be read. */
export async function checkUsable(dir: string): Promise<void> {
  const probe = path.join(dir, `.write-check-${process.pid}-${Date.now()}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probe, 'ok')
    await rm(probe, { force: true })
    await statfs(dir)
  } catch (e) {
    await rm(probe, { force: true }).catch(() => undefined)
    const code = (e as NodeJS.ErrnoException)?.code
    throw bad(CRM_UPLOAD_REASONS.dirBad(code === 'EACCES' || code === 'EPERM' ? 'this PC does not let the agent write there.' : code === 'ENOENT' ? 'that disk is not there.' : `it can not be written (${code ?? 'error'}).`))
  }
}
