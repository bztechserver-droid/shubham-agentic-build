import type { TailnetCompare } from './agent-api.ts'

// F-110: what the Devices page says about the tailnets of this PC and its hub. The agent decides (TailnetCompare.state); the page only trusts a
// "different" when it can see two names that differ itself, so an older or confused agent can never show a false warning.

export type TailnetNote =
  | { kind: 'different'; text: string; mine: string; theirs: string; fresh: boolean }
  | { kind: 'same'; name: string }

const norm = (s: string | null | undefined) => {
  const v = s?.trim().replace(/\.$/, '').toLowerCase()
  return v ? v : null
}

/** What to draw on the hub's row: a warning, a calm "same", or null (nothing: absent, unknown, or an answer that doesn't add up). */
export function tailnetNote(t: TailnetCompare | null | undefined, hubName: string): TailnetNote | null {
  if (!t) return null
  const mine = norm(t.mine)
  const theirs = norm(t.theirs)
  if (!mine || !theirs) return null
  if (t.state === 'same' && mine === theirs) return { kind: 'same', name: theirs }
  if (t.state === 'different' && mine !== theirs) {
    const text =
      t.message?.trim() ||
      `This PC is on the tailnet ${mine}, but ${hubName} ${t.fresh ? 'is' : 'was last'} on ${theirs}. Sign this PC in to ${theirs}.`
    return { kind: 'different', text, mine, theirs, fresh: t.fresh }
  }
  return null
}

/** One plain line for the row's details, with "unknown" spelled out, e.g. "Tailnets: this PC tail1.ts.net, Server unknown". */
export function tailnetFacts(t: TailnetCompare | null | undefined, hubName: string): string | null {
  if (!t) return null
  return `Tailnets: this PC ${norm(t.mine) ?? 'unknown'}, ${hubName} ${norm(t.theirs) ?? 'unknown'}${t.theirs && !t.fresh ? ' (as last said)' : ''}`
}
