// Small file helpers that outlived the Common Drive (F-097, removed on Shubham's order, 10 Nov 2026): the name rules a new
// folder or a rename is checked against (the CRM files page, F-126), the phone's own name (POST /voice/name), a file's
// kind for its icon, and sizes and times in a few words. Pure: no page, no socket.

// ---- names -----------------------------------------------------------------------------------------------------------

export const MAX_NAME_BYTES = 255

const BAD_CHARS = /[<>:"/\\|?*]/
/** A control character (0 to 31, 127): tested by its code, so no pattern has to hold one. */
const hasControl = (s: string) => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Why a single name can't be used, in words for a person; null when it can. The same on every operating system. */
export function nameProblem(name: string): string | null {
  if (!name) return 'The name is empty.'
  if (name === '.' || name === '..') return 'That name is not allowed.'
  if (BAD_CHARS.test(name) || hasControl(name)) return 'A name cannot contain < > : " / \\ | ? * or control characters.'
  if (/[. ]$/.test(name)) return 'A name cannot end with a dot or a space.'
  if (RESERVED.test(name)) return 'That name is reserved by Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).'
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'That name is too long.'
  return null
}

/** The key two names are compared by: Unicode NFC, then lower case. Two names with one key are "the same name in a different case". */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase()

/** The same name, case and Unicode form aside, so Windows and Linux agree. */
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b)

// ---- a file's kind, for its icon ---------------------------------------------------------------------------------------

export type FileGroup = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'sheet' | 'archive' | 'code' | 'other'
const GROUPS: Record<FileGroup, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'avif'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'doc', 'docx', 'rtf', 'odt'],
  sheet: ['xls', 'xlsx', 'csv', 'ods'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  code: ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'sh', 'ps1', 'cs', 'java', 'kt', 'yml', 'yaml', 'xml', 'sql'],
  other: [],
}
export function fileGroup(name: string): FileGroup {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'other'
  const ext = name.slice(dot + 1).toLowerCase()
  for (const g of Object.keys(GROUPS) as FileGroup[]) if (GROUPS[g].includes(ext)) return g
  return 'other'
}

// ---- sizes and times ---------------------------------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
/** "4.2 MB": one decimal under 10, none above; a byte is "512 B". */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let v = bytes
  let i = 0
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v))
  return `${text} ${UNITS[i]}`
}

/** "today", "yesterday", "3 days ago", else a date: short, for a row. */
export function whenText(ms: number, now: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(ms)) / 86_400_000)
  if (days <= 0) {
    const mins = Math.max(0, Math.round((now - ms) / 60_000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}
