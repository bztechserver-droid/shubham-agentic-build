// The address a page tells a person to open this app at (on the phone, for the microphone): built from what this PC knows of itself, never typed
// in the code, because the tailnet's name changes (the PC moved tailnets on 4 Nov 2026).

/** Port of the app's page behind `tailscale serve` (https, tailnet only). */
export const APP_HTTPS_PORT = 5173
/** Port of the app's page on the Tailscale address itself (Open-To-Tailnet.cmd): plain http. */
export const APP_TAILNET_PORT = 5190

export interface PageAddress {
  url: string
  /** True for the https address: only a secure page can use the microphone. The plain-http address says nothing of the kind. */
  secure: boolean
}

/** The bits of SelfInfo it reads (a page that has not heard from the agent yet passes null). */
export interface AddressSource {
  tailnetName?: string | null
  tailnetAddress?: string | null
}

/**
 * `https://<tailnet name>:5173` when this PC knows its tailnet name; else `http://<tailnet IP>:5190` (not secure: no microphone claim);
 * null without Tailscale, or when nothing is known yet.
 */
export function pageAddress(self: AddressSource | null | undefined): PageAddress | null {
  const name = self?.tailnetName?.trim().replace(/\.$/, '')
  if (name) return { url: `https://${name}:${APP_HTTPS_PORT}`, secure: true }
  const ip = self?.tailnetAddress?.trim()
  if (ip) return { url: `http://${ip}:${APP_TAILNET_PORT}`, secure: false }
  return null
}

/**
 * What a device's recorded page address (where it registered from) means for signing here. A device's key lives in one page address's browser storage:
 *   here         the same address as this page: it can sign here
 *   other        another address (another port, another name): it can only sign there
 *   old-tailnet  a tailnet name from another tailnet than this PC's now: that address is gone, it can't sign any more
 *   null         no address was kept (a device registered before it was), so nothing is said
 * For showing only, never for deciding anything.
 */
export type OriginNote = 'here' | 'other' | 'old-tailnet'

export function originNote(origin: string | undefined | null, here: string, tailnetName: string | null | undefined): OriginNote | null {
  if (!origin) return null
  if (origin === here) return 'here'
  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return 'other'
  }
  const now = tailnetName?.trim().replace(/\.$/, '').toLowerCase()
  // "server.tail36192f.ts.net" belongs to the tailnet "tail36192f.ts.net": the part after the machine's name.
  const tailnetOf = (name: string) => name.slice(name.indexOf('.') + 1)
  if (now && host.endsWith('.ts.net') && now.endsWith('.ts.net') && tailnetOf(host) !== tailnetOf(now)) return 'old-tailnet'
  return 'other'
}
