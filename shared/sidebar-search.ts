import type { Floor, FloorAgent } from './agentic.ts'

export const sidebarSearchTerm = (query: string) => query.trim().toLowerCase()

/** Rendering only: callers supply already-authorized, already-scoped floors. */
export function searchSidebar(floors: readonly Floor[], query: string): { floor: Floor; agents: FloorAgent[] }[] {
  const term = sidebarSearchTerm(query)
  return floors.flatMap(floor => {
    const agents = !term || floor.name.toLowerCase().includes(term)
      ? floor.agents
      : floor.agents.filter(a => a.name.toLowerCase().includes(term) || a.role.toLowerCase().includes(term))
    return !term || floor.name.toLowerCase().includes(term) || agents.length ? [{ floor, agents }] : []
  })
}

/** Searching never writes the remembered collapsed set. */
export const isSidebarFloorOpen = (id: string, closed: ReadonlySet<string>, query: string) => !!sidebarSearchTerm(query) || !closed.has(id)
