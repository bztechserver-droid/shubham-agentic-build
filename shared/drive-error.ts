import type { DriveErrorCode } from './drive.ts'

// F-097: what the drive's calls throw, in the page and in its tests (no page code in it).
export class DriveError extends Error {
  /** The store's own code, or: 'offline' (it can't be reached), 'aborted' (cancelled here), 'other'. */
  readonly code: DriveErrorCode | 'offline' | 'aborted' | 'other'
  readonly status: number
  /** An upload's real received count, said by a wrong-offset answer. */
  readonly received?: number
  constructor(message: string, code: DriveError['code'] = 'other', status = 0, received?: number) {
    super(message)
    this.code = code
    this.status = status
    this.received = received
  }
}
