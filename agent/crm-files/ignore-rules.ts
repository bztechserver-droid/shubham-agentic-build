import type { CrmChildren } from '../../shared/crm-files.ts'
import { buildRulesByFolder, createMatcher, type DriveignoreFile, type Matcher } from './driveignore.ts'
import { legalWindowsName } from './dav-crm.ts'

// o6e65 (S7, the hook): which files of the drive are kept on this PC only. The rules are `.driveignore` files in the CRM's own file tree (ordinary CRM files, so they travel with the folder to every PC
// and person that shares it), read with gitignore rules by driveignore.ts, plus the built-in switchable defaults (editor and system files). A file matched is not uploaded: it is kept in the spool as
// "ignored" and stays readable and writable through the drive. A file already in the CRM that matches stays there (nothing is ever deleted) and its new local saves are kept here instead.
//
// The rules for one save are those of the folders the file is in, from the top of the drive down (nearest folder wins). Each folder's `.driveignore` is read once per version of that file and
// kept for a short while; nothing here is ever written.

export const DRIVEIGNORE = '.driveignore'
/** A `.driveignore` larger than this is read only up to it (rules are small text). */
export const MAX_RULES_BYTES = 64 * 1024
/** A rule line longer than this is not a rule (it would only make a pathological pattern): dropped before the rules are built. */
export const MAX_RULE_LINE = 1000

const sanitize = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter(l => l.length <= MAX_RULE_LINE)
    .join('\n')

/** What the rules need of the CRM files service. */
export interface IgnoreSource {
  children(id: string): Promise<CrmChildren>
  file(id: string): Promise<{ stream: AsyncIterable<unknown> & { destroy(): unknown }; size: number | null }>
}

export interface IgnoreRules {
  /** Why `name` (a file, or a folder if `isDir`) in the folder `parentId` is kept on this PC only: the rule's words, or null when it goes to the CRM. */
  reason(parentId: string, name: string, isDir: boolean): Promise<string | null>
  /** The rules are read again at the next question (a `.driveignore` was saved, or the defaults were switched). */
  invalidate(): void
}

export interface IgnoreRulesOptions {
  source: () => IgnoreSource | null
  /** The built-in defaults (~$*, *.tmp, Thumbs.db, desktop.ini, .DS_Store, node_modules, *.crdownload): on unless the person turned them off. */
  defaults: () => boolean
  now?: () => number
  /** How long what was read is trusted (ms, default 30 s). */
  ttlMs?: number
  log?: { warn(m: string): void }
}

export function createIgnoreRules(o: IgnoreRulesOptions): IgnoreRules {
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 30_000
  let generation = 0
  /** Per folder id: its `.driveignore` text (null = none) and when it was read. */
  const texts = new Map<string, { at: number; gen: number; key: string; text: string | null }>()
  let built: { key: string; matcher: Matcher } | null = null

  async function textOf(src: IgnoreSource, folderId: string): Promise<string | null> {
    const had = texts.get(folderId)
    if (had && had.gen === generation && now() - had.at < ttl) return had.text
    let text: string | null = null
    let key = ''
    try {
      const kids = (await src.children(folderId)).children
      const f = kids.find(k => !k.isFolder && k.name.toLowerCase() === DRIVEIGNORE)
      if (f) {
        key = `${f.id}|${f.modifiedAt ?? ''}|${f.size ?? ''}`
        if (had && had.key === key && had.gen === generation) text = had.text
        else text = await read(src, f.id)
      }
    } catch (e) {
      // The CRM did not answer: the last rules it gave are kept (a save is not sent to the CRM on a guess either way).
      o.log?.warn(`crm drive: the .driveignore of a folder could not be read (${e instanceof Error ? e.message : String(e)})`)
      if (had) return had.text
    }
    texts.set(folderId, { at: now(), gen: generation, key, text })
    return text
  }

  async function read(src: IgnoreSource, id: string): Promise<string> {
    const f = await src.file(id)
    const parts: Buffer[] = []
    let n = 0
    try {
      for await (const c of f.stream) {
        const b = Buffer.from(c as Uint8Array)
        parts.push(b)
        n += b.length
        if (n >= MAX_RULES_BYTES) break
      }
    } finally {
      f.stream.destroy()
    }
    return Buffer.concat(parts).subarray(0, MAX_RULES_BYTES).toString('utf8')
  }

  return {
    invalidate() {
      generation++
      built = null
    },

    async reason(parentId, name, isDir) {
      if (!isDir && name.toLowerCase() === DRIVEIGNORE) return null // the rules themselves are ordinary, shared CRM files
      const src = o.source()
      if (!src) return null
      let here: CrmChildren
      try {
        here = await src.children(parentId)
      } catch {
        return null
      }
      // The folders from the top of the drive down to this one, with the drive's names for them.
      const chain = [...here.path.filter(p => p.id !== 'root'), ...(here.node.id !== 'root' && !here.path.some(p => p.id === here.node.id) ? [{ id: here.node.id, name: here.node.name }] : [])]
      const folders: { id: string; folder: string }[] = [{ id: 'root', folder: '' }]
      let acc = ''
      for (const p of chain) {
        acc = acc ? `${acc}/${legalWindowsName(p.name)}` : legalWindowsName(p.name)
        folders.push({ id: p.id, folder: acc })
      }
      const files: DriveignoreFile[] = []
      let key = `${o.defaults() ? 'd' : 'n'}|${generation}`
      for (const f of folders) {
        const text = await textOf(src, f.id)
        if (text !== null) {
          files.push({ folder: f.folder, text: sanitize(text) })
          key += `|${f.folder}:${text.length}:${text.slice(0, 40)}`
        }
      }
      const full = acc ? `${acc}/${legalWindowsName(name)}` : legalWindowsName(name)
      try {
        if (!built || built.key !== key) built = { key, matcher: createMatcher(buildRulesByFolder(files, { defaults: o.defaults() })) }
        if (!built.matcher.isIgnored(full, isDir)) return null
      } catch (e) {
        // A rule file the engine cannot use must never stop a save: nothing is claimed ignored on a broken rule.
        o.log?.warn(`crm drive: the .driveignore rules could not be used (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`)
        built = null
        return null
      }
      return `A .driveignore rule (or the built-in list of editor and system files) keeps “${name}” on this PC only: it is not sent to the CRM.`
    },
  }
}
