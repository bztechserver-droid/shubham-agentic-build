import { existsSync } from 'node:fs'
import path from 'node:path'

// F-079: WhatsApp runs in the Chrome already on the PC (nothing downloaded): its own profile, apart from his
// browsing, headless. Edge (Chromium too) is the fallback; Chrome is the one whatsapp-web.js is made for.

/** chrome.exe (else msedge.exe): SAD_WA_CHROME when set, else the usual places. Null when there is none. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.SAD_WA_CHROME) return exists(env.SAD_WA_CHROME) ? env.SAD_WA_CHROME : null
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  return candidates.find(c => exists(c)) ?? null
}
