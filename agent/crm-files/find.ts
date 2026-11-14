// Order o528e (Shubham: "if I ask you for any drive in the CRM, you should be able to give it to me here in the overlay chat ... a DP from development plan
// of a project"): the chat's crm_files tool finds CRM files by the words of their NAME, their PROJECT and their FOLDER (the project's file groups, nested, or a
// category of the CRM's Files page), and by their KIND. Pure: service.ts (find) hands it the CRM's own listing for the account signed in on this PC, the very
// one the CRM files page and the drive show (a project the person may not open is not in it). Read only: nothing here changes anything in the CRM.

import { endingOf } from '../../shared/media.ts'

export interface FindAsk {
  /** Words to find in the file's name, its folder or its project: all of them, any order, any case. */
  query?: string
  /** Words of the project's name (or its id). */
  project?: string
  /** Words of the folder it sits in (a file group of the project, nested; or a category of the Files page). */
  folder?: string
  /** A kind (pdf, image, video, drawing, sheet, document, slides, archive, audio) or a file ending (dwg, .xlsx). */
  type?: string
  /** How many to answer (default FIND_LIMIT, at most FIND_MAX). */
  limit?: number
}

export interface FindFile {
  /** The node id (file:<CRM id>). */
  id: string
  name: string
  type: string | null
  size: number | null
  modifiedAt: string | null
  /** The CRM's `folder` tag: "projects", or a category of the Files page. */
  category: string
  /** Its project (a "projects" file), or null. */
  projectId: string | null
  groupId: string | null
}

export interface FindGroup {
  id: string
  name: string
  parentId: string | null
}

export interface FindSource {
  files: readonly FindFile[]
  /** oe692: `home` is the drive's top folder the project sits in ("projects", or "Marketing Projects" for a marketing project); left out = "projects". */
  projects: ReadonlyMap<string, { id: string; name: string; home?: string }>
  /** A project's file groups (the service keeps them for a minute). */
  groupsOf(pid: string): Promise<readonly FindGroup[]>
}

export interface FoundFile {
  /** For show_crm_file. */
  id: string
  name: string
  project: string | null
  /** The folders inside the project, outermost first, joined by " / " ('' when it sits in the project itself); a category's name; "Uncategorised". */
  folder: string
  /** Where it is on the CRM files page (projects / <project> / <folders>; oe692: Marketing Projects / <project> / <folders> for a marketing project). */
  where: string
  type: string | null
  /** Its file ending, lower case, no dot ('' when it has none). */
  ending: string
  size: number | null
  modifiedAt: string | null
}

export interface FindResult {
  files: FoundFile[]
  /** How many matched (files holds the best `limit`). */
  total: number
  more: boolean
  /** The projects the project words picked, when they picked more than one. */
  projects?: string[]
  /** Anything the agent should know: no such project (with names near it), folders not all looked through. */
  note?: string
}

export const FIND_LIMIT = 20
export const FIND_MAX = 100
/** How long the folders of many projects are looked through before answering with what there is (the CRM lists one project's folders per request). */
export const FOLDER_BUDGET_MS = 8000
const AT_ONCE = 4

/** Kinds a person says, by file ending. */
export const FIND_KINDS: Readonly<Record<string, readonly string[]>> = {
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'mkv', 'wmv', '3gp'],
  drawing: ['dwg', 'dxf', 'dwf', 'dwfx', 'dgn', 'rvt', 'rfa', 'skp', 'ifc', '3dm', 'plt'],
  sheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'],
  document: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md'],
  slides: ['ppt', 'pptx', 'odp', 'key'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'],
}
const KIND_WORDS: Readonly<Record<string, string>> = {
  pdfs: 'pdf',
  images: 'image',
  picture: 'image',
  pictures: 'image',
  photo: 'image',
  photos: 'image',
  videos: 'video',
  drawings: 'drawing',
  cad: 'drawing',
  autocad: 'drawing',
  sheets: 'sheet',
  excel: 'sheet',
  spreadsheet: 'sheet',
  documents: 'document',
  doc: 'document',
  word: 'document',
  presentation: 'slides',
  powerpoint: 'slides',
  zip: 'archive',
}

export { endingOf }

/** Lower-case words: "DP_Plan-v2.pdf" -> dp, plan, v2, pdf; "DevelopmentPlan" -> development, plan. */
export function wordsOf(s: string): string[] {
  return s
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export interface Hay {
  words: string[]
  /** The first letters of its words, in order ("Development Plan" -> "dp"), so "DP" finds it. */
  initials: string
}
export const hayOf = (s: string): Hay => {
  const words = wordsOf(s)
  return { words, initials: words.filter(w => /^\p{L}/u.test(w)).map(w => w[0]).join('') }
}

/** How well one word is found: 3 a whole word, 2 the start of a word, 1 inside a word (4 letters or more) or the first letters of words in a row; 0 not found.
 *  A word of 4 letters or more ending in s is also looked for without it ("remarks" finds "DP_Remark"). */
export function levelOf(q: string, h: Hay): number {
  const one = (w: string) => {
    let best = 0
    for (const t of h.words) {
      if (t === w) return 3
      if (t.startsWith(w)) best = 2
      else if (best < 1 && w.length >= 4 && t.includes(w)) best = 1
    }
    if (best === 0 && w.length >= 2 && /^\p{L}+$/u.test(w) && h.initials.includes(w)) best = 1
    return best
  }
  const found = one(q)
  return found === 0 && q.length >= 4 && q.endsWith('s') ? one(q.slice(0, -1)) : found
}

/** Words that say nothing about which project ("the project of ..."). */
const NOT_A_NAME = new Set(['the', 'of', 'and', 'project', 'projects'])

/** Which endings a type asks for (null: any). An unknown word is taken as an ending. */
export function endingsFor(type: string | undefined): ReadonlySet<string> | null {
  const t = (type ?? '').trim().toLowerCase().replace(/^\*?\./, '')
  if (!t) return null
  if (t.includes('/')) {
    const e = endingOf('', t)
    return new Set(e ? [e] : [t])
  }
  const kind = FIND_KINDS[t] ? t : KIND_WORDS[t]
  return new Set(kind ? FIND_KINDS[kind] : [t])
}

const byRecent = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '')

/** The words, or none. */
const ask = (s: string | undefined) => (typeof s === 'string' ? wordsOf(s) : [])

export async function findFiles(src: FindSource, q: FindAsk, o: { budgetMs?: number; now?: () => number } = {}): Promise<FindResult> {
  const now = o.now ?? Date.now
  const limit = Math.max(1, Math.min(Math.floor(Number(q.limit)) || FIND_LIMIT, FIND_MAX))
  const qWords = ask(q.query)
  const fWords = ask(q.folder)
  const pText = (q.project ?? '').trim()
  const pAll = ask(pText)
  const pWords = pAll.filter(w => !NOT_A_NAME.has(w)).length > 0 ? pAll.filter(w => !NOT_A_NAME.has(w)) : pAll
  const endings = endingsFor(q.type)

  // The projects the project words pick (a project's id picks it too).
  let only: Set<string> | null = null
  let picked: string[] | undefined
  if (pText) {
    const all = [...src.projects.values()]
    const byId = all.find(p => p.id === pText)
    const hits = byId ? [byId] : all.filter(p => pWords.length > 0 && pWords.every(w => levelOf(w, hayOf(p.name)) > 0))
    if (hits.length === 0) {
      // Names near it: a project with at least one of the words (3 letters or more) as a word or the start of one; the most such words first.
      const near = all
        .map(p => {
          const h = hayOf(p.name)
          const levels = pWords.filter(w => w.length >= 3).map(w => levelOf(w, h))
          return { p, n: levels.filter(l => l >= 2).length, sum: levels.reduce((a, l) => a + l, 0) }
        })
        .filter(x => x.n > 0)
        .sort((a, b) => b.n - a.n || b.sum - a.sum || a.p.name.localeCompare(b.p.name))
        .slice(0, 10)
        .map(x => x.p.name)
      return { files: [], total: 0, more: false, note: `No project you can open has "${pText}" in its name.${near.length ? ` Projects with some of those words: ${near.join('; ')}.` : ''}` }
    }
    only = new Set(hits.map(p => p.id))
    if (hits.length > 1) picked = hits.map(p => p.name).sort((a, b) => a.localeCompare(b)).slice(0, 20)
  }

  const candidates = src.files.filter(f => {
    if (only && (!f.projectId || !only.has(f.projectId))) return false
    if (endings && !endings.has(endingOf(f.name, f.type))) return false
    return true
  })

  // The folders of the projects these files are in (the ones in a folder of their project): needed to match folder words (and query words, which may be a folder's), most recently changed projects
  // first, a few at a time, for at most FOLDER_BUDGET_MS. A project whose folders did not come in time is matched on its files' names and its own name only.
  const groups = new Map<string, FindGroup[]>()
  const latest = new Map<string, string>()
  for (const f of candidates) {
    if (!f.projectId || !f.groupId) continue
    const was = latest.get(f.projectId)
    const at = f.modifiedAt ?? ''
    if (was === undefined || at > was) latest.set(f.projectId, at)
  }
  const load = async (pids: string[], budgetMs: number) => {
    const until = now() + budgetMs
    let i = 0
    const worker = async () => {
      while (i < pids.length && now() < until) {
        const pid = pids[i++]
        if (groups.has(pid)) continue
        try {
          groups.set(pid, [...(await src.groupsOf(pid))])
        } catch {
          // left out: its files are matched without their folders
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, pids.length) }, worker))
  }
  const wanted = [...latest.entries()].sort((a, b) => byRecent(a[1], b[1])).map(([pid]) => pid)
  if (qWords.length > 0 || fWords.length > 0) await load(wanted, o.budgetMs ?? FOLDER_BUDGET_MS)
  const looked = wanted.filter(pid => groups.has(pid)).length

  const chainOf = (f: FindFile): string[] | null => {
    if (!f.projectId) return [f.category === 'projects' ? 'Uncategorised' : f.category]
    // Directly in its project: no folder to look up.
    if (!f.groupId) return []
    const gs = groups.get(f.projectId)
    if (!gs) return null
    const out: string[] = []
    const seen = new Set<string>()
    for (let g = f.groupId ? gs.find(x => x.id === f.groupId) : undefined; g && !seen.has(g.id); g = g.parentId ? gs.find(x => x.id === g!.parentId) : undefined) {
      seen.add(g.id)
      out.unshift(g.name)
    }
    return out
  }

  const scored: { f: FindFile; score: number }[] = []
  for (const f of candidates) {
    const chain = chainOf(f)
    if (fWords.length > 0) {
      if (!chain) continue
      const fh = hayOf(chain.join(' / '))
      if (!fWords.every(w => levelOf(w, fh) > 0)) continue
    }
    let score = 0
    if (qWords.length > 0) {
      const name = hayOf(f.name)
      const folder = chain ? hayOf(chain.join(' / ')) : null
      const project = f.projectId ? hayOf(src.projects.get(f.projectId)?.name ?? '') : null
      let all = true
      for (const w of qWords) {
        const best = Math.max(levelOf(w, name) * 3, folder ? levelOf(w, folder) * 2 : 0, project ? levelOf(w, project) : 0)
        if (best === 0) {
          all = false
          break
        }
        score += best
      }
      if (!all) continue
    }
    scored.push({ f, score })
  }
  scored.sort((a, b) => b.score - a.score || byRecent(a.f.modifiedAt, b.f.modifiedAt) || a.f.name.localeCompare(b.f.name, undefined, { sensitivity: 'base', numeric: true }))
  const top = scored.slice(0, limit)

  // Where the answered files are: their projects' folders, when not looked at yet (a few, briefly).
  const missing = [...new Set(top.filter(x => x.f.groupId).map(x => x.f.projectId).filter((p): p is string => !!p && !groups.has(p)))].slice(0, 10)
  if (missing.length) await load(missing, 3000)

  const files = top.map(({ f }): FoundFile => {
    const chain = chainOf(f)
    const project = f.projectId ? (src.projects.get(f.projectId)?.name ?? null) : null
    const folder = chain ? chain.join(' / ') : ''
    const where = f.projectId ? [src.projects.get(f.projectId)?.home ?? 'projects', project ?? '?', ...(chain ?? [])].join(' / ') : f.category === 'projects' ? 'projects / Uncategorised' : f.category
    return { id: f.id, name: f.name, project, folder, where, type: f.type, ending: endingOf(f.name, f.type), size: f.size, modifiedAt: f.modifiedAt }
  })

  const out: FindResult = { files, total: scored.length, more: scored.length > limit }
  if (picked) out.projects = picked
  if ((qWords.length > 0 || fWords.length > 0) && looked < wanted.length) {
    out.note = `Folder names were looked through in ${looked} of the ${wanted.length} projects with such files (the CRM lists each project's folders separately); the others were matched on file and project names only. Give project to look inside one project's folders.`
  }
  return out
}
