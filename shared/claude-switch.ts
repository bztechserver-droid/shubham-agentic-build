// Claude subscription failover and the manual switch: the shapes the agent and the page share.
//
// The CRM assigns each person a Claude subscription; the app runs every chat on its token. When
// that subscription's weekly limit is used up the app moves the signed-in person to the other one
// in the CRM and carries on (automatic), and the person can do the same from the page (manual).
// Nothing here is a secret: a subscription is its id, its name and the last four characters of its
// token. Texts are the user's: plain, no jargon (agent/SPEC.md › Claude subscription failover).

/** One of the office's Claude subscriptions, as the app names it. */
export interface SwitchSubscription {
  id: string
  /** The CRM's name for it: "Office 2(Jagtap)", "Office 1". */
  name: string
  /** The last four characters of its token (the CRM's tokenHint), or null. */
  hint: string | null
}

/** The subscription's own weekly reading (Claude's, as Christopher builds report it to the CRM). */
export interface SwitchWeek {
  /** How much of the week everyone on it has used, 0-100, or null without a reading. */
  percent: number | null
  /** When the week ends (ISO). */
  resetsAt: string | null
  /** When the CRM last had news of it (ISO). Old: the percent may be higher by now. */
  observedAt: string | null
  stale: boolean
}

/**
 * The person's weekly cap on a subscription: how much of ITS week the CRM lets them use before it
 * stops handing them the token. The CRM only tells the cap on the subscription they are ON, so
 * for the other one this is what the app last saw there, or else its default.
 */
export interface SwitchCap {
  percent: number
  /** 'person': set for them in the CRM. 'default': the subscription's own default, for everyone without one. */
  source: 'person' | 'default'
  /** Where the number comes from: the CRM just now (they are on it), the last time the app saw them on it, or only the subscription's default (a cap of their own may exist, unreadable until they are on it). */
  known: 'now' | 'seen' | 'default'
  /** Their share of that subscription's week used, or null. */
  usedPercent: number | null
  /** Used up: the CRM refuses them the token there. */
  over: boolean
  /** When the app read it (ISO). */
  at: string | null
}

export interface SwitchChoice extends SwitchSubscription {
  /** The person runs on it now. */
  active: boolean
  /** The CRM turned it off: it refuses to put anyone on it. */
  disabled: boolean
  week: SwitchWeek | null
  cap: SwitchCap | null
}

export type SwitchBy =
  /** The app moved them because the weekly limit was used up. */
  | 'auto'
  /** They chose it on the page. */
  | 'manual'

/** One switch, as the log keeps and shows it. No token anywhere in it. */
export interface SwitchRecord {
  at: string
  by: SwitchBy
  from: SwitchSubscription
  to: SwitchSubscription
  /** In a sentence: why it happened, and what told the app. */
  why: string
  /** Names of the chats that were restarted on the new subscription. */
  restarted: string[]
  /** What the person was warned of beforehand and went ahead with (a lower cap there, say). */
  warnings: string[]
}

/** What the app is doing about limits right now. */
export interface SwitchWatch {
  state:
    /** Automatic switching is turned off. */
    | 'off'
    | 'watching'
    /** A chat reported a limit and the app is not switching on it (yet): `message` says why. `offer` is set when switching by hand would help. */
    | 'suspected'
    | 'switching'
    /** The app will not switch: both subscriptions are used up, this account may not, or there is nowhere to go. */
    | 'stopped'
  message: string
  /** The chat that reported it. */
  chat?: string
  /** When the limit ends (ISO), as claude said. */
  resetsAt?: string | null
  /** A subscription the person could switch to now to carry on: the page offers "Switch now". */
  offer?: SwitchSubscription
}

export interface ClaudeSwitchInfo {
  /**
   * This account may change its own subscription in the CRM (only the CRM's super admin may).
   * null: not asked yet, or the CRM could not be reached.
   */
  allowed: boolean | null
  /** Why not, in the CRM's words, or null. */
  note: string | null
  /** The office's subscriptions, the active one marked. Empty until read. */
  choices: SwitchChoice[]
  /** The one the person runs on, and since when the app has had them on it (the last switch it made; null: it never switched them). */
  current: (SwitchSubscription & { since: string | null; by: SwitchBy | null }) | null
  /** Newest first. */
  log: SwitchRecord[]
  /** Switch automatically when the weekly limit is used up. */
  auto: boolean
  watch: SwitchWatch
  /** When the subscriptions were last read from the CRM (ISO). */
  readAt: string | null
}

/** A chat that a switch would restart. */
export interface ChatImpact {
  id: string
  name: string
  floor: string | null
  /** 'working': a turn is running now, and a restart interrupts it. */
  state: 'idle' | 'working' | 'asking'
  /** Its latest message is claude's "you've hit your limit". */
  hitLimit: boolean
  /** The page ticks it by default: it hit the limit, or it is idle. A working chat is left to the person. */
  restartByDefault: boolean
}

export interface SwitchWarning {
  code: 'same' | 'disabled' | 'target-used-up' | 'cap-over' | 'low-cap' | 'cap-unknown' | 'stale-reading' | 'not-allowed'
  /** 'block': the switch cannot be made. 'warn': it can, and the person is told first. */
  severity: 'block' | 'warn'
  message: string
}

/** What a switch to `to` would do, before anything changes (POST /claude/switch/preview). */
export interface SwitchPreview {
  from: SwitchSubscription
  to: SwitchSubscription
  /** false while any warning blocks. */
  allowed: boolean
  warnings: SwitchWarning[]
  /** The running chats that hold the current subscription's token. */
  chats: ChatImpact[]
  week: { from: SwitchWeek | null; to: SwitchWeek | null }
  cap: { from: SwitchCap | null; to: SwitchCap | null }
}

/** POST /claude/switch: the person asked for it, and chose which chats to restart. */
export interface SwitchRequest {
  /** The subscription's id. */
  to: string
  /** Chat ids to restart on the new subscription, and tell to carry on. */
  restart: string[]
}

/** POST /claude/switch/auto */
export interface SwitchAutoRequest {
  on: boolean
}

/** POST /claude/switch/refresh: read the subscriptions from the CRM again (and with `readings`, each one's week). */
export interface SwitchRefreshRequest {
  readings?: boolean
}

/**
 * The answer to POST /claude/switch. Not an HTTP error when the switch could not be made (the CRM
 * said no, nothing to switch to): `ok` is false and `message` says why in plain words. The page
 * gets the new state from the next push, as with every other action.
 */
export interface SwitchResponse {
  ok: boolean
  message: string
  /** Names of the chats restarted on the new subscription and told to carry on. */
  restarted: string[]
  /** Names of the chats that could not be restarted. */
  failed: string[]
}
