// Codebase details slice: the codebase's editable details (what the agent checks and the page sends). Pure: no network.

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

export const CODEBASE_EDIT_LIMITS = { name: 200, repoUrl: 500, localPath: 500, description: 5000, stack: 500, ownerName: 200 } as const

export interface CodebaseEditInput {
  name: string
  repoUrl: string | null
  localPath: string | null
  description: string | null
  stack: string | null
  ownerName: string | null
  retired: boolean
  /** True when the address was hidden (it looked like a secret) and was not retyped: it is kept as it is. */
  keepRepo: boolean
  /** True when the description was hidden and was not retyped: it is kept as it is. */
  keepDescription: boolean
}

const opt = (v: unknown, max: number, what: string): Checked<string | null> => {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: true, value: null }
  if (t.length > max) return { ok: false, message: `The ${what} is longer than ${max} characters.` }
  return { ok: true, value: t }
}

export function checkCodebaseEdit(raw: unknown): Checked<CodebaseEditInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'The codebase is missing.' }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return { ok: false, message: 'A codebase needs a name.' }
  if (name.length > CODEBASE_EDIT_LIMITS.name) return { ok: false, message: `The name is longer than ${CODEBASE_EDIT_LIMITS.name} characters.` }
  const repo = opt(r.repoUrl, CODEBASE_EDIT_LIMITS.repoUrl, 'repository address')
  if (!repo.ok) return repo
  if (repo.value !== null && !/^https?:\/\//i.test(repo.value)) return { ok: false, message: 'The repository address starts with http:// or https://.' }
  // A user name or password in the address is never kept (it would be a secret in the clear).
  if (repo.value !== null && /^https?:\/\/[^/?#]*@/i.test(repo.value)) return { ok: false, message: 'The repository address has a user name or password in it: take that out.' }
  const local = opt(r.localPath, CODEBASE_EDIT_LIMITS.localPath, 'local folder')
  if (!local.ok) return local
  const description = opt(r.description, CODEBASE_EDIT_LIMITS.description, 'description')
  if (!description.ok) return description
  const stack = opt(r.stack, CODEBASE_EDIT_LIMITS.stack, 'stack')
  if (!stack.ok) return stack
  const owner = opt(r.ownerName, CODEBASE_EDIT_LIMITS.ownerName, 'owner')
  if (!owner.ok) return owner
  if (r.retired !== undefined && typeof r.retired !== 'boolean') return { ok: false, message: 'Retired is yes or no.' }
  return {
    ok: true,
    value: { name, repoUrl: repo.value, localPath: local.value, description: description.value, stack: stack.value, ownerName: owner.value, retired: r.retired === true, keepRepo: r.keepRepo === true, keepDescription: r.keepDescription === true },
  }
}
