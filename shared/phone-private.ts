// Order oae15 (Shubham, 14 Nov 2026: "Yes to both, start", the phone-control safety fixes): what is on his phone's screen and what the
// Assistant types there are kept off the CRM drive, the same way the Browser's pages are (F-220, shared/browser.ts). The phone tools'
// answers carry this mark, so the rows that hold them are blanked in the copy of a chat that goes to the CRM (F-211,
// agent/agentic/conversations.ts). Built from parts so that code naming it is not taken for such a row.

export const PHONE_PRIVATE_MARK = ['sad', 'private', 'phone'].join('-')

/** Said with every phone answer that holds more than "Done." (the mark included). */
export const PHONE_PRIVATE_NOTE = `Private (${PHONE_PRIVATE_MARK}): what is on Shubham's phone and what was typed there are for this chat only. Never save them or pass them on (memory, tasks, the CRM, files, other chats); quote only what Shubham asked for.`

/** The folder name of the phone's screenshots on the hub (agent/agentic/phone.ts): a row that names one of them is blanked too. */
export const PHONE_SHOTS_DIR = 'phone-shots'

/**
 * The most of a phone answer a chat gets. Claude Code moves a longer MCP answer (over 100,000 characters) into a side file the chat then
 * reads in pieces, and those pieces would carry the screen's words without the mark: so the answer is cut well under that, as the Browser's is.
 */
export const PHONE_ANSWER_MAX = 30_000

/** What a phone tool answers (order oae15): the private mark FIRST (so even a preview carries it), then the answer, cut at a line's end. */
export function phoneAnswer(out: string): string {
  if (out === 'Done.') return out
  let body = out
  if (body.length > PHONE_ANSWER_MAX) {
    const end = body.lastIndexOf('\n', PHONE_ANSWER_MAX)
    body = `${body.slice(0, end > 0 ? end : PHONE_ANSWER_MAX)}\n(cut: the screen holds more than fits here; scroll, or read it again for the part you need)`
  }
  return `${PHONE_PRIVATE_NOTE}\n\n${body}`
}
