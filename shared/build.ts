// F-020: the Shubham Agentic build. Dev (shubham-agentic-dev, on the hub) is the source; a
// build is what Publish makes of it, pushed to the build repo on GitHub; every PC runs a build,
// a clone of that repo started by its Start.cmd. Types only, shared by the agent (agent/build.ts)
// and the Build page, at `${AGENT_API_PREFIX}/build/...`.

export const BUILD_REPO = 'https://github.com/bztechserver-droid/shubham-agentic-build.git'

/** The agent exits with this when asked to update; Start.cmd then pulls the new build and starts it again. */
export const UPDATE_EXIT_CODE = 75

/** A build's RELEASE.json. */
export interface BuildVersion {
  /** "2026.10.31-1305": when it was built, to the minute. */
  version: string
  /** Dev's commit it was built from (short), and whether Dev had changes not committed. */
  commit: string | null
  dirty: boolean
  builtAt: string
  /** F-026: a fingerprint of Dev's files it was built from (its commit, its changes, its new files); null for builds from before. */
  devHash: string | null
  /** F-075: the chat host this build ships (its wire protocol and code version); absent in builds from before it. */
  chatHost?: { protocol: number; version: number } | null
  /** F-126: SHA-256 of the CRM drive host (crm-fs/crm-fs.exe) this build ships; absent when the publishing PC could not build it. The agent checks the exe against it before starting it. */
  crmFsSha256?: string
}

export type UpdateState = 'unknown' | 'checking' | 'up-to-date' | 'available' | 'failed'
export type PublishState = 'idle' | 'running' | 'done' | 'failed'

export interface BuildInfo {
  /** 'build': this agent runs from a build (RELEASE.json beside it); 'dev': from Dev's source. */
  kind: 'build' | 'dev'
  /** The folder it runs from. */
  root: string
  /** The build this is; null for Dev. */
  current: BuildVersion | null
  update: {
    state: UpdateState
    /** The newer build on GitHub, when there is one. */
    available: BuildVersion | null
    checkedAt: string | null
    error: string | null
    /** It can update itself: a build, a clone of the build repo, started by Start.cmd. When not, why. */
    can: boolean
    cannot: string | null
    /**
     * F-075: Update was pressed and the chat host changes with it, so it waits for the chats to be idle (10 minutes), then
     * asks (`ask`): the chats are restarted and resumed if it is confirmed (POST /update {force: true}). Null: not waiting.
     */
    hostWait?: { since: string; busy: number; ask: boolean } | null
  }
  /** F-119: whether THIS browser may press Publish (signed in as sbskrrt). Only GET /build/info sets it; the pushed state does not carry it. */
  mayPublish?: boolean
  /** Publishing, on the hub that has Dev; null elsewhere. */
  publish: {
    devDir: string
    /** Dev's commit now (short) and how many files it has changed but not committed. */
    devCommit: string | null
    devChanges: number
    /**
     * F-026: whether Dev has anything the newest build hasn't: false hides Publish. Null when it
     * can't be told (a build from before the fingerprint, or Dev not read yet).
     */
    pending: boolean | null
    /** The newest build, that `pending` is against. */
    newest: string | null
    state: PublishState
    startedAt: string | null
    endedAt: string | null
    /** The publish's own lines, the last few hundred. */
    log: string[]
    /** What the last publish that worked published. */
    published: BuildVersion | null
    error: string | null
  } | null
}

/** POST /build/publish */
export interface PublishRequest {
  /** Skip the type-check, lint and tests (a minute or two) for a quick rebuild. */
  skipChecks?: boolean
}
