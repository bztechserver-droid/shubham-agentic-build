import { createRequire } from 'node:module'
import type * as Koffi from 'koffi'

// This Windows account's own environment variables (F-007): HKCU\Environment, read and written
// as System Properties › Environment Variables does it, then announced to every window with
// WM_SETTINGCHANGE "Environment", so Explorer, and every program started from it afterwards,
// gets the new value. Programs already running keep the environment they started with. Through
// koffi, so the value never appears on a command line (setx or reg.exe would put it there).

export interface UserEnv {
  /** The value as stored (not expanded), or null when it isn't set. */
  get(name: string): string | null
  set(name: string, value: string): void
  /** False when it wasn't set. */
  remove(name: string): boolean
  /** WM_SETTINGCHANGE "Environment" to every top-level window, on a worker thread; resolves when sent. */
  announce(): Promise<void>
}

const HKEY_CURRENT_USER = -0x7fffffff // (HKEY)(LONG)0x80000001, sign-extended
const REG_SZ = 1
const RRF_RT_REG_SZ = 0x2
const RRF_RT_REG_EXPAND_SZ = 0x4
const RRF_NOEXPAND = 0x10000000
const ERROR_SUCCESS = 0
const ERROR_FILE_NOT_FOUND = 2
const HWND_BROADCAST = 0xffff
const WM_SETTINGCHANGE = 0x001a
const SMTO_ABORTIFHUNG = 0x0002
const ANNOUNCE_TIMEOUT_MS = 5000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let loadError: string | null = null

/**
 * The user's environment under HKCU\<key> ("Environment"; tests use a scratch key of their
 * own). Null off Windows or when koffi can't load, with userEnvFailure() saying why.
 */
export function loadUserEnv(key = 'Environment'): UserEnv | null {
  if (process.platform !== 'win32') {
    loadError = "only Windows keeps a user environment the app can set"
    return null
  }
  try {
    return bind(createRequire(import.meta.url)('koffi') as typeof Koffi, key)
  } catch (e) {
    loadError = `couldn't load the Windows calls (koffi): ${message(e)}`
    return null
  }
}

export function userEnvFailure(): string | null {
  return loadError
}

function bind(k: typeof Koffi, key: string): UserEnv {
  const advapi32 = k.load('advapi32.dll')
  const user32 = k.load('user32.dll')
  const RegGetValueW = advapi32.func(
    'long __stdcall RegGetValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32 flags, _Out_ uint32 *type, void *data, _Inout_ uint32 *size)',
  )
  const RegSetKeyValueW = advapi32.func(
    'long __stdcall RegSetKeyValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32 type, const void *data, uint32 size)',
  )
  const RegDeleteKeyValueW = advapi32.func('long __stdcall RegDeleteKeyValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value)')
  const SendMessageTimeoutW = user32.func(
    'intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, const char16_t *lParam, uint32 flags, uint32 timeout, uintptr_t *result)',
  )
  const flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND
  const fail = (what: string, code: number) => new Error(`${what} HKCU\\${key}: Windows error ${code}`)

  return {
    get(name) {
      // Twice: once for the size, once for the text (the size can only grow in between by a
      // writer racing us, and then the second call says so and we give up).
      const size = [0]
      let code = RegGetValueW(HKEY_CURRENT_USER, key, name, flags, [0], null, size) as number
      if (code === ERROR_FILE_NOT_FOUND) return null
      if (code !== ERROR_SUCCESS) throw fail(`couldn't read ${name} from`, code)
      const data = Buffer.alloc(size[0])
      code = RegGetValueW(HKEY_CURRENT_USER, key, name, flags, [0], data, size) as number
      if (code === ERROR_FILE_NOT_FOUND) return null
      if (code !== ERROR_SUCCESS) throw fail(`couldn't read ${name} from`, code)
      return data.subarray(0, size[0]).toString('utf16le').replace(/\0+$/, '')
    },
    set(name, value) {
      const data = Buffer.from(`${value}\0`, 'utf16le')
      const code = RegSetKeyValueW(HKEY_CURRENT_USER, key, name, REG_SZ, data, data.length) as number
      if (code !== ERROR_SUCCESS) throw fail(`couldn't write ${name} to`, code)
    },
    remove(name) {
      const code = RegDeleteKeyValueW(HKEY_CURRENT_USER, key, name) as number
      if (code === ERROR_FILE_NOT_FOUND) return false
      if (code !== ERROR_SUCCESS) throw fail(`couldn't remove ${name} from`, code)
      return true
    },
    announce() {
      // A window that doesn't answer holds a broadcast up to the timeout (hung ones are
      // skipped), so it goes from a worker thread, never the agent's own.
      return new Promise(resolve => {
        SendMessageTimeoutW.async(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 'Environment', SMTO_ABORTIFHUNG, ANNOUNCE_TIMEOUT_MS, null, () => resolve())
      })
    },
  }
}
