// Preserve Codex's onboarding answers without retaining stale app-owned model/instruction/MCP settings.
// Scan outside strings/arrays: apparent table headers inside multiline briefs are ordinary text.
interface Section { keys: string[]; text: string; entries: Set<string> }
function keys(header: string): string[] {
  const result: string[] = []
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*(?:\.|$)/gy
  let offset = 0
  while (offset < header.length) {
    re.lastIndex = offset
    const match = re.exec(header)
    if (!match) throw new Error('Cannot preserve malformed TOML table')
    const key = match[1]
    result.push(key.startsWith('"') ? JSON.parse(key) : key.startsWith("'") ? key.slice(1, -1) : key)
    offset = re.lastIndex
  }
  return result
}
function sections(text: string): Section[] {
  const starts: { start: number; keys: string[]; entries: Set<string> }[] = [{ start: 0, keys: [], entries: new Set() }]
  let quote = '', triple = false, depth = 0, lineStart = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) { i += 2; quote = ''; triple = false }
      else if (!triple && ch === quote) quote = ''
      lineStart = ch === '\n'
      continue
    }
    if (lineStart && depth === 0) {
      const end = text.indexOf('\n', i)
      const line = text.slice(i, end < 0 ? undefined : end)
      const array = /^\s*\[\[(.*?)\]\]\s*(?:#.*)?$/.exec(line)
      const match = /^\s*\[(?!\[)(.*?)\]\s*(?:#.*)?$/.exec(line)
      if (array) {
        starts.push({ start: i, keys: ['$array', ...keys(array[1])], entries: new Set() })
        i += line.length - 1; lineStart = false; continue
      }
      if (match) {
        starts.push({ start: i, keys: keys(match[1]), entries: new Set() })
        i += line.length - 1; lineStart = false; continue
      }
      const entry = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=/.exec(line)
      if (entry) starts.at(-1)!.entries.add(keys(entry[1])[0])
    }
    if (ch === '#') { const end = text.indexOf('\n', i); if (end < 0) break; i = end - 1; continue }
    if (ch === '"' || ch === "'") {
      quote = ch; triple = text.slice(i, i + 3) === ch.repeat(3)
      if (triple) i += 2
    } else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    lineStart = ch === '\n'
  }
  if (quote || depth !== 0) throw new Error('Cannot preserve incomplete TOML')
  return starts.map((entry, i) => ({ keys: entry.keys, entries: entry.entries, text: text.slice(entry.start, starts[i + 1]?.start) }))
}
const runtime = (section: Section) => ['windows', 'projects', 'notice'].includes(section.keys[0])

/** Fresh app settings plus losslessly retained onboarding tables; generated values seed missing answers. */
export function keepRuntimeConfig(current: string, generated: string): string {
  const old = sections(current).filter(runtime)
  const fresh = sections(generated)
  if (!old.length && !fresh.some(runtime)) return generated
  const result = fresh.filter(section => !runtime(section)).map(section => section.text).join('')
  const id = (section: Section) => JSON.stringify(section.keys)
  if (new Set(old.map(id)).size !== old.length) throw new Error('Duplicate saved TOML table')
  for (const seed of fresh.filter(runtime)) {
    const saved = old.find(section => id(section) === id(seed))
    if (!saved) { old.push(seed); continue }
    // Seeds contain one scalar answer each; all existing keys, comments and multiline values stay byte-for-byte.
    const entry = seed.text.split('\n').find(line => /^\w+\s*=/.test(line))
    if (entry) {
      const name = entry.split('=')[0].trim()
      if (!saved.entries.has(name)) saved.text += `\n${entry}\n`
    }
  }
  return result.trimEnd() + '\n\n' + old.map(section => section.text.trimEnd()).join('\n\n') + '\n'
}
