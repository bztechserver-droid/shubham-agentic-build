// Order o3963 (Shubham: "if we can have the control screen of any pc also here then i click then overlay comes obve this overlay chat when i
// clik on area button given by you"): an agent puts a button for a PC's screen into its chat (the app's MCP tool show_screen); his tap opens
// that PC's Control screen (the same viewer as PC control: src/pages/Remote.tsx) as a layer above the overlay chat. Nothing connects before
// the tap. Like show_media (shared/media.ts), the tool's answer is a JSON line the transcript carries; the page reads it back here.

/** The tool's name as claude writes it in its transcript: mcp__<the app's server>__show_screen. */
export const SCREEN_TOOL = 'show_screen'
export const isScreenToolName = (name: string) => name === SCREEN_TOOL || /^mcp__[^_].*__show_screen$/.test(name)

/** What the tool answers and the chat shows: which PC (its device id, as PC control knows it), its name then, a line under the button. */
export interface ScreenShown {
  pc: string
  name: string
  caption: string | null
}

/** A device id as the app's PCs have them (identity ids, RustDesk ids): no path, no spaces. */
const PC_ID = /^[A-Za-z0-9_.:-]{1,80}$/
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** The tool's answer as the chat has it: the PC to offer, or null (an error, an older answer, anything else). */
export function parseScreenResult(output: string): ScreenShown | null {
  const start = output.indexOf('{')
  if (start < 0) return null
  let data: unknown
  try {
    data = JSON.parse(output.slice(start))
  } catch {
    return null
  }
  const s = typeof data === 'object' && data !== null ? (data as { screen?: unknown }).screen : null
  if (typeof s !== 'object' || s === null) return null
  const r = s as Record<string, unknown>
  if (typeof r.pc !== 'string' || !PC_ID.test(r.pc)) return null
  return { pc: r.pc, name: str(r.name, 100) ?? r.pc, caption: str(r.caption, 300) }
}

/**
 * What the device agent says of that PC now (Settings › Devices: this PC itself, or a paired PC's row, the same list the Control screen
 * itself reads), for the bubble's line and whether its button can be tapped. The viewer opens a PC whose screen can be reached one way or
 * the other (the app's own screen, or RustDesk); one that is off or unreachable, or whose build or setup offers neither, says so instead.
 */
export type ScreenState = 'loading' | 'ready' | 'offline' | 'not-ready' | 'gone' | 'no-agent'

/** The parts of a device row (shared/agent-api.ts DeviceInfo) the bubble reads. */
export interface ScreenDevice {
  location: string
  canOpenScreen: boolean
  canOpenAppScreen: boolean
}

export function screenStateOf(device: ScreenDevice | null | undefined, o: { loaded: boolean; down: boolean }): ScreenState {
  if (!o.loaded) return o.down ? 'no-agent' : 'loading'
  if (!device) return 'gone'
  if (device.location === 'offline' || device.location === 'unreachable') return 'offline'
  const reachable = device.canOpenScreen || device.canOpenAppScreen
  if (!reachable && device.location === 'connecting') return 'loading'
  return reachable ? 'ready' : 'not-ready'
}

/** The button can be tapped: the viewer would connect. */
export const screenOpens = (s: ScreenState) => s === 'ready'

/** The line under the button, in plain words. */
export function screenWords(s: ScreenState, name: string): string {
  switch (s) {
    case 'loading':
      return `Checking ${name}…`
    case 'ready':
      return 'Connects only when you tap. The password it remembers, and its screen permissions, still apply.'
    case 'offline':
      return `${name} is off or not reachable right now.`
    case 'not-ready':
      return `${name}'s screen can't be opened from here yet: it runs an older build, or its screen isn't set up (Settings › Devices).`
    case 'gone':
      return `${name} is not among this app's PCs any more.`
    case 'no-agent':
      return `The device agent isn't reachable right now, so ${name} can't be checked.`
  }
}
