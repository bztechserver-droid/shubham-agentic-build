// Order o16d2 (Shubham: "you should be able to show me images and videos here itself in the chat like whatsapp does"): the pure part of a
// picture or video an agent shows in its chat. The agent calls the app's MCP tool show_media with a file on its PC or an https address;
// the agent keeps a list of what was shared (agent/agentic/media.ts) and answers with a short JSON line the chat's transcript carries
// (the tool's answer); the page reads it back (parseMediaResult) and draws a picture or a video in the conversation, not a tool line.
// A file is served by an unguessable link, to the owner of the app only, read only, pictures and videos only, at most MEDIA_MAX_BYTES.

/** The largest file the app will show (and serve). */
export const MEDIA_MAX_BYTES = 200 * 1024 * 1024

/** A shared file's id: 24 url-safe characters (18 random bytes): a link nobody can guess. */
export const MEDIA_ID = /^[A-Za-z0-9_-]{24}$/

/** The page's address of a shared file (the agent's own route is /agentic/media/<id>; the page reaches the agent under /agent-api). */
export const MEDIA_PATH_PREFIX = '/agent-api/agentic/media/'
export const mediaPath = (id: string) => `${MEDIA_PATH_PREFIX}${id}`

/** o528e: a CRM file the agent gave (show_crm_file) is also a PDF (its pages drawn by the app, page by page) or any other file (a card to download it). */
export type MediaKind = 'image' | 'video' | 'pdf' | 'file'

/** What the tool answers and the chat shows. */
export interface MediaShown {
  kind: MediaKind
  /** The app's own link (/agent-api/agentic/media/<id>) or the https address the agent gave. */
  src: string
  /** The file's name (or the address's last part), for the viewer and a download. */
  name: string
  /** Bytes, when the file is the app's; null for an address. */
  size: number | null
  caption: string | null
  /** o528e: a CRM file: where it is in the CRM (projects / <project> / <folders>). */
  where?: string
}

/** The tool's name as claude writes it in its transcript: mcp__<the app's server>__show_media. */
export const MEDIA_TOOL = 'show_media'
/** o528e: a CRM file given in the chat (the app's MCP tool show_crm_file): the same bubble, from the CRM through this PC. */
export const CRM_FILE_TOOL = 'show_crm_file'
export const isMediaToolName = (name: string) => name === MEDIA_TOOL || name === CRM_FILE_TOOL || /^mcp__[^_].*__show_(media|crm_file)$/.test(name)

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i

/** Only these may be drawn: the app's own media link, or an https address (never a file path, never http, never data:). */
export function safeMediaSrc(src: string): string | null {
  const s = src.trim()
  if (s.startsWith(MEDIA_PATH_PREFIX)) return MEDIA_ID.test(s.slice(MEDIA_PATH_PREFIX.length)) ? s : null
  return /^https:\/\/[^\s<>"'\\]+$/i.test(s) && s.length <= 2048 ? s : null
}

/** A picture unless the address's path ends like a video file. */
export function kindOfSrc(src: string): MediaKind {
  let p = src
  try {
    p = new URL(src, 'https://x.invalid').pathname
  } catch {
    // keep the raw string
  }
  return VIDEO_EXT.test(p) ? 'video' : 'image'
}

/** The last part of an address, for a name. */
export function nameOfSrc(src: string): string {
  try {
    const u = new URL(src, 'https://x.invalid')
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
    return last || u.hostname || 'media'
  } catch {
    return 'media'
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** The tool's answer as the chat has it (a JSON line, maybe cut short): what to show, or null (an error, an older answer, anything else). */
export function parseMediaResult(output: string): MediaShown | null {
  const start = output.indexOf('{')
  if (start < 0) return null
  let data: unknown
  try {
    data = JSON.parse(output.slice(start))
  } catch {
    return null
  }
  const m = typeof data === 'object' && data !== null ? (data as { media?: unknown }).media : null
  if (typeof m !== 'object' || m === null) return null
  const r = m as Record<string, unknown>
  const src = typeof r.src === 'string' ? safeMediaSrc(r.src) : null
  if (!src || (r.kind !== 'image' && r.kind !== 'video' && r.kind !== 'pdf' && r.kind !== 'file')) return null
  // A PDF or another file is only ever the app's own link (a CRM file through this PC).
  if ((r.kind === 'pdf' || r.kind === 'file') && !src.startsWith(MEDIA_PATH_PREFIX)) return null
  const where = str(r.where, 300)
  return {
    kind: r.kind,
    src,
    name: str(r.name, 200) ?? nameOfSrc(src),
    size: typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0 ? r.size : null,
    caption: str(r.caption, 500),
    ...(where ? { where } : {}),
  }
}

/** "1.2 MB", for a caption line. */
export function sizeWords(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** The link that saves the file rather than showing it (the app's own files; an address is saved as it is). */
export const downloadSrc = (src: string) => (src.startsWith(MEDIA_PATH_PREFIX) ? `${src}?download=1` : src)

/** o528e: a file's ending, lower case, no dot: from its name, else from its type (application/pdf -> pdf); '' when there is none. */
export function endingOf(name: string, type: string | null = null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())
  if (m) return m[1].toLowerCase()
  const t = (type ?? '').toLowerCase()
  if (t === 'application/pdf') return 'pdf'
  const sub = /^(?:image|video|audio)\/([a-z0-9]+)$/.exec(t)
  return sub ? (sub[1] === 'jpeg' ? 'jpg' : sub[1]) : ''
}

// o528e: a PDF's pages, drawn as pictures by the PC that serves the page (Windows' own PDF reader), at a few widths so a phone and a computer each get a
// sharp one without one per pixel: GET <src>/pdf -> { pages }, GET <src>/pdf/<n>?w=<width> -> that page as a JPEG.
export const PDF_WIDTHS = [480, 720, 1080, 1440, 2160, 3240, 4320] as const
/** The width drawn for a wish: the smallest one at least that wide (the widest at most). */
export const pdfWidth = (w: number): number => PDF_WIDTHS.find(x => x >= (Number.isFinite(w) ? w : 1080)) ?? PDF_WIDTHS[PDF_WIDTHS.length - 1]
export const pdfInfoSrc = (src: string) => `${src}/pdf`
export const pdfPageSrc = (src: string, page: number, w: number) => `${src}/pdf/${page}?w=${pdfWidth(w)}`
export interface PdfInfo {
  pages: number
}
