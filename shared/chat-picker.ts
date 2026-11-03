// F-088: what the Floor and Agent chips of a chat bar list, and what choosing does. Pure, so it is tested.

export type PickStatus = 'running' | 'waiting' | 'done' | 'idle' | 'error'

export interface PickAgent {
  id: string
  name: string
  isBoss?: boolean
  status?: PickStatus
  /** "Working", "Waiting for you", "Not running": the word for the status. */
  label?: string
}
export interface PickFloor {
  id: string
  name: string
  agents: PickAgent[]
}

/** How many of a floor's agents wait for him. */
export const waitingOn = (f: PickFloor) => f.agents.filter(a => a.status === 'waiting').length

/**
 * What choosing a floor does: the agent stays when it is on that floor, else the floor's first chat (its boss first, as the
 * floors list them). A floor with no agents cannot be chosen: null.
 */
export function pickOnFloor(floor: PickFloor, current: string | null): string | null {
  if (current && floor.agents.some(a => a.id === current)) return current
  return floor.agents.find(a => a.isBoss)?.id ?? floor.agents[0]?.id ?? null
}

/** Floors in the order shown, the floor in hand first (the Agents page keeps its own floor on top). */
export function floorsFirst<T extends { id: string }>(floors: readonly T[], first: string | null): T[] {
  const here = floors.find(f => f.id === first)
  return here ? [here, ...floors.filter(f => f !== here)] : [...floors]
}
