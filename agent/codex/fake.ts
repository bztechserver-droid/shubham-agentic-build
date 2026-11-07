import { CrmError } from '../claude/crm.ts'
import type { Logger } from '../log.ts'
import type { CodexCredential, WriteBack } from './crm.ts'
import type { CodexCrm } from './index.ts'

// F-134, tests only: a stand-in for the CRM's Codex routes (an in-memory subscription with a revision) and a logger that remembers what was said.
// Fake logins only: the text is `{"fake":"<label>"}`; nothing here is a credential.

export interface FakeCodexCrm extends CodexCrm {
  /** The stored login text and revision, as the CRM would hold them. */
  stored: { text: string; revision: number }
  /** What the CRM does with write-backs: 'normal' decides like the real one (an identical file is fine, a stale revision is a conflict, else it is taken); the others force an answer. */
  mode: 'normal' | 'down' | 'busy' | 'expired' | { rejects: string }
  /** What the credential GET answers. */
  /** F-138: 'api_key' = the subscription is an API key (apiKey is handed out, revision as stored); the default is a ChatGPT login. */
  kind: 'chatgpt' | 'api_key'
  apiKey: string
  hand: 'login' | 'none' | 'disabled' | 'expired' | 'down' | 'error'
  calls: { credential: number; writeBack: number }
  /** Every write-back received (baseRevision and text), in order. */
  written: { baseRevision: number; authJson: string }[]
}

export function fakeCodexCrm(initial = { text: '{"fake":"seed"}', revision: 1 }): FakeCodexCrm {
  const f: FakeCodexCrm = {
    stored: { ...initial },
    mode: 'normal',
    kind: 'chatgpt',
    apiKey: 'sk-proj-FAKE-OPENAI-KEY-0000000000000001',
    hand: 'login',
    calls: { credential: 0, writeBack: 0 },
    written: [],
    async credential(): Promise<CodexCredential> {
      f.calls.credential++
      switch (f.hand) {
        case 'none':
          return { kind: 'none', state: 'no-subscription', code: 'NO_CODEX', message: 'Codex is not switched on for you.' }
        case 'disabled':
          return { kind: 'none', state: 'disabled', code: 'SUBSCRIPTION_DISABLED', message: 'Your Codex subscription "Shared" is turned off.' }
        case 'expired':
          return { kind: 'expired' }
        case 'down':
          throw new CrmError("Couldn't reach the CRM", null)
        case 'error':
          throw new CrmError('The CRM answered 500', 500)
      }
      if (f.kind === 'api_key') return { kind: 'ok', login: { subscription: { id: 'sub-2', name: 'API Team' }, kind: 'api_key', revision: f.stored.revision, refreshedAt: null, apiKey: f.apiKey } }
      return {
        kind: 'ok',
        login: { subscription: { id: 'sub-1', name: 'Shared' }, kind: 'chatgpt', revision: f.stored.revision, refreshedAt: null, authJson: f.stored.text },
      }
    },
    async writeBack(_s, _b, body): Promise<WriteBack> {
      f.calls.writeBack++
      f.written.push({ baseRevision: body.baseRevision, authJson: body.authJson })
      if (f.kind === 'api_key') return { kind: 'rejected', status: 400, code: 'NO_WRITEBACK', message: 'An API key is not refreshed; nothing is written back.' }
      if (f.mode === 'down') throw new CrmError("Couldn't reach the CRM", null)
      if (f.mode === 'busy') return { kind: 'later', status: 503, message: 'busy' }
      if (f.mode === 'expired') return { kind: 'expired' }
      if (typeof f.mode === 'object') return { kind: 'rejected', status: 409, code: f.mode.rejects, message: `The CRM refused it (${f.mode.rejects})` }
      if (body.authJson === f.stored.text) return { kind: 'ok', revision: f.stored.revision }
      if (body.baseRevision !== f.stored.revision) return { kind: 'conflict', revision: f.stored.revision }
      f.stored = { text: body.authJson, revision: f.stored.revision + 1 }
      return { kind: 'ok', revision: f.stored.revision }
    },
  }
  return f
}

/** A logger that keeps every line (level and text) so a test can look for a secret in them. */
export function fakeLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const add =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push(`${level}: ${args.map(String).join(' ')}`)
  const logger = { lines, debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error'), child: () => logger } as unknown as Logger & { lines: string[] }
  return logger
}
