// F-069: files sent to a chat with a message (a photo, a picture pasted from the clipboard, any file).
// The page uploads each to the PC the chat runs on, which keeps it in its uploads folder under a name
// made here; the message then carries one line per file naming where it is, which is how claude finds
// it (it reads the path), and how the chat view finds it again to show a thumbnail. Types and rules
// only: nothing here touches a file or the page.

/** The most one file may be (after the page has made a picture smaller). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024
/** The most files one message may carry. */
export const ATTACH_MAX_FILES = 6
/** What the page is told it may show as a picture (an SVG is not here: it can carry script). */
export const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

/** One file of a message, as the chat view shows it. */
export interface ChatAttachment {
  /** The name it is kept under (also what the page asks for it by). */
  file: string
  /** The name it had, for a person. */
  name: string
  /** A picture the page can show as a thumbnail. */
  image: boolean
}

/** The kept name: `<time>-<random>-<name>`, the name made safe: letters, digits and `. _ - ( ) + , @` and spaces. */
const STORED_RE = /^([a-z0-9]{6,10})-([a-z0-9]{4,8})-([\w. ()+,@-]{1,100})$/i

export const isStoredName = (file: string) => STORED_RE.test(file) && !file.includes('..')

/** A name a person gave, made safe for a file name (never empty, never starting with a dot). */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  let s = base.normalize('NFKD').replace(/[^\w. ()+,@-]/g, '_').replace(/_{2,}/g, '_').replace(/^[. ]+/, '').trim()
  if (s.length > 100) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : ''
    s = s.slice(0, 100 - ext.length) + ext
  }
  return s || 'file'
}

/** The name a file is kept under: unique, sorted by time, the person's name at the end. */
export function storedName(name: string, now = Date.now(), random = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0')): string {
  return `${now.toString(36)}-${random()}-${safeName(name)}`
}

export const attachmentOf = (file: string): ChatAttachment => {
  const name = STORED_RE.exec(file)?.[3] ?? file
  return { file, name, image: IMAGE_NAME_RE.test(name) }
}

const LINE_RE = /^\[Attached file: (.+)\]$/

/** The line a message carries for a file kept at `path` (the whole path, so claude can read it). */
export const attachmentLine = (path: string) => `[Attached file: ${path}]`

/** A message's text as it is stored, split into what the person wrote and the files it names. */
export function splitAttachments(stored: string): { text: string; files: ChatAttachment[] } {
  const files: ChatAttachment[] = []
  const kept: string[] = []
  for (const line of stored.split('\n')) {
    const m = LINE_RE.exec(line.trimEnd())
    const file = m ? m[1].split(/[\\/]/).pop() : undefined
    if (file && isStoredName(file)) files.push(attachmentOf(file))
    else kept.push(line)
  }
  return files.length ? { text: kept.join('\n').trim(), files } : { text: stored, files }
}
