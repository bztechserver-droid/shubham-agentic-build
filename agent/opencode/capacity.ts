import os from 'node:os'
import { apiError } from '../api.ts'
export const BACKEND_RESERVATION = 1024 * 1024 * 1024
export const TUI_RESERVATION = 384 * 1024 * 1024
export const FREE_FLOOR = 2 * 1024 * 1024 * 1024
/** Reservations include starts in progress; admission and release are synchronous. */
export function createAdmission(free = () => os.freemem(), limit = 2) {
  const reservations = new Map<string, number>()
  return {
    reserve(id: string, bytes = BACKEND_RESERVATION) {
      if (reservations.has(id)) return
      const backends = [...reservations.keys()].filter(k => !k.endsWith(':tui')).length
      if ((!id.endsWith(':tui') && backends >= limit) || free() - [...reservations.values()].reduce((a, b) => a + b, 0) - bytes < FREE_FLOOR) {
        throw Object.assign(apiError(503, 'OpenCode is at this PC’s capacity. Stop an idle OpenCode chat or close its terminal and try again.'), { code: 'opencode-capacity' })
      }
      reservations.set(id, bytes)
    },
    release(id: string) { reservations.delete(id) },
    count: () => [...reservations.keys()].filter(k => !k.endsWith(':tui')).length,
  }
}
