// order o9e44, o9532: the Accounts page's tables (Email, Codebases). The pure part: how a column sorts, what a click on a header does, which layout a width gets (a real table when the area is wide, a
// card per row when it is narrow: decided by the width of the AREA the list sits in, never by the device), and the date as the page writes it. The component is src/accounts/DataTable.tsx.

export type SortDir = 'asc' | 'desc'
export interface SortState {
  key: string
  dir: SortDir
}

/** A value a column sorts by: text (compared in the reader's language, numbers inside text in order), a number, a yes/no, or nothing (always last, whichever way it sorts). */
export type SortValue = string | number | boolean | null | undefined

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b)
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}
const empty = (v: SortValue) => v === null || v === undefined || v === ''

/**
 * The rows in the order a sort asks for. A copy (the rows are not touched). Rows with nothing in that column go last in either direction; equal rows keep the order they came in (stable), so a second sort
 * by another column never shuffles ties.
 */
export function sortRows<T>(rows: readonly T[], get: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const ex = empty(x.v)
      const ey = empty(y.v)
      if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1
      return sign * compare(x.v, y.v) || x.i - y.i
    })
    .map(x => x.row)
}

/** A click on a header: the same column flips its direction; another column starts ascending. */
export function nextSort(state: SortState, key: string): SortState {
  return state.key === key ? { key, dir: state.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
}

/** The word a screen reader gets on a header (aria-sort). */
export const ariaSort = (state: SortState, key: string): 'ascending' | 'descending' | 'none' => (state.key !== key ? 'none' : state.dir === 'asc' ? 'ascending' : 'descending')

/** Below this width of the AREA the list sits in, rows are cards; from it on, a table. An unfolded Fold's inner screen (about 840) and anything wider get the table; a phone (390) gets cards. */
export const TABLE_MIN_WIDTH = 720
export type Layout = 'table' | 'cards'
export const layoutFor = (width: number): Layout => (width >= TABLE_MIN_WIDTH ? 'table' : 'cards')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "11 Nov 2026" from an ISO time (the date in UTC, so the same everywhere); "—" when there is none. */
export function dateWords(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
