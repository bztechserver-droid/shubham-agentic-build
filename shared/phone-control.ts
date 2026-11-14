// Order oae15 (Shubham, 14 Nov 2026: "Yes to both, start", the phone-control safety fixes): what the page shows of phone control and its own
// switch on the PC. The hub's side is agent/agentic/phone.ts (GET /agent-api/voice/control-status, POST /voice/control-switch {on},
// POST /voice/control-stop); the phone's side is the Chris app's accessibility service (mobile/docs/HUB-PROTOCOL.md §11).
// Phone control is OFF until Shubham switches it on here, with his own CRM administrator session; off stops at once whatever the phone is doing.

/** The PC's switch. Off by default; `by` names the person (or "the app") who last switched it. */
export interface PhoneSwitch {
  on: boolean
  /** When it was last switched (ms), or null when never. */
  at: number | null
  by: string
}

/** Why a phone is not armed (the phone says, HUB-PROTOCOL.md §11.1). */
export type PhoneReason = 'service-off' | 'switch-off' | 'stopped' | 'locked' | 'screen-off'

/** One paired phone as the hub knows it. */
export interface PhoneDeviceState {
  id: string
  name: string
  online: boolean
  armed: boolean
  reason: PhoneReason | null
  stopped: boolean
  /** The app in front, or 'blocked'; null while not armed or unknown. */
  app: string | null
  /** Seconds since the phone was last heard from. */
  quietS: number | null
  pending: number
  /** What the phone waits for his fingerprint or face for, while it does. */
  waiting: string | null
}

/** One command of the log: never a screen's text or what was typed (only its length). */
export interface PhoneLogRow {
  at: number
  device: string
  op: string
  args: Record<string, unknown>
  why: string
  by?: 'assistant' | 'mobile'
  ok: boolean
  kind: string | null
  error: string
  nodes: number | null
}

export interface PhoneControlStatus {
  devices: PhoneDeviceState[]
  /** The newest first, at most 50. */
  log: PhoneLogRow[]
  switch: PhoneSwitch
  /** This PC is a member: phone control is the Server's, switched and stopped there. */
  member?: boolean
}

/**
 * Order oae15 (review): only the card's own request switches phone control ON; it says so with this header, which no other request of a page
 * carries (a CRM handler that builds a request from an id cannot add it).
 */
export const PHONE_SWITCH_HEADER = 'x-sad-phone-switch'

/** The section of Settings that holds the switch (Settings › Devices). */
export const PHONE_CONTROL_SECTION = 'settings-phone-control'

/** What the Assistant is told while the switch is off. */
export const PHONE_SWITCH_OFF_LINE =
  "Not done: phone control is switched off in the app on the Server (Settings › Devices › Phone control), and only Shubham can switch it on there. Tell him what you wanted to do on his phone; do not try to get around it."
