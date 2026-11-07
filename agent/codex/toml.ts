// F-134: the small part of TOML this app writes for the Codex CLI (config.toml and a profile file per chat). Strings, numbers, booleans, arrays, inline tables and
// [tables]; nothing is read back. Every string is a basic string with its escapes, so a brief with quotes, backslashes, newlines or a """ in it cannot end up
// as anything but text, and a key is quoted unless it is a bare-key word.

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue }

/** A basic string: "…" with \\ \" and the control characters escaped (newline as \n, anything else below space as \uXXXX). */
export function tomlString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

/** A key: bare when it is letters, digits, - and _; quoted otherwise. */
export const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k))

export function tomlValue(v: TomlValue): string {
  if (typeof v === 'string') return tomlString(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('TOML has no NaN or infinity')
    return String(v)
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  return `{ ${Object.entries(v)
    .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
    .join(', ')} }`
}

/** One [table]: its path as keys (a server called "my.server" is one key, not two) and its values. */
export interface TomlTable {
  path: string[]
  body: Record<string, TomlValue>
}

/** `key = value` lines for the top level of a file, then each [table] in turn. */
export function renderToml(top: Record<string, TomlValue>, tables: TomlTable[] = []): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(top)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`)
  for (const t of tables) {
    if (lines.length) lines.push('')
    lines.push(`[${t.path.map(tomlKey).join('.')}]`)
    for (const [k, v] of Object.entries(t.body)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`)
  }
  return `${lines.join('\n')}\n`
}
