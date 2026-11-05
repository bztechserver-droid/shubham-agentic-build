// The contract between the device agent (agent/, Node) and the app (src/, browser).
// Types only, so both sides can import it. The agent serves it on 127.0.0.1 (see
// agent/SPEC.md › Local API); the app reaches it through Vite's proxy at AGENT_API_PREFIX.

import type { ClaudeSwitchInfo } from './claude-switch.ts'

export const AGENT_API_PREFIX = '/agent-api'

/** The hub runs the RustDesk servers (hbbs/hbbr) and approves new PCs; members join it. */
export type Role = 'hub' | 'member'

/** Where a device is, as far as this PC can prove it. */
export type Location =
  | 'same-network' // a pinned TLS link whose far end is a private address in one of our LAN subnets
  | 'internet' // a link through the hub's relay at its public address, or over Tailscale
  | 'connecting' // a check or connection attempt is running and nothing is proven yet
  | 'offline' // the hub says it is not registered, or it was never seen
  | 'unreachable' // every path failed; `evidence` says why

/** How the bytes travel right now. Kept apart from Location (DESIGN: "where" vs "how"). */
export type LinkPath =
  | 'lan-direct' // our own probe: TLS straight to the peer's LAN address
  | 'hub-lan' // hbbs answered with the peer's LAN address (FetchLocalAddr) and TLS went straight to it
  | 'relay-lan' // through hbbr, reached at a LAN address: the hub on this network
  | 'relay-internet' // through hbbr at the hub's public address
  | 'tailscale' // TLS straight to the peer's Tailscale address (100.64.0.0/10)

/**
 * How a member picks its path to the hub (the Devices page's "How to connect"). The hub
 * listens on every way at once; members choose.
 *   auto:      same network first, then Tailscale, then the RustDesk servers (hbbs, hbbr)
 *   tailscale: Tailscale only
 *   rustdesk:  the RustDesk way only: same network, then hbbs, then hbbr
 *   relay:     hbbr only (testing the relay at home)
 */
export type Route = 'auto' | 'tailscale' | 'rustdesk' | 'relay'

export interface SelfInfo {
  /** base32(sha256(SPKI)), 16 characters, lowercase. Also the device's hbbs ID. */
  id: string
  name: string
  role: Role
  /** This PC's physical LAN IPv4, e.g. "192.168.1.118", or null when it has none. */
  lanAddress: string | null
  /** CIDR of that LAN, e.g. "192.168.1.0/24". */
  lanSubnet: string | null
  /** This PC's Tailscale IPv4, e.g. "100.65.101.123", or null when Tailscale isn't up here. */
  tailnetAddress: string | null
  /**
   * This PC's own name on the tailnet, e.g. "server.tail36192f.ts.net" (no trailing dot): what a page shows as the address to open on a phone, instead of a name typed
   * in the code (it changes with the tailnet). Null while unknown or when Tailscale isn't up. Optional so older agents and mocks need no change.
   */
  tailnetName?: string | null
  /** The installed RustDesk's ID (`RustDesk.exe --get-id`), or null when not installed. */
  rustdeskId: string | null
  version: string
  /** Hub: always true. Member: true once it has joined a hub. */
  paired: boolean
  /**
   * F-014: this PC's own screen, for its own page opened on another device (the phone, through
   * the remote gate), which controls it through this PC's agent with no link. True when the
   * RustDesk installed here answers on its direct-access port. Absent from an agent before F-014.
   */
  canOpenScreen?: boolean
  /** F-014: the same, through the app's own screen here (F-006), when that is ready. */
  canOpenAppScreen?: boolean
  /** F-014: the ways in whose password this PC's agent remembers for itself (Remember me on its own page). */
  savedPassword?: ScreenVia[]
}

export interface ServerStatus {
  name: 'hbbs' | 'hbbr'
  state: 'missing' | 'stopped' | 'starting' | 'running' | 'crashed'
  pid: number | null
  ports: number[]
  since: string | null
  restarts: number
  lastError: string | null
}

export interface DeviceInfo {
  id: string
  name: string
  role: Role
  location: Location
  path: LinkPath | null
  /** Round trip of the app's own ping over the current link. */
  rttMs: number | null
  /** The far end of the current link, e.g. "192.168.1.122:21220" or "61.246.245.66:21217". */
  address: string | null
  connectedSince: string | null
  lastSeen: string | null
  /** Plain sentences, newest last: how the location and path were decided, or why it failed. */
  evidence: string[]
  /** True when a link is up and the hub side can reach RustDesk's direct-access port. */
  canOpenScreen: boolean
  /** True when a link is up and that PC's own screen through the app is ready (F-006, no RustDesk needed). */
  canOpenAppScreen: boolean
  /** F-008: the ways in whose password this PC remembers for that PC (Remember me). Absent: none. */
  savedPassword?: ScreenVia[]
  /** F-110: on a member's row for its hub only; absent on every other row (the hub's rows for its members, a PC without a hub). */
  tailnet?: TailnetCompare
}

/** F-110: which tailnet each end of a link is on, so the page can say when this PC and the hub are on different ones. */
export interface TailnetCompare {
  /** This PC's tailnet name suffix ("tail36192f.ts.net"), or null when Tailscale is not running here or does not say. */
  mine: string | null
  /** The hub's tailnet name suffix as the hub last said it, or null when unknown (the hub is not on Tailscale, or never told its name). */
  theirs: string | null
  /** 'different' only when BOTH are known and differ; 'same' when both are known and equal; 'unknown' whenever either is null. */
  state: 'same' | 'different' | 'unknown'
  /** True when the hub said it on the link that is up now; false = its last known tailnet (the link is down). */
  fresh: boolean
  /** One plain sentence for the badge, set only when state is 'different'; null otherwise. */
  message: string | null
}

/**
 * Which way the viewer reaches another PC's screen (F-006): 'app', the app's own screen on that
 * PC (no RustDesk on either side); 'rustdesk', the RustDesk installed there (F-005).
 */
export type ScreenVia = 'app' | 'rustdesk'

/** F-006: this PC's own screen, for other PCs' viewers. */
export interface AppScreenInfo {
  /** Paired PCs can open this PC's screen through the app. */
  ready: boolean
  /** Why not, in a phrase ("FFmpeg isn't set up on this PC yet"), or null when ready. */
  reason: string | null
  /** The FFmpeg in use ("9.0.2"), or null. */
  ffmpeg: string | null
  /** A control password is set here. Without one, only "ask someone at this PC to accept" logs in. */
  passwordSet: boolean
  /** Fetching FFmpeg from the Devices page: under way (0..1), or the last failure. */
  setup: { state: 'downloading'; progress: number } | { state: 'failed'; error: string } | null
  /** Who is controlling this PC through the app right now. */
  sessions: { deviceId: string; name: string; since: string }[]
  /**
   * For "Stay reachable for Control": on mains power now (null: Windows can't tell), whether the
   * app is keeping this PC awake now (reachable on mains, or being controlled), and what the power
   * button and the lid do while plugged in, in Windows' numbers (0 nothing, 1 sleep, 2 hibernate,
   * 3 shut down, 4 turn the display off; null when unknown). "Stay reachable" sets 0 and 0.
   */
  power: { onMains: boolean | null; awake: boolean; buttons: { power: number; lid: number } | null }
}

/**
 * F-013: a key this PC's agent took for the Control page (Alt+Tab, the Windows key and the rest a
 * browser never gets), as KeyboardEvent.code, with the modifiers held.
 */
export interface GrabbedKey {
  code: string
  down: boolean
  repeat: boolean
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

/** WS /keys (F-013): what the page hears while this PC's agent takes its keys: first 'grabbing', then each key. */
export type KeysMessage = { t: 'grabbing' } | ({ t: 'key' } & GrabbedKey)

/** POST /screen/password: sets this PC's control password; null removes it. */
export interface ScreenPasswordRequest {
  password: string | null
}

/**
 * F-008, Remember me on Control. This PC's agent keeps another PC's password as RustDesk's own
 * client does, as H1 = SHA256(password ‖ salt), and never hands it out: for each connection it
 * answers that connection's challenge instead.
 *   POST /devices/:id/password/login  {via, salt, challenge} → SavedLoginAnswer
 *   POST /devices/:id/password/save   {via, salt, h1}
 *   POST /devices/:id/password/forget {via?} (no via: both ways)
 */
export interface SavedLoginRequest {
  via: ScreenVia
  salt: string
  challenge: string
}

/** base64 SHA256(H1 ‖ challenge) for this connection; null when none is saved, or the one saved was for another salt (a new password there: it is forgotten). */
export interface SavedLoginAnswer {
  digest: string | null
}

export interface SavePasswordRequest {
  via: ScreenVia
  salt: string
  /** base64 SHA256(password ‖ salt), 32 bytes. */
  h1: string
}

export interface ForgetPasswordRequest {
  via?: ScreenVia
}

/**
 * F-007: Claude on this PC, on the Claude subscription the CRM gives the person signed in here.
 * The agent signs in to the CRM with their own login, keeps only the CRM's 7-day session, and
 * puts their subscription's token in this Windows account's CLAUDE_CODE_OAUTH_TOKEN, which
 * every Claude Code started afterwards runs on (agent/SPEC.md › F-007).
 */
export interface ClaudeInfo {
  /**
   * This Windows account's CLAUDE_CODE_OAUTH_TOKEN, read as the page asks:
   *   set:         it holds the CRM subscription's token the app put there (`subscription`)
   *   taken:       something else set it; it's left alone until the person replaces it
   *   empty:       not set
   *   unsupported: this PC can't set it (only Windows can)
   */
  token: 'set' | 'taken' | 'empty' | 'unsupported'
  /** What the app put there, while `token` is 'set': never the token, only its last four characters. */
  subscription: { id: string; name: string; hint: string; setAt: string } | null
  /** The CRM this PC signs in to: https://crmbe.bhole.co, or SAD_CRM_URL. */
  url: string
  /** Who is signed in to the CRM on this PC, or null. The session ends at `expiresAt` (7 days). */
  crm: { name: string; username: string | null; url: string; signedInAt: string; expiresAt: string } | null
  /** The CRM was last asked at `at`: it gave a subscription, none (`message` says why, in its words), or couldn't be asked. */
  check: { at: string; result: 'ok' | 'none' | 'error'; message: string | null; /** The CRM's own code for a 'none' (WEEKLY_CAP_REACHED, SUBSCRIPTION_DISABLED, ...). */ code?: string | null } | null
  /** Signing in, or asking the CRM, right now. */
  busy: boolean
  /** Claude subscription failover and the manual switch (agent/SPEC.md › Claude subscription failover). Absent from an older agent. */
  switch?: ClaudeSwitchInfo
}

/** POST /claude/sign-in: the person's own CRM username (or email) and password, used once. */
export interface ClaudeSignInRequest {
  login: string
  password: string
}

/** POST /claude/check: asks the CRM again; `replace` takes over a CLAUDE_CODE_OAUTH_TOKEN something else set. */
export interface ClaudeCheckRequest {
  replace?: boolean
}

export interface PairingCode {
  /** 8 characters, Crockford base32, shown as "ABCD-EFGH". */
  code: string
  expiresAt: string
  attemptsLeft: number
  /** Where a new PC should connect, e.g. ["192.168.1.118:21220", "100.65.101.123:21220"]. */
  hubAddresses: string[]
}

export interface PairingRequest {
  requestId: string
  name: string
  deviceId: string
  /** Six-digit check number from the TLS session and both ends' nonces; both screens must show the same one. */
  sas: string
  from: string
  receivedAt: string
  /** Approved on the hub. The PC is stored once its own user has also confirmed the number. */
  approved: boolean
  /** The PC's user said its screen shows the same number. */
  confirmed: boolean
}

export interface JoinState {
  /**
   * 'confirm': both screens show `sas`, and this PC's user must say whether the hub shows the
   * same number (POST /join/confirm). 'waiting-approval': they said yes; the hub must approve.
   */
  status: 'idle' | 'connecting' | 'confirm' | 'waiting-approval' | 'paired' | 'failed'
  hubAddress: string | null
  sas: string | null
  error: string | null
}

export interface DiscoveredHub {
  id: string
  name: string
  address: string
  seenAt: string
  /** More than one address answers for this hub's ID: someone may be pretending to be it. */
  conflict: boolean
}

export interface AgentSettings {
  /** How this PC reaches its hub. Only a member uses it; the hub accepts every way. */
  route: Route
  /**
   * While on mains power, this PC doesn't fall asleep by itself, so other PCs can reach it for
   * Control, which wakes its display. A sleep someone chooses (power button, lid, Start › Sleep)
   * still happens, and then it can't be reached. On by default.
   */
  stayReachable: boolean
}

export interface AgentState {
  self: SelfInfo
  /** Hub only. */
  servers: ServerStatus[] | null
  /** Hub: its members. Member: its hub. */
  devices: DeviceInfo[]
  /** Hub only. */
  pairing: { code: PairingCode | null; requests: PairingRequest[] } | null
  /** Member only. */
  join: JoinState | null
  /** Member only: hubs answering the LAN discovery query. */
  discovered: DiscoveredHub[]
  /** F-112: member only. The hub answered and turned this PC away ("not paired"): the saved pairing is no use and the page should offer Join a hub. Null/absent otherwise. */
  hubRefused?: HubRefusal | null
  /** F-113: member only. The address typed by hand for the saved hub and how the last try of it went. Null when this PC has no hub. */
  hubAddress?: HubAddressInfo | null
  settings: AgentSettings
  /** F-006: this PC's own screen for other PCs. */
  appScreen: AppScreenInfo
  /** F-007: Claude on this PC, on the CRM's subscription. */
  claude: ClaudeInfo
  updatedAt: string
}

/** F-112: the hub this PC has saved answered, and it does not know this PC any more (removed there, or never paired there). */
export interface HubRefusal {
  hubId: string
  hubName: string
  /** 'ip:port' the hub answered from (a relay's address is never put here), ready to be the address in Join a hub. */
  address: string
  /** The hub's own words, e.g. "this PC is not paired with the hub". */
  reason: string
  /** ISO time of the first refusal in this run of refusals. */
  since: string
}

/** F-113: the hub's address typed by hand, and what happened when it was tried (the pin is still checked, so a wrong address is refused, never taken for the hub). */
export interface HubAddressInfo {
  /** 'host:port' saved by hand, or null when none is. */
  address: string | null
  /**
   * 'checking': an attempt is running; 'accepted': the hub answered at it and let this PC in; 'refused': the hub answered and does not know this PC (see hubRefused: pair again);
   * 'wrong-pc': something answered but it is not the saved hub (its ID or key differs); 'no-answer': nothing answered there. Null: none saved, or not tried yet.
   */
  result: 'checking' | 'accepted' | 'refused' | 'wrong-pc' | 'no-answer' | null
  /** One plain sentence about the result, or null. */
  detail: string | null
  /** ISO time of the last result, or null. */
  at: string | null
}

/** F-113: POST /hub/address on a member. `address` is 'host:port' (IPv4 or a name; the port may be left out, then the hub's port is used); '' clears it. `hubId` must be the saved hub. */
export interface SetHubAddressRequest {
  hubId: string
  address: string
}

/** F-113: the answer. `address` is what was saved ('host:port'), or null when cleared. It connects at once; the outcome comes in the state's `hubAddress`. */
export interface SetHubAddressResult {
  ok: true
  address: string | null
}

/** F-112: POST /hub/forget on a member: unpair from the saved hub (`hubId` must be the saved one). */
export interface ForgetHubRequest {
  hubId: string
}

/** F-112: the answer. `forgot` is null when this PC had no hub saved (nothing to do). */
export interface ForgetHubResult {
  ok: true
  forgot: { id: string; name: string } | null
}

/** Every response that is not 2xx carries this body. */
export interface ApiError {
  error: string
}

/** Pushed on the WebSocket at `${AGENT_API_PREFIX}/ws` on connect and after every change. */
export type AgentEvent = { type: 'state'; state: AgentState }

export interface JoinRequest {
  hubAddress: string
  code: string
  /** The hub's ID when it was picked from `discovered`: any other PC at that address is refused. */
  hubId?: string
}

/** This PC's user compared the check numbers: `match` says whether the hub shows the same one. */
export interface JoinConfirm {
  match: boolean
}

export type SettingsPatch = Partial<AgentSettings>
