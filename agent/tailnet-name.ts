import { tailnetInfo, type Runner } from './drive/tailscale.ts'

// F-057 follow-up (4 Nov 2026): the PC's own name on the tailnet ("server.tail36192f.ts.net"), so a page can show the address to open on a phone without a
// name typed into the code (the name changes with the tailnet: it did on 4 Nov). The state of the agent is built often and without waiting, so `get()` answers
// at once with what is known and looks again in the background when it is older than a minute; when the name changes, `onChange` lets the page know.
// Asked only while Tailscale is up on this PC (it has an address), so a PC without Tailscale never runs the command. `disabled` is for test mode.

export interface TailnetNameOptions {
  /** Is Tailscale up on this PC (does it have a tailnet address)? */
  up: () => boolean
  /** Never asks (tests, SAD_TEST_NO_RUSTDESK=1). */
  disabled?: boolean
  run?: Runner
  now?: () => number
  ttlMs?: number
  onChange?: () => void
}

export interface TailnetName {
  /** The machine's name on the tailnet (no trailing dot), or null while unknown or when Tailscale isn't up. */
  get(): string | null
}

export function createTailnetName(o: TailnetNameOptions): TailnetName {
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 60_000
  let name: string | null = null
  let asked = Number.NEGATIVE_INFINITY
  let looking = false

  function look() {
    looking = true
    asked = now()
    void tailnetInfo(o.run)
      .then(info => {
        // A failed look keeps what was known; the next one comes after the TTL.
        if (!info || info.dnsName === name) return
        name = info.dnsName
        o.onChange?.()
      })
      .catch(() => undefined)
      .finally(() => {
        looking = false
      })
  }

  return {
    get() {
      if (o.disabled) return null
      if (!o.up()) {
        // Tailscale went away: forget the name, and look at once when it comes back.
        name = null
        asked = Number.NEGATIVE_INFINITY
        return null
      }
      if (!looking && now() - asked >= ttl) look()
      return name
    },
  }
}
