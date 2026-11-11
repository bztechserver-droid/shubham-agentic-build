// order o57e2: the Accounts page is a frame of tabs (the first is Email); more follow, each named by Shubham. These are the pure rules the frame uses: which tab is open, and what a key does on the tab
// strip. The tab list itself is src/accounts/tabs.ts: adding a tab is one entry there.

/** The tab an address asks for (?tab=email): that one if it exists, else the first (the default). */
export const tabFromParam = (ids: readonly string[], raw: string | null): string => (raw !== null && ids.includes(raw) ? raw : ids[0])

/** What a key does on the focused tab: the arrows move to the next or previous tab (round the ends), Home and End go to the first and last. Null: not a tab-strip key. */
export function tabAfterKey(ids: readonly string[], current: string, key: string): string | null {
  const i = ids.indexOf(current)
  if (ids.length === 0 || i < 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return ids[(i + 1) % ids.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return ids[(i + ids.length - 1) % ids.length]
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids[ids.length - 1]
  return null
}
