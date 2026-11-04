// F-105: the avatar's two letters: the first letter of the first name and of the last name ("Shubham Bhole" → "SB").
// One word only ("Shubham", or a username like "sbskrrt"): its first two letters. An email is cut at the @.

/** The words of a name or username: split at spaces, dots, dashes, underscores and commas. */
const words = (s: string) =>
  s
    .trim()
    .split('@')[0]
    .split(/[\s._,-]+/u)
    .filter(w => w !== '')

const first = (w: string) => Array.from(w)[0] ?? ''

/** The initials for a person: from the CRM name, else from the username. '' when there is neither. */
export function initials(name: string | null | undefined, username?: string | null): string {
  for (const source of [name, username]) {
    const w = words(source ?? '')
    if (w.length === 0) continue
    const letters = w.length === 1 ? Array.from(w[0]).slice(0, 2).join('') : first(w[0]) + first(w[w.length - 1])
    if (letters !== '') return letters.toLocaleUpperCase()
  }
  return ''
}
