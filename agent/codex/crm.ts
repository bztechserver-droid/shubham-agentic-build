import type { CodexState } from '../../shared/codex.ts'
import { call, csrfToken, CrmError, isObject, refusal, text, type CrmSession } from '../claude/crm.ts'

// F-134: the CRM's Codex subscription for the person signed in here. Two requests, both with the person's own CRM session (the one F-007 keeps):
//   GET /v1/org/codex-subscriptions/mine/credential   the login (the text of an auth.json) of the subscription the CRM put this person on
//   PUT /v1/org/codex-subscriptions/mine/credential   {baseRevision, authJson}: the login Codex refreshed on this PC, handed back
// (sam-crm-be controller/codexSubscriptionsController.js). The PUT is the one write; it is a compare-and-swap on the revision, so an older copy never
// overwrites a newer one, and the CRM only takes a REAL refresh (same account, later expiry, a new refresh token, an OpenAI signature). The login is
// never logged and never put in an error; only names, codes and revision numbers are.

type Auth = Pick<CrmSession, 'url' | 'cookie'>

interface LoginBase {
  subscription: { id: string; name: string }
  revision: number
  refreshedAt: string | null
}
/** F-138: the CRM's Codex credential is one of two kinds. A ChatGPT login is a file (refreshed by Codex, put back to the CRM); an API key is a string that never goes to disk and is never written back. */
export type CodexLogin = (LoginBase & { kind: 'chatgpt'; /** The file's text, byte for byte. */ authJson: string }) | (LoginBase & { kind: 'api_key'; apiKey: string })

/** What an OpenAI API key looks like (the CRM checks the same shape before it stores one, lib/codexLogin.js parseOpenAiKey). Not an Anthropic key. */
export const OPENAI_KEY_RE = /^sk-(?!ant-)[A-Za-z0-9_-]{20,}$/

export type CodexCredential =
  | { kind: 'ok'; login: CodexLogin }
  /** The CRM gives this person no Codex login now. `state` is what the page says; `message` is the CRM's own sentence. */
  | { kind: 'none'; state: Extract<CodexState, 'no-subscription' | 'disabled' | 'turned-off'>; code: string | null; message: string }
  /** The CRM session is no longer good (401). */
  | { kind: 'expired' }

/** GET mine/credential. `build` goes in x-christopher-build (the CRM records it as which copy asked). Throws CrmError when the CRM can't be reached or answers something unexpected. */
export async function credential(s: Auth, build: string): Promise<CodexCredential> {
  const r = await call(`${s.url}/v1/org/codex-subscriptions/mine/credential`, {
    headers: { cookie: s.cookie, accept: 'application/json', 'x-christopher-build': build },
  })
  if (r.status === 200) {
    const sub = r.body.subscription
    const authJson = typeof r.body.authJson === 'string' ? r.body.authJson : ''
    const apiKey = typeof r.body.apiKey === 'string' ? r.body.apiKey : ''
    const revision = r.body.revision
    const kind = r.body.kind
    // Each kind carries only its own secret, in its own shape; the wrong one, or both, is not an answer this app uses (and the text is never put in the error).
    const shaped = kind === 'chatgpt' ? !!authJson && !apiKey : kind === 'api_key' ? OPENAI_KEY_RE.test(apiKey) && !authJson : false
    if (!shaped || !isObject(sub) || text(sub.id) === null || !Number.isInteger(revision) || (revision as number) < 1) {
      throw new CrmError("The CRM's answer had no Codex login in the shape it hands out", 200)
    }
    const base = { subscription: { id: String(sub.id), name: text(sub.name) ?? 'Codex' }, revision: revision as number, refreshedAt: text(r.body.refreshedAt) }
    return { kind: 'ok', login: kind === 'chatgpt' ? { ...base, kind, authJson } : { ...base, kind: 'api_key', apiKey } }
  }
  if (r.status === 401) return { kind: 'expired' }
  const code = text(r.body.code)
  const message = text(r.body.error) ?? `The CRM has no Codex subscription for you (it answered ${r.status})`
  if (r.status === 409 && code === 'SUBSCRIPTION_DISABLED') return { kind: 'none', state: 'disabled', code, message }
  if ((r.status === 404 && code === 'NO_SUBSCRIPTION') || (r.status === 403 && code === 'NO_CODEX')) return { kind: 'none', state: 'no-subscription', code, message }
  throw refusal(r, "The CRM couldn't give the Codex subscription")
}

export type WriteBack =
  | { kind: 'ok'; revision: number }
  /** Someone wrote first: the CRM's revision is `revision`. Fetch its copy; this file's refresh token is dead. */
  | { kind: 'conflict'; revision: number | null }
  /** The CRM will never take this file (another account, an older or identical login, not a refresh, not valid, not assigned any more): `code` and `message` say which. */
  | { kind: 'rejected'; status: number; code: string | null; message: string }
  | { kind: 'expired' }
  /** Not now: the CRM is busy, down, its signing keys can't be fetched, or the brake is on. The file is kept and tried again. */
  | { kind: 'later'; status: number; message: string }

/** PUT mine/credential. A network failure throws a CrmError with status null, which a caller treats as `later`. */
export async function writeBack(s: Auth, build: string, body: { baseRevision: number; authJson: string }): Promise<WriteBack> {
  const csrf = await csrfToken(s)
  const r = await call(`${s.url}/v1/org/codex-subscriptions/mine/credential`, {
    method: 'PUT',
    headers: {
      cookie: `${s.cookie}; crm_csrf=${csrf}`,
      'x-csrf-token': csrf,
      'x-christopher-build': build,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ baseRevision: body.baseRevision, authJson: body.authJson }),
  })
  const code = text(r.body.code)
  const message = text(r.body.error) ?? `The CRM answered ${r.status}`
  if (r.status === 200 && Number.isInteger(r.body.revision)) return { kind: 'ok', revision: r.body.revision as number }
  if (r.status === 401) return { kind: 'expired' }
  if (r.status === 409 && code === 'REVISION_CONFLICT') return { kind: 'conflict', revision: Number.isInteger(r.body.revision) ? (r.body.revision as number) : null }
  if (r.status === 429 || r.status === 503 || r.status >= 500) return { kind: 'later', status: r.status, message }
  // 403 is also what a wrong CSRF pair looks like: that one is this app's fault and is not a verdict on the file.
  if (r.status === 403 && /csrf/i.test(message)) throw refusal(r, 'The CRM turned the CSRF pair down')
  if (r.status === 400 || r.status === 403 || r.status === 404 || r.status === 409) return { kind: 'rejected', status: r.status, code, message }
  throw refusal(r, "The CRM wouldn't take the Codex login")
}
