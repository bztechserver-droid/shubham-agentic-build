import type { DependencyCheck, DependencyReport, DependencyState } from '../../shared/dependencies.ts'
import { BRIDGE_REQUIREMENTS as REQUIRED } from '../codex-claude/requirements.ts'
import { CAPABILITY_MAX_AGE_MS, CAPABILITY_RENEW_AFTER_MS } from '../codex-claude/capability-renewal.ts'
import type { BridgeStatus } from '../codex-claude/runtime.ts'

// F-165: what Codex in Claude Code needs on a PC, checked from facts this PC already has. Building the
// report reads nothing and calls nothing; the agent gathers the facts (versions, the chat host, the CRM's
// Codex status, the bridge's own status) and this turns them into the page's rows.

export interface DependencyFacts {
  pc: { id: string; name: string }
  platform: string
  arch: string
  node: string
  claude: { found: boolean; version: string | null }
  codex: { found: boolean; version: string | null }
  chatHost: boolean
  /** The CRM's Codex status on this PC (CodexStatus.state), or null when this PC has no Codex manager. */
  codexState: string | null
  /** 'chatgpt' | 'api_key' | null: what the CRM hands this person. */
  codexKind: string | null
  /** The CRM's own sentence, when it has one. */
  codexHint: string | null
  /** The bridge's status, or null when this PC does not run chats (agents off). */
  bridge: BridgeStatus | null
}

const ago = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`
const row = (id: string, label: string, state: DependencyState, detail: string, why: string, fix: string): DependencyCheck => ({ id, label, state, detail, why, fix })

export function dependencyReport(f: DependencyFacts, now: number): DependencyReport {
  const checks: DependencyCheck[] = []
  checks.push(row('windows', 'Windows, 64-bit', f.platform === REQUIRED.platform && f.arch === REQUIRED.arch ? 'ok' : 'missing',
    `${f.platform === 'win32' ? 'Windows' : f.platform}, ${f.arch}`,
    'The bridge proves each chat through Windows itself: the exact Claude Code and helper processes, and the private port each one listens on.',
    'Run Codex in Claude Code on a 64-bit Windows PC. On another system, use Claude or Codex on their own.'))
  checks.push(row('node', `Node.js ${REQUIRED.node}`, f.node === REQUIRED.node ? 'ok' : 'missing', `Node.js ${f.node}`,
    'The bridge is proved with this exact Node.js; with any other version it refuses to start, and every open says "The target has not proved this execution capability".',
    `Install Node.js ${REQUIRED.node} on this PC, then restart the app.`))
  checks.push(row('claude', `Claude Code ${REQUIRED.claude}`, !f.claude.found ? 'missing' : f.claude.version === REQUIRED.claude ? 'ok' : 'missing',
    !f.claude.found ? 'Not found on this PC' : f.claude.version ? `Claude Code ${f.claude.version}` : 'Found, but its version could not be read',
    'The chat window is this exact Claude Code. A newer one (Claude Code updates itself) is refused until the bridge has been checked against it, and the error above shows.',
    `Install Claude Code ${REQUIRED.claude} (the Windows .exe) and keep it on that version on this PC, then restart the app.`))
  checks.push(row('codex', `Codex CLI ${REQUIRED.codex}`, !f.codex.found ? 'missing' : f.codex.version === REQUIRED.codex ? 'ok' : 'missing',
    !f.codex.found ? 'Not found on this PC' : f.codex.version ? `Codex CLI ${f.codex.version}` : 'Found, but its version could not be read',
    `Requests go to ChatGPT the way Codex ${REQUIRED.codex} sends them, and the bridge checks that this is the Codex installed here.`,
    `Install Codex CLI ${REQUIRED.codex} on this PC, then restart the app.`))
  checks.push(row('chat-host', 'The app\'s chat host is running', f.chatHost ? 'ok' : 'missing', f.chatHost ? 'Connected' : 'Not connected',
    'Every chat runs inside the chat host; the bridge asks it which chats run and proves each one before letting it reach ChatGPT.',
    'Restart the app on this PC (Start.cmd). The chat host starts with it and keeps chats running across updates.'))
  const signedIn = f.codexState !== null && f.codexState !== 'sign-in-needed'
  checks.push(row('crm', 'Signed in to the CRM on this PC', f.codexState === null ? 'unknown' : signedIn ? 'ok' : 'missing',
    f.codexState === null ? 'This PC has no Codex manager' : signedIn ? 'Signed in' : (f.codexHint ?? 'Not signed in'),
    'The ChatGPT login Codex in Claude Code uses comes from the CRM, for the person signed in on this PC. Nothing is typed into this PC.',
    'Sign in to the CRM in the app on this PC, as the person whose Codex subscription should be used.'))
  const subscription = f.codexState === 'ok' && f.codexKind === 'chatgpt'
  checks.push(row('codex-login', 'A ChatGPT Codex subscription from the CRM', f.codexState === null || !signedIn ? 'unknown' : subscription ? 'ok' : 'missing',
    f.codexState === null || !signedIn ? 'Waits for the CRM sign-in'
      : subscription ? 'ChatGPT login in place' : f.codexKind === 'api_key' ? 'The CRM gives an OpenAI API key, not a ChatGPT login' : (f.codexHint ?? `Codex is ${f.codexState}`),
    'Every request is GPT-6.1 Sol at max effort on your ChatGPT subscription, checked with the CRM every 30 s. An API key or no subscription can\'t be used, and nothing falls back.',
    'Ask the CRM super admin to put you on a ChatGPT Codex subscription, then press Check again on this page.'))
  const b = f.bridge
  checks.push(row('setup', 'Codex in Claude Code set up on this PC', !b ? 'unknown' : b.setUp ? 'ok' : 'missing',
    !b ? 'This PC does not run chats' : b.setUp ? 'Set up' : 'Never set up here',
    'Before the first chat, one check sends a single real request to ChatGPT and runs Claude Code once, proving the whole path on this PC.',
    'Choose Codex in Claude Code as the engine of an agent whose home is this PC; that runs the check once.'))
  if (b?.setUp) {
    const at = b.verifiedAt ? Date.parse(b.verifiedAt) : Number.NaN, age = now - at
    const fresh = Number.isFinite(at) && at <= now && age < CAPABILITY_MAX_AGE_MS
    const state: DependencyState = !fresh || b.forThisBuild === false ? 'missing' : age >= CAPABILITY_RENEW_AFTER_MS ? 'warning' : b.forThisBuild === null ? 'unknown' : 'ok'
    checks.push(row('proof', 'The setup check is current', state,
      !Number.isFinite(at) ? 'Its time can\'t be read' : `Checked ${ago(Math.max(0, age))} ago${b.forThisBuild === false ? ', by an older build' : ''}${fresh ? '' : ' (expired)'}`,
      'The check is accepted for 24 hours and only for the build that made it. Expired, every open says "The target has not proved this execution capability" and running chats pause.',
      'It renews by itself from 20 h, and about a minute after the app starts if it had expired, as long as the same person is signed in to the CRM. Otherwise choose Codex in Claude Code as an agent\'s engine again.'))
    checks.push(row('started', 'The bridge started on this PC', b.started === 'ok' ? 'ok' : b.started === 'starting' ? 'warning' : b.started === 'idle' ? 'unknown' : 'missing',
      b.started === 'ok' ? 'Running' : b.started === 'starting' ? 'Starting…' : b.started === 'idle' ? 'Starts with the first Codex in Claude Code chat'
        : b.started === 'closed' ? 'Stopped (the app is closing)' : `Failed to start (${b.failure ?? 'unavailable'})`,
      'Starting checks every item above, the private folder the bridge keeps its records in, and that Claude Code was not replaced while the app runs. If it fails, every open shows the error.',
      'Fix the item marked above. The bridge tries again by itself after 5 s, 15 s, 1 min, then every 2 min; a restart of the app also retries at once.'))
  }
  return { version: 1, pc: f.pc, checkedAt: new Date(now).toISOString(), ready: checks.every(c => c.state === 'ok' || c.state === 'warning'), checks }
}
