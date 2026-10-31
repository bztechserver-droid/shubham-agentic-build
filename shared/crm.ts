// F-054: the CRM page's contract. The CRM is built into the page (crm-host/), from its source; the
// page can also show the CRM's own website in a frame, and this says which, where that website is
// and whether it can be shown, and whether the CRM is signed in on this PC. Types only, so the agent
// (agent/agentic/crm.ts) and the page (src/crm/) both import it. Served under
// `${AGENT_API_PREFIX}${AGENTIC_PREFIX}`: GET /crm?origin=&fresh=1, PATCH /crm {url?, mode?},
// GET /crm/session, and the proxy at /crm-proxy/* that the built-in CRM talks to.

/** The longest address kept. */
export const CRM_ADDRESS_MAX = 300

/**
 * Why the CRM can't be shown:
 * - dns: the name doesn't exist · cert: expired or not trusted · refused: nothing listens there ·
 *   timeout / network: no answer
 * - disabled: its host switched it off (Vercel's 402 DEPLOYMENT_DISABLED) · notfound: the host has
 *   no site there (404) · status: any other error answer, or one that wants a login first
 * - framing: it answers, but its headers (X-Frame-Options, CSP frame-ancestors) refuse being shown
 *   inside this app
 */
export type CrmReason = 'dns' | 'cert' | 'refused' | 'timeout' | 'network' | 'disabled' | 'notfound' | 'status' | 'framing'

/** What the hub found when it asked the CRM's site for its front page. */
export interface CrmCheck {
  /** The address that was asked (after redirects, where it ended up: `finalUrl`). */
  url: string
  /** It answered and may be shown in a frame. */
  ok: boolean
  reason: CrmReason | null
  /** The HTTP status of the answer; null when there was none. */
  status: number | null
  /** One plain sentence for the page. */
  message: string
  /** The header that refuses framing, when that is the reason, as the site sent it. */
  header: string | null
  /** How long it took, in ms. */
  ms: number
  checkedAt: string
}

/** How the CRM page shows the CRM: built into the page (the default), or its own website in a frame. */
export type CrmMode = 'bundled' | 'frame'

/** GET /crm, and what PATCH /crm answers with. */
export interface CrmAnswer {
  /** How the CRM is shown, kept on the hub. */
  mode: CrmMode
  /** The CRM website's address, kept on the hub, for the frame; null until one is set. */
  url: string | null
  /** The check of it (cached for 30 seconds on the hub); null while there is no address, or the CRM isn't shown in a frame. */
  check: CrmCheck | null
}

/** GET /crm/session: whether the CRM is signed in on this PC. Never the session itself. */
export interface CrmSessionInfo {
  signedIn: boolean
  /** Who, while signed in. */
  name: string | null
  username: string | null
  /** When the CRM ends the session (7 days after signing in). */
  expiresAt: string | null
}
