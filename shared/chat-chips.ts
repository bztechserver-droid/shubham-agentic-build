// F-062: the three chips every chat shows: the model it runs on, its effort, and the PC it runs
// on. The rules are here, apart from the page, so they are tested without one (chat-chips.test.ts).
// Types only from the contract; nothing here imports from the app.

import type { ChatElsewhere, ChatLast, ChatRun, ChatState, DefaultModel } from './agentic.ts'

/** What the chips need of an agent. */
export interface ChipAgent {
  /** Pinned model alias ('opus', 'sonnet', 'haiku'), or '' for the CLI's own. */
  model: string
  /** Effort its chat starts with ('' is the CLI's own). */
  effort: string
  sessionId: string | null
}

/** Where chats run, as the app's store has it. */
export interface ChipWhere {
  live: Record<string, ChatState>
  elsewhere: Record<string, ChatElsewhere>
  last: Record<string, ChatLast>
  /** This PC's name among the hub's; null on its own. */
  team: { pc: string } | null
}

export interface Chip {
  /** What the chip says: short, it has to fit 360px with two others. */
  text: string
  /** The longer sentence (the tooltip, and what a screen reader hears): what it is and how it is known. */
  title: string
  /** `known`: said by the chat itself or set on the agent; `default`: the CLI's own choice; `unknown`: nothing is known yet. */
  kind: 'known' | 'default' | 'unknown'
}

export interface Chips {
  model: Chip
  effort: Chip
  pc: Chip
}

const CAPS: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }

/**
 * A model id or alias as a person writes it: "claude-sonnet-5-5" is "Sonnet 5.5",
 * "claude-opus-4-1-20250805" is "Opus 4.1", "claude-3-5-sonnet-20241022" is "Sonnet 3.5", an alias
 * ("opus") is "Opus", "[1m]" (the long context) is " 1M". Anything else is shown as it is, without
 * the "claude-" and the date, cut to 20 characters.
 */
export function modelLabel(id: string): string {
  let s = id.trim()
  let long = ''
  const ctx = /\[(\d+)m\]$/i.exec(s)
  if (ctx) {
    long = ` ${ctx[1]}M`
    s = s.slice(0, ctx.index)
  }
  const lower = s.toLowerCase()
  if (CAPS[lower]) return CAPS[lower] + long
  const dated = lower.replace(/-\d{8}$/, '')
  const a = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(dated)
  if (a) return `${CAPS[a[1]]} ${a[2]}${a[3] !== undefined ? `.${a[3]}` : ''}${long}`
  const b = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)$/.exec(dated)
  if (b) return `${CAPS[b[3]]} ${b[1]}${b[2] !== undefined ? `.${b[2]}` : ''}${long}`
  const plain = dated.replace(/^claude-/, '')
  return (plain.length > 20 ? `${plain.slice(0, 19)}…` : plain) + long
}

/** The effort levels, quietest first. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function chipsOf(agent: ChipAgent, run: ChatRun | undefined, defaultModel: DefaultModel | null, where: ChipWhere): Chips {
  const sid = agent.sessionId
  const runningHere = sid !== null && where.live[sid] !== undefined
  const away = sid !== null && !runningHere ? where.elsewhere[sid] : undefined

  // --- model: what its newest answer ran on, else what it is pinned to, else the default ---
  let model: Chip
  const pinned = agent.model ? modelLabel(agent.model) : null
  if (run?.model) {
    const label = modelLabel(run.model)
    model = {
      text: agent.model ? label : `${label} (default)`,
      title: `Model: ${run.model}, from its newest answer. ${agent.model ? `The agent is pinned to ${pinned}.` : "Not pinned on the agent: the one claude chooses."}`,
      kind: agent.model ? 'known' : 'default',
    }
  } else if (pinned) {
    model = { text: pinned, title: `Model: ${pinned}, pinned on the agent. It has not answered yet.`, kind: 'known' }
  } else if (defaultModel) {
    // Configured (the environment, claude's settings): the default. Inferred from another chat: a guess, which can differ per chat and per subscription.
    const guess = defaultModel.from === 'a chat that inherited it'
    model = {
      text: `${modelLabel(defaultModel.model)} (default${guess ? '?' : ''})`,
      title: guess
        ? `Model: probably ${defaultModel.model}: what the newest chat that pinned none ran on. It can differ per chat and per subscription; it is named for certain once this chat answers.`
        : `Model: ${defaultModel.model}, the default claude chooses, from claude's ${defaultModel.from}.`,
      kind: 'default',
    }
  } else {
    model = { text: 'default', title: "Model: the one claude chooses; it is named here once a chat answers.", kind: 'unknown' }
  }

  // --- effort: a running chat's newest /effort (after it started), else what it started with, else what the agent has ---
  const typed =
    run?.effort && (!runningHere || !run.startedAt || !run.effortAt || run.effortAt >= run.startedAt) && (runningHere || away !== undefined) ? run.effort : null
  let level: string
  let how: string
  if (typed) {
    level = typed
    how = 'set in the chat with /effort'
  } else if (runningHere && run?.launchedEffort !== null && run?.launchedEffort !== undefined) {
    level = run.launchedEffort
    how = 'what it started with'
  } else {
    level = agent.effort
    how = runningHere || away ? 'set on the agent' : 'set on the agent; its next start uses it'
  }
  const effort: Chip = level
    ? { text: level, title: `Effort: ${level}, ${how}.`, kind: 'known' }
    : { text: 'default', title: `Effort: the one claude chooses, ${how === 'what it started with' ? 'as it started' : 'nothing set on the agent'}.`, kind: 'default' }

  // --- PC: where it runs, else where it ran last ---
  let pc: Chip
  if (sid === null) pc = { text: 'no chat', title: 'PC: this agent has not had a chat yet.', kind: 'unknown' }
  else if (runningHere) {
    const name = where.team?.pc ?? 'This PC'
    pc = { text: name, title: `PC: its chat runs on ${name}.`, kind: 'known' }
  } else if (away) pc = { text: away.pc, title: `PC: its chat runs on ${away.pc}.`, kind: 'known' }
  else if (where.last[sid]) pc = { text: `${where.last[sid].pc} · last`, title: `PC: its chat is not running; it ran last on ${where.last[sid].pc}.`, kind: 'default' }
  else pc = { text: 'stopped', title: 'PC: its chat is not running, and where it ran last is not known.', kind: 'unknown' }

  return { model, effort, pc }
}
