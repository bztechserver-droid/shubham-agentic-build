import { AGENT_API_PREFIX } from './agent-api.ts'

// Order o5dc6 (12 Nov 2026): the Phone app page, the last entry of the menu, for the owner signed in. Shubham downloads the
// Android apps from it: the newest build of Shubham Agentic that passed its checks (mobile/scripts/agentic.mjs writes a build's
// record only after verify passed), and the Hey Chris build its own Update button offers (C:\sac\out\offer.json). The agent
// answers GET /agent-api/phone-apps/ with PhoneAppsAnswer and sends a file only at the `download` address it gave, only while
// that build is still the one offered and its bytes still match the sha256 in its record (agent/agentic/phone-apps.ts).

/** The agent's mount (agent/agentic/phone-apps.ts); the page is at /phone-app (src/app/nav.ts). */
export const PHONE_APPS_PREFIX = '/phone-apps'

export type PhoneAppId = 'agentic' | 'chris'
export const PHONE_APP_IDS: readonly PhoneAppId[] = ['agentic', 'chris']

export interface PhoneAppBuild {
  /** "0.1.0-907667" */
  versionName: string
  /** Android's versionCode; also the build's number in its file name. */
  versionCode: number
  bytes: number
  /** The whole sha256 of the APK, lowercase hex. */
  sha256: string
  /** When it was built (Shubham Agentic) or offered (Hey Chris), ISO; null when not known. */
  at: string | null
  /** The file name it downloads as; null when not known. */
  file: string | null
}

export interface PhoneApp {
  id: PhoneAppId
  name: string
  /** The build to download, or null (and why). */
  build: PhoneAppBuild | null
  why: string | null
  /** The address of exactly this build (its number in it), or null. */
  download: string | null
}

export interface PhoneAppsAnswer {
  apps: PhoneApp[]
}

/** The download address of one build: the number pins the build the page showed, so the file is the one whose sha256 he saw. */
export const downloadPath = (id: PhoneAppId, versionCode: number) => `${AGENT_API_PREFIX}${PHONE_APPS_PREFIX}/${id}/${versionCode}.apk`

const SHA256 = /^[0-9a-f]{64}$/
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
const orNull = (v: unknown, max: number) => v === null || text(v, max)

function readBuild(v: unknown): PhoneAppBuild | null {
  if (!isObject(v)) return null
  const { versionName, versionCode, bytes, sha256, at, file } = v
  if (!text(versionName, 40) || !Number.isSafeInteger(versionCode) || (versionCode as number) <= 0) return null
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0 || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
  if (!orNull(at, 40) || !orNull(file, 200)) return null
  return { versionName: versionName as string, versionCode: versionCode as number, bytes: bytes as number, sha256, at: at as string | null, file: file as string | null }
}

/** The agent's answer, checked; throws for anything else (the page then says it could not read it). */
export function readPhoneApps(v: unknown): PhoneAppsAnswer {
  if (!isObject(v) || !Array.isArray(v.apps) || v.apps.length > PHONE_APP_IDS.length) throw new Error('not a phone apps answer')
  const apps = v.apps.map((a: unknown): PhoneApp => {
    if (!isObject(a) || !PHONE_APP_IDS.includes(a.id as PhoneAppId) || !text(a.name, 60)) throw new Error('not a phone app')
    const build = a.build === null ? null : readBuild(a.build)
    if (a.build !== null && !build) throw new Error('not a build')
    if (!orNull(a.why, 300)) throw new Error('not a reason')
    const id = a.id as PhoneAppId
    // The page links only the address it can name itself: the agent's must be exactly that build's.
    if (build ? a.download !== downloadPath(id, build.versionCode) : a.download !== null) throw new Error('not a download address')
    return { id, name: a.name as string, build, why: (a.why as string | null) ?? null, download: build ? downloadPath(id, build.versionCode) : null }
  })
  return { apps }
}

/** "2.6 MB", "102.3 MB", "640 KB": the way Android counts (1000, not 1024). */
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`
  return `${n} bytes`
}
