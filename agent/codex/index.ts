import type { CodexState, CodexStatus } from '../../shared/codex.ts'
import { createHash, randomUUID } from 'node:crypto'
import { apiError } from '../api.ts'
import { CrmError, type CrmSession } from '../claude/crm.ts'
import type { Logger } from '../log.ts'
import * as crmApi from './crm.ts'
import type { CodexCredential, WriteBack } from './crm.ts'
import { codexPaths, hasLogin, placeLogin, readLogin, readSidecar, removeLogin, writeBase, writeSidecar, type CodexPaths } from './home.ts'
import { BRIDGE_VALIDATION_CADENCE_MS, BRIDGE_VALIDATION_TIMEOUT_MS, BRIDGE_VALIDATION_MAX_AGE_MS,
  bridgeCredentialError, requireBridgeContext, sameBridgeCredential, type BridgeCredentialCode,
  type ManagedBridgeSource, type ManagerBridgeContext } from './bridge-credentials.ts'
import type { BridgeRequestAuthorization } from '../codex-claude/contract.ts'

// F-134: Codex on this PC runs on the Codex subscription the CRM gives the person signed in here, exactly as Claude does (F-007): the agent asks the CRM for
// THAT PERSON'S login with their CRM session, so there is no Codex sign-in on any PC and no key typed into the app. This file keeps the login's whole life on
// this PC:
//
//   before the first Codex chat starts   the login is fetched and written to the Codex home (home.ts) with its sidecar (revision and hash, no secret)
//   while Codex chats run                Codex may REFRESH it (about every 10 days). A refresh rotates the refresh token, so the file Codex rewrote is the ONLY copy of the
//                                        new login: it is put back to the CRM (a compare-and-swap on the revision) as soon as it changes
//   after the last Codex chat            a changed file is put back FIRST; only a file that is unchanged, or that the CRM has taken (or can never take), is deleted
//   at the agent's start                 the same, for a crash that happened after a refresh
//
// THE RULE THAT MATTERS: a changed login file is never deleted before the CRM has it. If the CRM can't be reached (offline, a 5xx, a busy or braking CRM, its
// signing keys can't be fetched, the CRM session ended) the file stays, owner-only, and is tried again every few minutes, at every hourly check and at every start.
// Only a 409 that says someone already wrote a newer login (we fetch theirs, and this file's refresh token is dead anyway) or a verdict that the CRM will never take
// this file (another account, an older or identical login, not valid) lets it go, and then only after the CRM's own copy has been fetched to replace it.
//
// While a changed file waits, a new Codex chat starts from THAT file (it is the newest login there is), never from an older CRM copy.
//
// F-138: the CRM's Codex credential can also be an OPENAI API KEY (kind 'api_key'). It is not a file: it is held in memory only, never written to disk (no auth.json, no sidecar), never
// written back (an API key does not refresh), and given to each Codex chat through its environment (CODEX_API_KEY, credentialEnv()). A newer key restarts the chats that hold the old one.
//
// Logs and the status carry names, codes and revision numbers only; the login's text and the key are never put in either.

/** The variable Codex reads an API key from. */
export const API_KEY_VAR = 'CODEX_API_KEY'
export const CHECK_EVERY_MS = 60 * 60 * 1000
export const RETRY_EVERY_MS = 3 * 60 * 1000
/** How often a changed login file is looked for while Codex chats run (Codex rewrites it by itself, a few times a month). */
export const WATCH_EVERY_MS = 20_000

/** The CRM calls this manager makes; tests give a stand-in. */
export interface CodexCrm {
  credential(s: Pick<CrmSession, 'url' | 'cookie'>, build: string, signal?: AbortSignal): Promise<CodexCredential>
  writeBack(s: Pick<CrmSession, 'url' | 'cookie'>, build: string, body: { baseRevision: number; authJson: string }): Promise<WriteBack>
}

export interface CodexInstall {
  path: string
  version: string | null
}

export interface CodexOptions {
  /** <state>/agent/codex */
  dir: string
  /** This PC's device ID: the CRM records "sad-<id>" as which copy asked. */
  deviceId: string
  /** The person signed in to the CRM here (the session F-007 keeps), or null. Read every time: the session can end or change. */
  session: () => CrmSession | null
  /** The Codex CLI on this PC, or null. */
  find: () => CodexInstall | null
  log: Logger
  /** Tests: a stand-in CRM. */
  crm?: CodexCrm
  now?: () => number
  /** Tests: false = no timers; the test calls tick() / watch() itself. */
  timers?: boolean
  /** A newer login was put in place while Codex chats were running: they hold the older one and are restarted (resume keeps the conversation). */
  onNewerLogin(): void
  onChange(): void
}

export interface CodexManager {
  readonly paths: CodexPaths
  /** Backend-only provider consumers. No raw credential getter and no independent refresher. */
  readonly bridgeCredentials: ManagedBridgeSource
  /** The codex executable of this PC, or null. */
  bin(): string | null
  status(): CodexStatus
  /** F-138: the API key the CRM gave this person, as the variable a Codex chat is started with, or null (a ChatGPT login is a file in the Codex home, not a variable). */
  credentialEnv(): { name: typeof API_KEY_VAR; value: string } | null
  /** A Codex chat is about to start: the login is made ready (fetched, or the newest local one kept). Throws an apiError with a Codex `code` when it can't be. */
  acquire(sessionId: string): Promise<void>
  /** That chat ended. When it was the last one, a changed login is put back and the file taken out. */
  release(sessionId: string): Promise<void>
  /** A Codex chat that was already running when the agent started (the chat host kept it): it holds the login file, so the file stays until it ends. */
  adopt(sessionId: string): void
  /** Asks the CRM now (the hourly check, and the page's Check now). */
  check(): Promise<CodexStatus>
  /** Puts a changed login file back to the CRM now. */
  settle(): Promise<SettleResult>
  /** At the agent's start: a login file left by a crash is settled, and taken out when nothing runs. */
  sweep(): Promise<void>
  running(): number
  /** Looks for a changed file while chats run (the watcher calls this; exported for tests). */
  watch(): Promise<void>
  close(): void
}

export type SettleResult = 'none' | 'accepted' | 'conflict' | 'rejected' | 'waiting'

type Outcome = Exclude<CodexState, 'ok' | 'not-installed'>

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const codexError = (status: number, code: CodexState, text: string) => Object.assign(apiError(status, text), { code })

export function createCodex(o: CodexOptions): CodexManager {
  const log = o.log
  const now = o.now ?? Date.now
  const crm: CodexCrm = o.crm ?? crmApi
  const paths = codexPaths(o.dir)
  const build = `sad-${o.deviceId}`
  const leases = new Set<string>()

  let lastOutcome: Outcome | 'ok' | null = null
  let outcomeHint: string | null = null
  let assigned: CodexStatus['assigned'] = null
  let lastFetchedAt: string | null = null
  let lastWrittenBackAt: string | null = null
  let waiting = false
  let closed = false
  /** F-138: the API key of the person's Codex subscription, memory only. */
  let key: { value: string; subscriptionId: string; revision: number } | null = null

  // One thing at a time: a fetch, a write-back and a release never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  // F159: these holds share native cleanup accounting, but never a SID or native engine filter.
  const bridgeConsumers = new Set<string>()
  const bridgeFlights = new Map<string, Set<AbortController>>()
  let bridgeReceipt: ManagerBridgeContext | null = null
  let bridgeValidated = false
  let bridgeFailure: BridgeCredentialCode = 'bridge-credential-unavailable'
  let bridgeTimer: NodeJS.Timeout | null = null
  type Validation = { active: boolean; controller: AbortController; timer: NodeJS.Timeout; done: Promise<void>; finish: () => void }
  let validation: Validation | null = null
  let validationNotBefore = 0
  const sessionEpoch = (s: CrmSession | null) => s ? createHash('sha256').update(JSON.stringify([s.url, s.user.id, s.signedInAt, s.cookie])).digest('hex') : null
  function invalidateBridge(reason: BridgeCredentialCode, forget = false) {
    bridgeValidated = false
    bridgeFailure = reason
    if (forget) bridgeReceipt = null
    for (const flights of bridgeFlights.values()) for (const flight of flights) flight.abort()
  }
  function authorization(text: string, revision: number): BridgeRequestAuthorization | null {
    try {
      const raw = JSON.parse(text), tokens = raw?.tokens
      if (raw?.auth_mode !== 'chatgpt' || typeof tokens?.access_token !== 'string' || tokens.access_token.length > 65_536 ||
          typeof tokens.account_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(tokens.account_id)) return null
      const parts = tokens.access_token.split('.')
      if (parts.length !== 3 || parts.some((p: string) => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return null
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      const expiresAtMs = claims?.exp * 1000, account = claims?.['https://api.openai.com/auth']
      if (!Number.isSafeInteger(claims?.exp) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
          (account !== undefined && account?.chatgpt_account_id !== tokens.account_id)) return null
      // The CRM response + current hash/sidecar is authority, not locally decoded JWT claims/signature.
      return { accessToken: tokens.access_token, accountId: tokens.account_id, expiresAtMs, credentialRevision: revision }
    } catch { return null }
  }
  function recordBridge(s: CrmSession, subscriptionId: string, revision: number, contentHash: string, at: number) {
    const login = readLogin(paths), side = readSidecar(paths), token = login ? authorization(login.text, revision) : null
    if (closed || !token || sessionEpoch(o.session()) !== sessionEpoch(s) || login?.sha256 !== contentHash || side?.sha256 !== contentHash ||
        side.userId !== s.user.id || side.subscriptionId !== subscriptionId || side.baseRevision !== revision || key || waiting) {
      invalidateBridge('bridge-credential-unavailable', true); return
    }
    let candidate: ManagerBridgeContext = { ownerId: s.user.id, sessionEpoch: sessionEpoch(s)!, subscriptionId, revision, contentHash,
      credentialEpoch: bridgeReceipt?.credentialEpoch ?? randomUUID(), expiresAtMs: token.expiresAtMs,
      validatedAtMs: at, validationExpiresAtMs: at + BRIDGE_VALIDATION_MAX_AGE_MS }
    if (bridgeReceipt && !sameBridgeCredential(bridgeReceipt, candidate)) {
      invalidateBridge('bridge-context-changed', true); candidate = { ...candidate, credentialEpoch: randomUUID() }
    }
    try { requireBridgeContext(candidate, s.user.id, now()) }
    catch { invalidateBridge('bridge-refresh-required'); return }
    bridgeReceipt = Object.freeze(candidate); bridgeValidated = true
  }
  function currentBridge(expected?: ManagerBridgeContext): ManagerBridgeContext | null {
    const receipt = bridgeReceipt
    if (closed || !receipt) return null
    const s = o.session(), login = readLogin(paths), side = readSidecar(paths)
    if (!s || sessionEpoch(s) !== receipt.sessionEpoch || s.user.id !== receipt.ownerId || key || waiting ||
        !login || login.sha256 !== receipt.contentHash || !side || side.sha256 !== receipt.contentHash || side.userId !== receipt.ownerId ||
        side.subscriptionId !== receipt.subscriptionId || side.baseRevision !== receipt.revision) {
      invalidateBridge('bridge-context-changed', true); return null
    }
    if (expected && !sameBridgeCredential(receipt, expected)) return null
    if (!bridgeValidated) return null
    try { requireBridgeContext(receipt, receipt.ownerId, now()); return receipt }
    catch { invalidateBridge(now() >= receipt.validationExpiresAtMs ? 'bridge-validation-stale' : 'bridge-refresh-required'); return null }
  }
  function validationBinding(): string {
    const login = readLogin(paths), side = readSidecar(paths)
    return JSON.stringify([sessionEpoch(o.session()), login?.sha256 ?? null, side?.userId ?? null, side?.subscriptionId ?? null,
      side?.baseRevision ?? null, side?.sha256 ?? null, bridgeReceipt?.credentialEpoch ?? null])
  }
  function cancelValidation() {
    if (!validation) return
    validation.active = false; clearTimeout(validation.timer); validation.controller.abort(); validation.finish()
    // Keep the single-flight slot until the physical promise settles, even if fetch ignores abort.
  }
  function stopBridgeTimer() { if (bridgeTimer) clearInterval(bridgeTimer); bridgeTimer = null; cancelValidation() }
  function protectBridge(id: string) {
    if (closed || !/^bridge-[a-f0-9-]{36}$/.test(id)) throw bridgeCredentialError('bridge-lease-invalid')
    bridgeConsumers.add(id); leases.add(id)
    if (!bridgeTimer && o.timers !== false) {
      bridgeTimer = setInterval(() => { void validateBridge() }, BRIDGE_VALIDATION_CADENCE_MS)
      bridgeTimer.unref()
    }
  }
  async function validateBridge(): Promise<void> {
    const envelope = await serial(async () => {
      if (closed || bridgeConsumers.size === 0) return { done: Promise.resolve() }
      if (validation) return { done: validation.done }
      const s = o.session(), at = now()
      if (at < validationNotBefore) return { done: Promise.resolve() }
      if (!s || changed()) { invalidateBridge('bridge-credential-unavailable'); return { done: Promise.resolve() } }
      validationNotBefore = at + BRIDGE_VALIDATION_CADENCE_MS
      const captured = validationBinding(), controller = new AbortController()
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const flight: Validation = { active: true, controller, done, finish, timer: setTimeout(() => {
        if (validation !== flight || !flight.active) return
        flight.active = false; controller.abort(); invalidateBridge('bridge-validation-stale'); finish()
      }, BRIDGE_VALIDATION_TIMEOUT_MS) }
      flight.timer.unref(); validation = flight
      // Initiate the EXISTING CRM read here; network completion does not hold this queue.
      let response: Promise<CodexCredential>
      try { response = Promise.resolve(crm.credential(s, build, controller.signal)) } catch { response = Promise.reject(new Error('validation unavailable')) }
      void response.then(r => serial(async () => {
        if (closed || validation !== flight || !flight.active || controller.signal.aborted || bridgeConsumers.size === 0) return
        if (captured !== validationBinding()) return // An older response cannot replace/revoke a newer manager context.
        if (now() < at || now() - at >= BRIDGE_VALIDATION_TIMEOUT_MS) {
          invalidateBridge('bridge-validation-stale'); return
        }
        if (r.kind !== 'ok' || r.login.kind !== 'chatgpt') { invalidateBridge('bridge-credential-unavailable', true); return }
        // Normal manager ordering owns replacement. Never apply a stale response over a pending native refresh.
        await pull({ session: s, at, result: r })
      })).catch(() => { if (validation === flight && flight.active) invalidateBridge('bridge-credential-unavailable') }).finally(() => {
        clearTimeout(flight.timer); flight.active = false; finish()
        if (validation === flight) validation = null
      })
      return { done }
    })
    await envelope.done
  }

  const bridgeCredentials: ManagedBridgeSource = {
    protect: protectBridge,
    async retain(id, ownerId) {
      const found = await serial(async () => {
        protectBridge(id)
        if (o.session()?.user.id !== ownerId) throw bridgeCredentialError('bridge-context-changed')
        return { context: currentBridge() }
      })
      if (!found.context) await validateBridge()
      return serial(async () => {
        if (!bridgeConsumers.has(id)) throw bridgeCredentialError('bridge-lease-invalid')
        const context = currentBridge()
        if (!context) throw bridgeCredentialError(bridgeFailure)
        if (context.ownerId !== ownerId) throw bridgeCredentialError('bridge-context-changed')
        return context
      })
    },
    current: (id, expected) => bridgeConsumers.has(id) ? currentBridge(expected) : null,
    async use(id, expected, send, signal) {
      const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      let invoked = false
      try {
        const envelope = await serial(async () => {
          if (combined.aborted) throw bridgeCredentialError('bridge-cancelled')
          const context = bridgeConsumers.has(id) ? currentBridge(expected) : null
          if (!context) throw bridgeCredentialError('bridge-context-changed')
          const login = readLogin(paths), auth = login ? authorization(login.text, context.revision) : null
          if (!auth || login!.sha256 !== context.contentHash || !currentBridge(context)) throw bridgeCredentialError('bridge-context-changed')
          const flights = bridgeFlights.get(id) ?? new Set<AbortController>(); flights.add(controller); bridgeFlights.set(id, flights)
          const guarded: BridgeRequestAuthorization = Object.freeze({
            get accessToken() { if (combined.aborted || !currentBridge(context)) throw bridgeCredentialError('bridge-context-changed'); return auth.accessToken },
            get accountId() { if (combined.aborted || !currentBridge(context)) throw bridgeCredentialError('bridge-context-changed'); return auth.accountId },
            get expiresAtMs() { if (combined.aborted || !currentBridge(context)) throw bridgeCredentialError('bridge-context-changed'); return auth.expiresAtMs },
            get credentialRevision() { if (combined.aborted || !currentBridge(context)) throw bridgeCredentialError('bridge-context-changed'); return auth.credentialRevision },
          })
          invoked = true
          return { result: send(guarded, combined) }
        })
        const result = await envelope.result
        if (combined.aborted || !bridgeConsumers.has(id) || !currentBridge(expected)) throw bridgeCredentialError('bridge-dispatch-unknown')
        return result
      } catch (error) {
        if (invoked) throw bridgeCredentialError('bridge-dispatch-unknown')
        throw error
      } finally {
        const flights = bridgeFlights.get(id); flights?.delete(controller); if (flights?.size === 0) bridgeFlights.delete(id)
      }
    },
    release: (id, guard) => serial(async () => {
      guard?.()
      if (bridgeFlights.get(id)?.size) throw bridgeCredentialError('bridge-owner-busy')
      if (!bridgeConsumers.delete(id)) return
      leases.delete(id)
      if (bridgeConsumers.size === 0) stopBridgeTimer()
      if (leases.size === 0) { await settleNow(); tidy() }
      o.onChange()
    }),
    validate: validateBridge,
  }

  const iso = () => new Date(now()).toISOString()
  const set = (outcome: Outcome | 'ok', hint: string | null = null) => {
    if (outcome !== 'ok') invalidateBridge('bridge-credential-unavailable')
    if (lastOutcome === outcome && outcomeHint === hint) return
    lastOutcome = outcome
    outcomeHint = hint
    o.onChange()
  }

  function status(): CodexStatus {
    const install = o.find()
    const signedIn = o.session() !== null
    let state: CodexState
    let hint: string | null
    if (!install) {
      state = 'not-installed'
      hint = "The Codex CLI isn't installed on this PC."
    } else if (!signedIn && !waiting) {
      state = 'sign-in-needed'
      hint = 'Sign in to the CRM first: Codex uses the Codex subscription the CRM gives you.'
    } else {
      state = lastOutcome ?? 'ok'
      hint = lastOutcome && lastOutcome !== 'ok' ? outcomeHint : null
    }
    return {
      enabled: true,
      installed: !!install,
      version: install?.version ?? null,
      state,
      hint,
      assigned,
      lastFetchedAt,
      lastWrittenBackAt,
      waitingToWriteBack: waiting,
    }
  }

  /** The changed-file test: the hash of what is on disk against the sidecar's. */
  function changed(): boolean {
    const login = readLogin(paths)
    const side = readSidecar(paths)
    return !!login && (!side || login.sha256 !== side.sha256)
  }

  // ── fetching ───────────────────────────────────────────────────────────────────────────────

  /** Asks the CRM for the person's login. Never overwrites a changed file (settle first). */
  async function pull(checked?: { session: CrmSession; at: number; result: CodexCredential }): Promise<{ kind: 'ok'; revision: number; replaced: boolean } | { kind: 'none' | 'expired' | 'offline' | 'error' }> {
    const s = checked?.session ?? o.session(), at = checked?.at ?? now()
    if (!s) {
      set('sign-in-needed', 'Sign in to the CRM first: Codex uses the Codex subscription the CRM gives you.')
      return { kind: 'expired' }
    }
    let r: CodexCredential
    try {
      r = checked ? checked.result : await crm.credential(s, build)
    } catch (e) {
      if (e instanceof CrmError && e.status === null) {
        set('crm-offline', "The CRM can't be reached right now.")
        return { kind: 'offline' }
      }
      log.warn(`F-134: the CRM wouldn't give the Codex subscription: ${message(e)}`)
      set('error', message(e))
      return { kind: 'error' }
    }
    if (r.kind === 'expired') {
      invalidateBridge('bridge-credential-unavailable', true)
      set('sign-in-needed', 'The CRM ended your session: sign in to it again.')
      return { kind: 'expired' }
    }
    if (r.kind === 'none') {
      invalidateBridge('bridge-credential-unavailable', true)
      assigned = null
      key = null
      set(r.state, r.message)
      return { kind: 'none' }
    }
    const login = r.login
    if (login.kind === 'api_key') {
      const replaced = takeKey(login, s.user.id)
      return { kind: 'ok', revision: login.revision, replaced }
    }
    const hadKey = key !== null
    key = null
    lastFetchedAt = iso()
    assigned = { name: login.subscription.name, kind: login.kind, revision: login.revision }
    set('ok')
    if (changed()) { invalidateBridge('bridge-credential-unavailable', true); return { kind: 'ok', revision: login.revision, replaced: false } }
    const side = readSidecar(paths)
    const there = hasLogin(paths)
    const same = there && side && side.subscriptionId === login.subscription.id && side.userId === s.user.id && side.baseRevision === login.revision
    if (same) {
      recordBridge(s, login.subscription.id, login.revision, createHash('sha256').update(login.authJson).digest('hex'), at)
      return { kind: 'ok', revision: login.revision, replaced: false }
    }
    const hadOlder = there && !!side
    placeLogin(paths, login.authJson, { subscriptionId: login.subscription.id, userId: s.user.id, revision: login.revision }, new Date(now()))
    recordBridge(s, login.subscription.id, login.revision, createHash('sha256').update(login.authJson).digest('hex'), at)
    log.info(`F-134: Codex login for subscription "${login.subscription.name}" in place (revision ${login.revision})`)
    if ((hadOlder || hadKey) && leases.size > 0) o.onNewerLogin()
    return { kind: 'ok', revision: login.revision, replaced: true }
  }

  /**
   * F-138: the CRM's credential is an API key. It is kept in memory; a login FILE of the earlier kind (the CRM's own copy, or one Codex changed, which can no longer be put
   * back to a subscription that is a key now) is taken out so Codex has one credential only. Chats that hold an older key (or the file) are restarted. True when it changed.
   */
  function takeKey(login: Extract<crmApi.CodexLogin, { kind: 'api_key' }>, userId: string): boolean {
    invalidateBridge('bridge-credential-unavailable', true)
    const before = key
    const hadFile = hasLogin(paths) || readSidecar(paths) !== null
    if (hadFile && changed()) log.warn("F-138: a login Codex refreshed for an earlier subscription can't go back (this person's subscription is an API key now); it is taken out")
    key = { value: login.apiKey, subscriptionId: login.subscription.id, revision: login.revision }
    lastFetchedAt = iso()
    assigned = { name: login.subscription.name, kind: 'api_key', revision: login.revision }
    set('ok')
    if (hadFile) removeLogin(paths)
    waiting = false
    const newer = (before !== null && before.value !== login.apiKey) || (before === null && hadFile)
    if (before === null || newer) log.info(`F-138: Codex API key of subscription "${login.subscription.name}" in use (revision ${login.revision}, for ${userId.slice(0, 8)})`)
    if (newer && leases.size > 0) o.onNewerLogin()
    return newer
  }

  // ── putting a changed file back ─────────────────────────────────────────────────────────

  async function settleNow(): Promise<SettleResult> {
    const login = readLogin(paths)
    if (!login) {
      invalidateBridge('bridge-credential-unavailable', true)
      waiting = false
      return 'none'
    }
    const side = readSidecar(paths)
    if (side && login.sha256 === side.sha256) {
      waiting = false
      return 'none'
    }
    invalidateBridge('bridge-credential-unavailable', true)
    if (!side) {
      // A login file with no sidecar: its origin is unknown, so it can't be put back safely. The CRM's copy replaces it when there is one.
      const got = await pull0()
      return got ? 'rejected' : 'waiting'
    }
    const s = o.session()
    if (!s || s.user.id !== side.userId) {
      waiting = true
      set('sign-in-needed', 'A refreshed Codex login is waiting to reach the CRM: sign in to the CRM as the person it belongs to.')
      return 'waiting'
    }
    let r: WriteBack
    const at = now()
    try {
      r = await crm.writeBack(s, build, { baseRevision: side.baseRevision, authJson: login.text })
    } catch (e) {
      waiting = true
      log.warn(`F-134: the refreshed Codex login couldn't be put back yet (kept on this PC, tried again in a few minutes): ${message(e)}`)
      set('crm-offline', "The CRM can't be reached right now; the refreshed Codex login waits on this PC and is put back as soon as it can.")
      return 'waiting'
    }
    switch (r.kind) {
      case 'ok':
        writeSidecar(paths, { ...side, baseRevision: r.revision, sha256: login.sha256 })
        waiting = false
        lastWrittenBackAt = iso()
        if (assigned) assigned = { ...assigned, revision: r.revision }
        recordBridge(s, side.subscriptionId, r.revision, login.sha256, at)
        log.info(`F-134: the refreshed Codex login is with the CRM (revision ${side.baseRevision} -> ${r.revision})`)
        o.onChange()
        return 'accepted'
      case 'conflict': {
        log.warn(`F-134: the CRM already has a newer Codex login (its revision ${r.revision ?? '?'}, ours was based on ${side.baseRevision}): taking theirs`)
        const got = await pull0()
        if (!got) {
          waiting = true
          return 'waiting'
        }
        waiting = false
        if (leases.size > 0) o.onNewerLogin()
        return 'conflict'
      }
      case 'rejected': {
        log.warn(`F-134: the CRM will not take this PC's Codex login (${r.code ?? r.status}): taking the CRM's own`)
        const got = await pull0()
        if (!got) {
          waiting = true
          return 'waiting'
        }
        waiting = false
        set('sign-in-needed', r.message)
        if (leases.size > 0) o.onNewerLogin()
        return 'rejected'
      }
      case 'expired':
        waiting = true
        set('sign-in-needed', 'The CRM ended your session: sign in to it again. A refreshed Codex login waits on this PC until you do.')
        return 'waiting'
      case 'later':
        waiting = true
        log.warn(`F-134: the CRM can't take the refreshed Codex login now (${r.status}); kept on this PC, tried again in a few minutes`)
        set('crm-offline', "The CRM can't take the refreshed Codex login right now; it waits on this PC and is put back as soon as it can.")
        return 'waiting'
    }
  }

  /** Replaces the local login with the CRM's copy; true when that worked (so the older file may go). A changed file is overwritten here ON PURPOSE (its refresh token is dead). */
  async function pull0(): Promise<boolean> {
    const s = o.session()
    const at = now()
    if (!s) return false
    let r: CodexCredential
    try {
      r = await crm.credential(s, build)
    } catch {
      return false
    }
    if (r.kind !== 'ok') return false
    if (r.login.kind === 'api_key') {
      // The subscription is a key now: a login file of the earlier kind has no place to go back to, and the key replaces it.
      takeKey(r.login, s.user.id)
      return true
    }
    key = null
    lastFetchedAt = iso()
    assigned = { name: r.login.subscription.name, kind: r.login.kind, revision: r.login.revision }
    placeLogin(paths, r.login.authJson, { subscriptionId: r.login.subscription.id, userId: s.user.id, revision: r.login.revision }, new Date(now()))
    recordBridge(s, r.login.subscription.id, r.login.revision, createHash('sha256').update(r.login.authJson).digest('hex'), at)
    return true
  }

  /** Takes the file out when nothing runs and nothing waits. */
  function tidy() {
    if (leases.size === 0 && hasLogin(paths) && !changed()) { removeLogin(paths); invalidateBridge('bridge-credential-unavailable', true) }
  }

  // ── what the rest of the app calls ──────────────────────────────────────────────────────

  const timers: NodeJS.Timeout[] = []
  if (o.timers !== false) {
    const every = (fn: () => Promise<unknown>, ms: number) => {
      const t = setInterval(() => {
        if (!closed) void fn().catch(e => log.warn(`F-134: ${message(e)}`))
      }, ms)
      t.unref()
      timers.push(t)
    }
    every(() => (leases.size > 0 ? api.watch() : Promise.resolve()), WATCH_EVERY_MS)
    every(async () => {
      if (waiting) await api.settle().then(() => tidy())
    }, RETRY_EVERY_MS)
    every(() => api.check(), CHECK_EVERY_MS)
  }

  const api: CodexManager = {
    paths,
    bridgeCredentials,
    bin: () => o.find()?.path ?? null,
    status,
    credentialEnv: () => (key ? { name: API_KEY_VAR, value: key.value } : null),
    running: () => leases.size,

    acquire: sessionId =>
      serial(async () => {
        if (!o.find()) throw codexError(503, 'not-installed', "The Codex CLI isn't installed on this PC.")
        writeBase(paths)
        if (changed()) {
          // A login Codex refreshed: the newest there is. Try to hand it to the CRM; a chat starts on it either way.
          await settleNow()
          if (changed() && !readSidecar(paths)) throw codexError(503, 'error', "A Codex login on this PC can't be checked against the CRM yet.")
        } else {
          const got = await pull()
          if (got.kind === 'expired') throw codexError(409, 'sign-in-needed', status().hint ?? 'Sign in to the CRM first.')
          if (got.kind === 'none') throw codexError(409, (lastOutcome === 'ok' ? 'no-subscription' : lastOutcome) as CodexState, outcomeHint ?? 'The CRM has no Codex subscription for you.')
          if (got.kind === 'error') throw codexError(503, 'error', outcomeHint ?? "The CRM couldn't give the Codex subscription.")
          if (got.kind === 'offline' && !hasLogin(paths) && !key) throw codexError(503, 'crm-offline', "The CRM can't be reached, so Codex has no login to start with.")
          // Offline with an unchanged login already here: it is the one fetched last, and it is used.
        }
        leases.add(sessionId)
        o.onChange()
      }),

    adopt(sessionId) {
      leases.add(sessionId)
      o.onChange()
    },

    release: sessionId =>
      serial(async () => {
        if (!leases.delete(sessionId)) return
        if (leases.size === 0) {
          await settleNow()
          tidy()
        }
        o.onChange()
      }),

    check: () =>
      serial(async () => {
        if (!o.find()) return status()
        if (changed()) await settleNow()
        else await pull()
        tidy()
        return status()
      }),

    settle: () =>
      serial(async () => {
        const r = await settleNow()
        if (r !== 'waiting') tidy()
        return r
      }),

    sweep: () =>
      serial(async () => {
        writeBase(paths)
        if (hasLogin(paths) || readSidecar(paths)) {
          await settleNow()
          tidy()
          if (!hasLogin(paths) && readSidecar(paths)) removeLogin(paths)
        }
      }),

    watch: () =>
      serial(async () => {
        if (leases.size > 0 && changed()) await settleNow()
      }),

    close() {
      closed = true
      stopBridgeTimer()
      invalidateBridge('bridge-credential-unavailable', true)
      key = null
      for (const t of timers) clearInterval(t)
    },
  }
  return api
}
