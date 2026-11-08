import type { Auth } from '../auth/index.ts'
import { authError, type Caller } from '../auth/types.ts'
import { apiError } from '../api.ts'
import type { ChatMenu } from '../../shared/chat.ts'

export const APPROVAL_RPC_VERSION = 1
export const APPROVAL_GRANT_MS = 60_000
export interface NativeApprovalProof {
  version: 1
  grantId: string
  pcId: string
  sessionId: string
  floorId: string
  agentId: string
  generation: string
  targetEpoch: string
  hubEpoch: string | null
  hubId: string | null
  promptId: string
  expiresAt: number
}
export interface NativeApprovalSnapshot {
  proof: NativeApprovalProof
  menu: ChatMenu | null
  context: string
  cancellable: boolean
}
export interface NativeApprovalCommit { version: 1; proof: NativeApprovalProof; action: 'answer' | 'cancel'; n?: number }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).every(k => names.includes(k))
export function isNativeApprovalProof(v: unknown): v is NativeApprovalProof {
  return object(v) && keys(v, ['version', 'grantId', 'pcId', 'sessionId', 'floorId', 'agentId', 'generation', 'targetEpoch', 'hubEpoch', 'hubId', 'promptId', 'expiresAt']) &&
    v.version === 1 && ['grantId', 'pcId', 'sessionId', 'floorId', 'agentId', 'generation', 'targetEpoch', 'promptId'].every(k => short(v[k])) &&
    (v.hubEpoch === null || short(v.hubEpoch)) && (v.hubId === null || short(v.hubId)) && Number.isSafeInteger(v.expiresAt)
}
export function isNativeApprovalCommit(v: unknown): v is NativeApprovalCommit {
  return object(v) && keys(v, ['version', 'proof', 'action', 'n']) && v.version === 1 && isNativeApprovalProof(v.proof) &&
    (v.action === 'cancel' ? v.n === undefined : v.action === 'answer' && Number.isInteger(v.n) && Number(v.n) >= 1 && Number(v.n) <= 99)
}
export function nativeApprovalSnapshot(v: unknown, pcId: string, sid: string): NativeApprovalSnapshot | null {
  if (!object(v) || !keys(v, ['proof', 'menu', 'context', 'cancellable']) || !isNativeApprovalProof(v.proof) || v.proof.pcId !== pcId || v.proof.sessionId !== sid ||
      typeof v.context !== 'string' || v.context.length > 40_000 || typeof v.cancellable !== 'boolean') return null
  const m = v.menu
  if (m !== null && (!object(m) || !['header', 'question', 'hint'].every(k => typeof m[k] === 'string' && (m[k] as string).length <= 4000) || typeof m.multi !== 'boolean' ||
      !Array.isArray(m.options) || m.options.length > 99 || !m.options.every(o => object(o) && Number.isInteger(o.n) && Number(o.n) > 0 && Number(o.n) <= 99 &&
        typeof o.label === 'string' && o.label.length <= 4000 && typeof o.description === 'string' && o.description.length <= 4000 && typeof o.selected === 'boolean'))) return null
  return v as unknown as NativeApprovalSnapshot
}

export type HumanRequest = { headers: Record<string, string | string[] | undefined>; caller?: Caller }
/** CRM-derived cookie sessions are the only proof. Legacy signatures/caller assertions are not consulted. */
export function requireCrmHuman(auth: Auth | undefined, request: HumanRequest | undefined, adminOnly = false): Caller {
  if (request?.headers['x-sad-chat-key'] !== undefined) throw authError(403, 'Only the signed-in person may use this action; not a chat tool.', 'not-yours')
  const caller = auth && request ? auth.caller(request.headers) : null
  if (!auth || !caller?.person || !caller.sid || !auth.status(caller).session) throw authError(401, 'Sign in through CRM on this app page to continue.', 'sign-in')
  if (adminOnly && !auth.isAdmin(caller)) throw authError(403, 'Only a signed-in app administrator may use this action.', 'admin-only')
  return caller
}
export function describeHuman(c: Caller): string {
  return `${c.person!.username.replace(/[\r\n]/g, ' ')} (${c.person!.id.slice(0, 8)}) signed in through CRM`
}
/** One native prompt is acted on at most once, even when two clicks overlap before screen refresh. */
export function createPromptActions() {
  // Never evict accepted/uncertain intents and silently make their native keys replayable.
  // Prompt IDs also bind the coordinator incarnation, so restart invalidates old UI intents.
  const actions = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  return {
    run<T>(key: string, fingerprint: string, work: (markNativeAttempt: () => void) => Promise<T>): Promise<T> {
      const previous = actions.get(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint) return Promise.reject(apiError(409, 'This prompt already has an answer in progress; refresh it.'))
        return previous.promise as Promise<T>
      }
      if (actions.size >= 10_000) return Promise.reject(apiError(429, 'Prompt action history is full; no action was sent. Refresh after an app restart.'))
      let attempted = false
      const entry: { fingerprint: string; promise: Promise<unknown> } = {
        fingerprint,
        promise: Promise.resolve().then(() => work(() => { attempted = true })).catch(error => {
          // A provable pre-native refusal must not poison the prompt for a later valid login.
          // Once a native operation was attempted, retain its result/uncertainty forever.
          if (!attempted && actions.get(key) === entry) actions.delete(key)
          throw error
        }),
      }
      actions.set(key, entry)
      return entry.promise as Promise<T>
    },
  }
}
