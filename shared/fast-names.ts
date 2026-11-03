// F-086/F-087: what the two agents are CALLED, by the Settings choice "What the chats are called". One place, used by the hub (the Assistant's brief, its
// tool texts, the hand-off cards and notes) and by the page and Chris through GET /voice/hello (`names`), so the words the model speaks always match the bar.
//   old (the default until Shubham flips it): the big overlay chat is "the Assistant"; the new fast one is "Quick".
//   new: the big one is "the Orchestrator"; the fast one is "the Assistant".

export type NamesChoice = 'old' | 'new'

export interface Names {
  choice: NamesChoice
  /** The big overlay chat, with its article: "the Assistant" / "the Orchestrator". */
  big: string
  /** The fast agent, with its article where it has one: "Quick" / "the Assistant". */
  fast: string
  /** The same two as bare names for headings: "Assistant" / "Orchestrator", "Quick" / "Assistant". */
  bigName: string
  fastName: string
}

export const namesChoice = (v: unknown): NamesChoice => (v === 'new' ? 'new' : 'old')

export function namesFor(choice: unknown): Names {
  return namesChoice(choice) === 'new'
    ? { choice: 'new', big: 'the Orchestrator', fast: 'the Assistant', bigName: 'Orchestrator', fastName: 'Assistant' }
    : { choice: 'old', big: 'the Assistant', fast: 'Quick', bigName: 'Assistant', fastName: 'Quick' }
}
