/**
 * Orders o1fa0 + o2915 (Shubham, 14 Nov 2026: "Now add a tab SSH in the PC control please." then "No, I want to use it in the app itself."): PC control's
 * SSH tab opens a live SSH session to that PC in the page. The SERVER's agent runs its own ssh client (its own key, the one already authorised on that
 * PC) in a pseudo-terminal and streams it to the page: no key or password ever goes to the browser.
 *
 * - Human only, the owner only, as the PC screen and phone control are: POST /agent-api/pc-ssh/pcs/<id>/session {user, host, port} needs the signed-in
 *   CRM administrator's own session (not a chat tool, not a program with the machine token). It answers a one-use ticket (30 s) for the WebSocket
 *   /agent-api/pc-ssh/terminal?ticket=<t>, which only that same session may open.
 * - Only to the tailnet: the host is a Tailscale address (100.64.0.0/10) or name (*.ts.net); the user a plain login name. ssh asks Shubham himself to
 *   confirm a PC's key the first time (the page shows the key the Server already knows for that PC, to compare).
 * - The session ends when the page closes it (or the tab, or the sign-in ends); the ssh process is ended then by its own handle (exact PID).
 */
import { cleanTailnetIp, cleanTailnetName } from './pc-ports.ts'

export const PC_SSH_PREFIX = '/pc-ssh'

export interface SshTarget {
  user: string
  /** A Tailscale IPv4 or a *.ts.net name. */
  host: string
  port: number
}

/** GET /pc-ssh/pcs/<id>/target: what to fill the form with: the last session's target for this PC, else the PC's Tailscale address from its link. */
export interface SshTargetAnswer {
  pcId: string
  user: string | null
  host: string | null
  port: number | null
  /** 'saved' (the last session to this PC), 'guess' (only the address, from its link), or null (nothing known). */
  from: 'saved' | 'guess' | null
}

/** POST /pc-ssh/pcs/<id>/session: a one-use ticket for the terminal socket, and the host keys the Server already knows for that address. */
export interface SshSessionAnswer {
  ticket: string
  expiresAt: string
  target: SshTarget
  /** Fingerprints the Server's known_hosts has for this host and port ("SHA256:…"); [] = ssh will ask to confirm the PC's key. */
  knownForPort: string[]
  /** Fingerprints it has for the same host on port 22 (often the same key): what to compare ssh's question with. */
  knownForHost: string[]
}

/** The page → the agent, text frames: keys, and the terminal's size. */
export type SshTermClientMessage = { t: 'in'; d: string } | { t: 'size'; cols: number; rows: number }
/** The agent → the page: what ssh printed; and once, when it ends, why. */
export type SshTermServerMessage = { t: 'out'; d: string } | { t: 'exit'; code: number | null; reason: string }

/** A login name ssh takes as one argument and never as an option: starts with a letter or digit; letters, digits, . _ - only. */
export const cleanLogin = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null)

/** The target as asked, checked: only the tailnet, a plain user, a real port; null for anything else. */
export function cleanTarget(raw: unknown): SshTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const user = cleanLogin(r.user)
  const host = typeof r.host === 'string' ? (cleanTailnetIp(r.host) ?? cleanTailnetName(r.host)) : null
  const port = typeof r.port === 'number' ? r.port : typeof r.port === 'string' && /^\d{1,5}$/.test(r.port) ? Number(r.port) : NaN
  if (!user || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { user, host, port }
}

/** "ssh scyramp-ai-1@100.71.234.71 -p 2222" (no "-p" for 22): what the session runs, in words for the page. */
export const sshLine = (t: SshTarget) => `ssh ${t.user}@${t.host}${t.port === 22 ? '' : ` -p ${t.port}`}`

/** The terminal's size as the page may ask it (columns 2-500, rows 1-300), or null. */
export function cleanSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  return Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= 2 && (cols as number) <= 500 && (rows as number) >= 1 && (rows as number) <= 300 ? { cols: cols as number, rows: rows as number } : null
}
