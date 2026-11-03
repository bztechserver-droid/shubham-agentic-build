import { namesFor, type Names } from '../../shared/fast-names.ts'
import { TOOLS, type ToolDef } from './tools.ts'

// F-086/F-087: what the fast Assistant may use. It is NOT a chat on a floor: the hub knows it by its own key (a caller kind), and this list is
// what that kind may call, checked on the hub at every call (index.ts callTool), whatever the model says or is told by text it read.
// The list is explicit: a tool added to TOOLS later is NOT the Assistant's until it is written here and the test below is changed on purpose.
//
// It reads (the app's state, chats, memory, tasks, the screen), opens pages (goto, crm_goto, scroll, wait: no clicks, no typing, no keys), adds a task
// (the one write Shubham allowed) and hands everything else to the big chat (hand_off). It has no tool that sends to a chat, answers Approvals,
// signs, publishes, controls the phone or touches WhatsApp or the CRM's data; nothing it reads can give it one.
// The words in the tool texts follow the Settings choice "What the chats are called" (shared/fast-names.ts), as the brief does.

const none = { type: 'object', properties: {}, additionalProperties: false }

/** The tools of TOOLS the Assistant may call. */
export const FAST_FROM_TOOLS = ['app_chats', 'floor_roster', 'app_read_chat', 'app_read_conversation', 'memory_search', 'memory_read', 'memory_recent', 'task_list', 'task_add', 'ui_screen', 'ui_control', 'watchdog_status'] as const

/** Tools only the Assistant has. */
export function fastOnlyTools(n: Names = namesFor('old')): ToolDef[] {
  return [
    {
      name: 'hand_off',
      description: `Give a request to ${n.big} (the bigger chat that can really do things: order the agents, change anything, publish, use the phone or WhatsApp, work for a long time) and say so to the person at once. It returns an order id straight away; ${n.big}'s answer comes back to you later as a note, and you then tell it in one to three short sentences. Write the request so ${n.big} needs nothing else: what he asked, in his words, and anything you know that matters. If it answers "busy", tell him why in one sentence and do not try again yourself.`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The request, complete in itself (at most 2000 characters).' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'order_status',
      description: `Where a request you handed to ${n.big} is (queued, working, waiting for his answer on the PC, answered, cancelled). Leave orderId out for all that are open.`,
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, additionalProperties: false },
    },
    {
      name: 'approvals_waiting',
      description: 'How many chats are waiting for HIS answer in Approvals, and which (agent and floor). Read only: you can say it, you can never answer one; he does that himself.',
      inputSchema: none,
    },
  ]
}

/** The names of the three (they do not depend on the words). */
export const FAST_ONLY_NAMES: readonly string[] = fastOnlyTools().map(t => t.name)

/** Everything the Assistant may call. */
export const FAST_ALLOWED: readonly string[] = [...FAST_FROM_TOOLS, ...FAST_ONLY_NAMES]

/** ui_control actions it may use: open pages and read, nothing that presses, types or sends keys. */
export const FAST_UI_ACTIONS: readonly string[] = ['goto', 'crm_goto', 'scroll', 'wait']

/** The tool list the Assistant's process is shown (tools/list): the allowed ones, ui_control narrowed to its actions, the words following the names in force. */
export function fastTools(n: Names = namesFor('old')): ToolDef[] {
  const out: ToolDef[] = []
  for (const name of FAST_FROM_TOOLS) {
    const def = TOOLS.find(t => t.name === name)
    if (!def) continue
    if (name !== 'ui_control') {
      out.push(def)
      continue
    }
    const schema = def.inputSchema as { properties?: Record<string, Record<string, unknown>> }
    out.push({
      ...def,
      description: `${def.description} (For you only: goto, crm_goto, scroll and wait. You cannot click, type or press keys; ask ${n.big} with hand_off.)`,
      inputSchema: { ...def.inputSchema, properties: { ...schema.properties, action: { type: 'string', enum: [...FAST_UI_ACTIONS] } } },
    })
  }
  return [...out, ...fastOnlyTools(n)]
}

/** Why a call is refused, in a sentence the model can act on; null when it may go on. */
export function fastDenied(name: string, args: unknown, n: Names = namesFor('old')): string | null {
  if (!FAST_ALLOWED.includes(name)) {
    return `You may not use ${name}. You look things up, open pages and add tasks; for anything else, use hand_off and ${n.big} does it.`
  }
  if (name === 'ui_control') {
    const action = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).action : undefined
    if (typeof action !== 'string' || !FAST_UI_ACTIONS.includes(action)) {
      return `You may only open pages and scroll (ui_control ${FAST_UI_ACTIONS.join(', ')}), not "${String(action)}". For anything on the page, use hand_off.`
    }
  }
  return null
}
