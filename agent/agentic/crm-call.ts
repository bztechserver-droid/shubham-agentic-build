import { apiError } from '../api.ts'
import { CrmNotSignedIn, type CrmProxy } from './crmproxy.ts'

// One call to the CRM through the CRM proxy (crmproxy.ts), shared by every crm_ tool. The proxy attaches this PC's CRM sign-in and its CSRF pair;
// neither is ever seen here or in an answer. The CRM's own words come back when it refuses, in plain English, and a failure never leaves a
// stack, a URL or a cookie in what a chat reads.

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface CrmCallOptions {
  proxy: Pick<CrmProxy, 'request'>
  /** What to add when the CRM answers with a server error to a change: where the person can see whether it went through. */
  afterServerError: string
}

export function createCrmCall(o: CrmCallOptions) {
  return async function crm<T>(method: string, sub: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await o.proxy.request(method, sub, body === undefined ? {} : { json: body })
    } catch (e) {
      if (e instanceof CrmNotSignedIn) throw apiError(409, 'The CRM is not signed in on this PC: sign in from the CRM page, or Devices. Nothing was changed.')
      if (isObject(e) && typeof e.status === 'number') throw e
      throw apiError(502, "The CRM can't be reached right now. Nothing was changed.")
    }
    const data: unknown = await res.json().catch(() => null)
    if (res.ok) return data as T
    const said = isObject(data) && typeof data.error === 'string' ? data.error : null
    if (res.status === 401) throw apiError(409, 'The CRM sign-in on this PC has ended: sign in again from the CRM page, or Devices. Nothing was changed.')
    if (res.status === 403) throw apiError(403, `The CRM refused: ${said ?? 'this person may not do that there'}`)
    if (res.status === 404) throw apiError(404, said ?? 'The CRM does not have that')
    if (res.status === 400 || res.status === 422) throw apiError(400, `The CRM refused: ${said ?? 'it did not accept that'}`)
    throw apiError(502, `The CRM answered ${res.status}${said ? `: ${said}` : ''}.${method.toUpperCase() === 'GET' ? '' : ` ${o.afterServerError}`}`)
  }
}
