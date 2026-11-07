/** F-053: five visible choices, not a five-route limit. Filtering always sees the full allowed list. */
export const ROUTE_SELECT_ROWS = 5

type RouteOption = { readonly to: string; readonly label: string; readonly blurb: string }
const normalized = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** All words must match the name, description or path; preserve the navigation's order. */
export function searchRoutes<T extends RouteOption>(pages: readonly T[], query: string): T[] {
  const words = normalized(query).trim().split(/\s+/).filter(Boolean)
  return pages.filter(p => {
    const haystack = normalized(`${p.label} ${p.blurb} ${p.to}`)
    return words.every(word => haystack.includes(word))
  })
}

/** The list's keyboard step. Empty results never select an invalid option. */
export function routeSelectIndex(count: number, at: number, key: string): number | null {
  if (count <= 0) return null
  const current = Math.min(count - 1, Math.max(0, at))
  switch (key) {
    case 'ArrowDown': return (current + 1) % count
    case 'ArrowUp': return (current + count - 1) % count
    case 'PageDown': return Math.min(count - 1, current + ROUTE_SELECT_ROWS)
    case 'PageUp': return Math.max(0, current - ROUTE_SELECT_ROWS)
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}
