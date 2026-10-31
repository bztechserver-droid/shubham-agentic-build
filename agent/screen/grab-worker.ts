import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import type * as Koffi from 'koffi'
import { createGrabState, GRAB, LET_GO } from './grab-keys.ts'

// The keyboard hook's own thread (F-013), as RustDesk runs rdev::grab on one (src/keyboard.rs:
// 612-686). A low-level hook has to answer each key within Windows' timeout, or Windows drops it
// without a word, so it lives here, blocked in GetMessageW, away from the agent's busy main
// thread. The main thread steers it with thread messages (grab.ts): GRAB hooks the keyboard and
// takes the window in front as the one that asked, LET_GO unhooks, WM_QUIT ends the thread. Keys
// go back with postMessage, which needs nothing of this thread's own event loop.

const { codes, injected } = workerData as { codes: [number, string][]; injected?: 'skip' | 'only' }
const byScan = new Map(codes)
const k = createRequire(import.meta.url)('koffi') as typeof Koffi
const user32 = k.load('user32.dll')
const kernel32 = k.load('kernel32.dll')

const KBDLLHOOKSTRUCT = k.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
const POINT = k.struct('POINT', { x: 'int32', y: 'int32' })
k.struct('MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT, lPrivate: 'uint32' })
const HookProc = k.proto('intptr_t __stdcall HookProc(int code, uintptr_t wParam, void *info)')
const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int id, HookProc *proc, uintptr_t module, uint32 thread)')
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hook)')
const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t wParam, void *info)')
const GetMessageW = user32.func('int __stdcall GetMessageW(_Out_ MSG *msg, uintptr_t hwnd, uint32 min, uint32 max)')
const PeekMessageW = user32.func('int __stdcall PeekMessageW(_Out_ MSG *msg, uintptr_t hwnd, uint32 min, uint32 max, uint32 remove)')
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
const GetModuleHandleW = kernel32.func('uintptr_t __stdcall GetModuleHandleW(str16 name)')

const WH_KEYBOARD_LL = 13
const WM_USER = 0x400
const port = parentPort!

let hook: unknown = null
let owner = 0
let state = createGrabState(byScan, { injected })

const proc = k.register(
  (code: number, wParam: number, info: unknown) => {
    if (code >= 0 && hook) {
      const e = k.decode(info, KBDLLHOOKSTRUCT) as { vkCode: number; scanCode: number; flags: number }
      const d = state.decide({ vk: e.vkCode, scan: e.scanCode, flags: e.flags }, GetForegroundWindow() === owner)
      if (d.send) port.postMessage({ t: 'key', ...d.send })
      if (d.lost) port.postMessage({ t: 'lost' })
      if (d.take) return 1
    }
    return CallNextHookEx(null, code, wParam, info)
  },
  k.pointer(HookProc),
)

const msg: { message?: number } = {}
// The thread's message queue is made when it first asks for a message: before anything is posted to it.
PeekMessageW(msg, 0, WM_USER, WM_USER, 0)
port.postMessage({ t: 'ready', tid: GetCurrentThreadId() })
for (;;) {
  // Blocks; the hook is called from inside it. 0: WM_QUIT, -1: an error.
  if (GetMessageW(msg, 0, 0, 0) <= 0) break
  if (msg.message === GRAB) {
    owner = GetForegroundWindow()
    state = createGrabState(byScan, { injected })
    hook ??= SetWindowsHookExW(WH_KEYBOARD_LL, proc, GetModuleHandleW(null), 0)
    port.postMessage({ t: 'grabbing', ok: Boolean(hook) })
  } else if (msg.message === LET_GO) {
    if (hook) UnhookWindowsHookEx(hook)
    hook = null
    owner = 0
  }
}
if (hook) UnhookWindowsHookEx(hook)
k.unregister(proc)
