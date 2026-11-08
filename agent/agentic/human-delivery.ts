import { randomUUID } from 'node:crypto'

export type HumanInputPhase = 'paste' | 'submit'
interface Grant {
  pc: string
  token: object
  messageId: string
  sessionId: string
  valid: () => boolean
  expires: number
  next: number
  generation?: string
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Ephemeral authority, never a cookie transfer or a replay queue. Each input needs a new grant. */
export function createHumanInputGrants(now = Date.now) {
  const grants = new Map<string, Grant>()
  return {
    register(pc: string, token: object, messageId: string, sessionId: string, valid: () => boolean) {
      for (const [nonce, grant] of grants) if (now() >= grant.expires) grants.delete(nonce)
      if (grants.size >= 10_000 || !valid()) return null
      const nonce = randomUUID()
      grants.set(nonce, { pc, token, messageId, sessionId, valid, expires: now() + 330_000, next: 0 })
      return { nonce, close: () => { grants.delete(nonce) } }
    },
    authorize(pc: string, token: object | undefined, raw: unknown) {
      const deny = { version: 1, allowed: false }
      if (!object(raw) || typeof raw.nonce !== 'string' || typeof raw.messageId !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.generation !== 'string' || !/^[0-9a-f]{32}$/.test(raw.generation) || !Number.isInteger(raw.sequence) || (raw.sequence as number) < 0 || (raw.sequence as number) > 4096 || !['paste', 'submit'].includes(String(raw.phase))) return deny
      const grant = grants.get(raw.nonce)
      if (!grant || grant.pc !== pc || grant.token !== token || grant.messageId !== raw.messageId || grant.sessionId !== raw.sessionId || grant.next !== raw.sequence || now() >= grant.expires || (grant.generation !== undefined && grant.generation !== raw.generation)) return deny
      let current = false
      try { current = grant.valid() } catch { /* no current CRM authorization */ }
      if (!current) { grants.delete(raw.nonce); return deny }
      grant.generation = raw.generation
      grant.next++
      return { version: 1, allowed: true, sequence: raw.sequence }
    },
    close() { grants.clear() },
  }
}
