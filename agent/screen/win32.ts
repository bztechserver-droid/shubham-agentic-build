import { createRequire } from 'node:module'
import os from 'node:os'
import type * as Koffi from 'koffi'
import { cursorImage, type CursorImage } from './cursor.ts'
import type { PlanButtons } from './power.ts'

// The Windows calls behind the app's own screen (F-006), made straight from the agent through
// koffi (no compiler, no helper program). Each is what RustDesk 1.5.0 does on Windows:
//   mouse:    enigo's mouse_move_to / mouse_down / mouse_up / mouse_scroll (libs/enigo/src/win/
//             win_impl.rs:23-235): SendInput, absolute moves over the virtual desktop, 0..65535
//   keys:     rdev's simulate_code (rustdesk-org/rdev@a361d86, src/windows/simulate.rs): the
//             scan code with KEYEVENTF_SCANCODE, extended when it starts 0xE0 or 0xE1; and
//             enigo's keybd_event (win_impl.rs:53-93) for the few keys sent by virtual key
//   pointer:  GetCursorInfo and get_cursor_data (src/platform/windows.rs:207-330), see cursor.ts
//   displays: DXGI adapters and outputs, the same list Desktop Duplication (FFmpeg's ddagrab)
//             numbers its output_idx by
//   other:    the clipboard as Unicode text, the input desktop's name (Winlogon = locked or a
//             UAC prompt), LockWorkStation, and a Yes/No box for "ask to accept"
// The process is made per-monitor DPI aware first, so every coordinate is in real pixels, as
// Desktop Duplication captures them.

export interface Display {
  /** DXGI adapter and output index: ddagrab captures with these. */
  adapter: number
  output: number
  /** E.g. \\.\DISPLAY1 */
  name: string
  x: number
  y: number
  width: number
  height: number
  primary: boolean
  /** Windows' scale for it: 1.5 at 150 %. */
  scale: number
  vendorId: number | null
}

export type Button = 'left' | 'right' | 'middle' | 'back' | 'forward'

export interface Win32 {
  displays(): Display[]
  cursorPos(): { x: number; y: number } | null
  /** The pointer's handle while it shows, else null. */
  cursorHandle(): number | null
  cursorShape(handle: number): CursorImage | null
  /** Absolute, in virtual-desktop pixels (enigo's mouse_move_to). */
  moveTo(x: number, y: number): boolean
  button(b: Button, down: boolean): boolean
  /** In WHEEL_DELTA units (120 a notch): positive y scrolls up, positive x right. */
  wheel(dx: number, dy: number): void
  /** A Windows scan code, 0xE0xx for extended keys (rdev's simulate_code). */
  scanKey(code: number, down: boolean): boolean
  /** A virtual key (enigo's keybd_event): modifiers, lock keys, Pause. */
  vkKey(vk: number, down: boolean): boolean
  /** One UTF-16 unit typed as itself (KEYEVENTF_UNICODE). */
  unicodeKey(unit: number, down: boolean): boolean
  keyState(vk: number): { down: boolean; toggled: boolean }
  clipboardSeq(): number
  readClipboard(): string | null
  writeClipboard(text: string): boolean
  /** The desktop that gets input: 'Default' normally; null when this process may not open it (locked). */
  inputDesktop(): string | null
  lockWorkStation(): boolean
  /** A Yes/No box on this PC's screen; resolves 'timeout' when nobody answers in time. */
  askYesNo(text: string, title: string, timeoutMs: number): Promise<'yes' | 'no' | 'timeout'>
  userName(): string
  /**
   * The display back on if Windows turned it off for being idle (Desktop Duplication sees
   * nothing while it is off): SC_MONITORPOWER on, as RustDesk's blank_screen(false) does
   * (windows.cc:528-538), and the pointer nudged one pixel and back: mouse input, which also
   * ends Modern Standby.
   */
  wake(): void
  /**
   * Holds the system awake (no sleep that cuts the network) and/or the display on, as RustDesk's
   * WakeLock does during an incoming session (windows.rs:3188-3224, connection.rs:6580-6625);
   * both false lets Windows sleep as it likes again. One state for this thread (power.ts).
   */
  holdAwake(system: boolean, display: boolean): void
  /** On mains power (GetSystemPowerStatus); null when Windows can't tell. A desktop PC is on mains. */
  onMains(): boolean | null
  /**
   * What the power button and the lid do while plugged in, on a power plan (the active one when
   * none is named), in Windows' numbers (power.ts › BUTTON_ACTIONS). Null when Windows won't say.
   */
  buttons(scheme?: string): PlanButtons | null
  /** Sets them on that plan, plugged in only, and applies it when it is the active one; false when Windows refused. */
  setButtons(scheme: string, b: { power: number; lid: number }): boolean
  /**
   * Privacy mode (F-012): a black window over every display that screen capture leaves out
   * (WDA_EXCLUDEFROMCAPTURE, coverSupported()), so the people at this PC see black while the
   * picture shows what is under it, as RustDesk's privacy_mode_impl_exclude_from_capture does.
   * It takes no clicks and never the focus. False when Windows refused.
   */
  cover(on: boolean): boolean
  /** A message for a thread's own queue (the keyboard hook's, F-013); false when it has none. */
  postThreadMessage(thread: number, message: number): boolean
  /**
   * The pointer on this PC's own screen, shown or not (MagShowSystemCursor), for privacy mode
   * (F-012). Windows keeps it hidden after this process ends, so whoever hides it shows it again
   * (privacy.ts). Captures still get its shape (GetCursorInfo says showing), so the viewer keeps
   * its pointer. `nudge`: moved a pixel and back after showing it, so it is drawn again at once.
   */
  showPointer(show: boolean, nudge?: boolean): boolean
}

/**
 * Windows 10 2004 (build 19041) and later can keep a window out of screen capture, as RustDesk
 * checks before offering its exclude-from-capture privacy mode (win_exclude_from_capture.rs:7-11).
 */
export function coverSupported(): boolean {
  if (process.platform !== 'win32') return false
  const [major, , build] = os.release().split('.').map(Number)
  return major > 10 || (major === 10 && build >= 19041)
}

export const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,
  PAUSE: 0x13,
  CAPITAL: 0x14,
  LWIN: 0x5b,
  RWIN: 0x5c,
  NUMLOCK: 0x90,
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LMENU: 0xa4,
  RMENU: 0xa5,
} as const

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF = { MOVE: 0x1, LEFTDOWN: 0x2, LEFTUP: 0x4, RIGHTDOWN: 0x8, RIGHTUP: 0x10, MIDDLEDOWN: 0x20, MIDDLEUP: 0x40, XDOWN: 0x80, XUP: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 }
const KEYEVENTF = { EXTENDEDKEY: 0x1, KEYUP: 0x2, UNICODE: 0x4, SCANCODE: 0x8 }
/** dwExtraInfo on everything we inject, as enigo marks its own (ENIGO_INPUT_EXTRA_VALUE). */
const EXTRA = 100
const SM = { XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79 }
const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x2
const HWND_BROADCAST = 0xffff
const WM_SYSCOMMAND = 0x0112
const SC_MONITORPOWER = 0xf170
const ES = { CONTINUOUS: 0x80000000, SYSTEM_REQUIRED: 0x1, DISPLAY_REQUIRED: 0x2 }
const CURSOR_SHOWING = 0x1
const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Guid {
  Data1: number
  Data2: number
  Data3: number
  Data4: ArrayLike<number>
}

/** "7648efa3-dd9c-4e3e-b566-50f929386280" as Windows' GUID struct. */
function guidOf(text: string): Guid {
  const h = text.replace(/[{}-]/g, '')
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + 2 * i, 18 + 2 * i), 16)),
  }
}

function guidText(g: Guid): string {
  const hex = (n: number, width: number) => (n >>> 0).toString(16).padStart(width, '0')
  const d4 = Array.from(g.Data4, b => hex(b, 2)).join('')
  return `${hex(g.Data1, 8)}-${hex(g.Data2, 4)}-${hex(g.Data3, 4)}-${d4.slice(0, 4)}-${d4.slice(4)}`
}

// A power plan's "Power buttons and lid" (powercfg's SUB_BUTTONS, PBUTTONACTION and LIDACTION).
const SUB_BUTTONS = guidOf('4f971e89-eebd-4455-a8de-9e59040e7347')
const POWER_BUTTON = guidOf('7648efa3-dd9c-4e3e-b566-50f929386280')
const LID = guidOf('5ca83367-6e45-459f-a27b-476b1d01c936')
/** The privacy cover's window class and title. */
const COVER_CLASS = 'ShubhamAgenticPrivacyCover'

let loaded: Win32 | null = null
let loadError: string | null = null

/** The Windows calls, loaded once; null (with loadFailure() saying why) off Windows or when koffi can't load. */
export function loadWin32(): Win32 | null {
  if (loaded || loadError) return loaded
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    loadError = 'the app’s own screen needs 64-bit Windows'
    return null
  }
  try {
    loaded = bind(createRequire(import.meta.url)('koffi') as typeof Koffi)
  } catch (e) {
    loadError = `couldn't load the Windows calls (koffi): ${message(e)}`
  }
  return loaded
}

export function loadFailure(): string | null {
  loadWin32()
  return loadError
}

function bind(k: typeof Koffi): Win32 {
  const user32 = k.load('user32.dll')
  const kernel32 = k.load('kernel32.dll')
  const gdi32 = k.load('gdi32.dll')
  const dxgi = k.load('dxgi.dll')
  const shcore = k.load('shcore.dll')
  const advapi32 = k.load('advapi32.dll')

  const POINT = k.struct('POINT', { x: 'int32', y: 'int32' })
  const RECT = k.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  const MOUSEINPUT = k.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
  const KEYBDINPUT = k.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
  const HARDWAREINPUT = k.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
  const INPUT = k.struct('INPUT', { type: 'uint32', u: k.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) })
  k.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'uintptr_t', ptScreenPos: POINT })
  k.struct('ICONINFO', { fIcon: 'int32', xHotspot: 'uint32', yHotspot: 'uint32', hbmMask: 'uintptr_t', hbmColor: 'uintptr_t' })
  const BITMAP = k.struct('BITMAP', { bmType: 'int32', bmWidth: 'int32', bmHeight: 'int32', bmWidthBytes: 'int32', bmPlanes: 'uint16', bmBitsPixel: 'uint16', bmBits: 'void *' })
  k.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: k.array('uint8', 8) })
  k.struct('DXGI_ADAPTER_DESC1', {
    Description: k.array('char16_t', 128, 'String'),
    VendorId: 'uint32',
    DeviceId: 'uint32',
    SubSysId: 'uint32',
    Revision: 'uint32',
    DedicatedVideoMemory: 'uintptr_t',
    DedicatedSystemMemory: 'uintptr_t',
    SharedSystemMemory: 'uintptr_t',
    AdapterLuid: k.struct('LUID', { LowPart: 'uint32', HighPart: 'int32' }),
    Flags: 'uint32',
  })
  k.struct('DXGI_OUTPUT_DESC', { DeviceName: k.array('char16_t', 32, 'String'), DesktopCoordinates: RECT, AttachedToDesktop: 'int32', Rotation: 'uint32', Monitor: 'uintptr_t' })
  if (k.sizeof(INPUT) !== 40) throw new Error(`INPUT is ${k.sizeof(INPUT)} bytes here, expected 40`)

  const SetProcessDpiAwarenessContext = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t value)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 count, INPUT *inputs, int size)')
  const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *pt)')
  const GetCursorInfo = user32.func('int __stdcall GetCursorInfo(_Inout_ CURSORINFO *info)')
  const GetIconInfo = user32.func('int __stdcall GetIconInfo(uintptr_t icon, _Out_ ICONINFO *info)')
  const GetDC = user32.func('uintptr_t __stdcall GetDC(uintptr_t hwnd)')
  const ReleaseDC = user32.func('int __stdcall ReleaseDC(uintptr_t hwnd, uintptr_t dc)')
  const GetKeyState = user32.func('int16 __stdcall GetKeyState(int vk)')
  const MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 mapType)')
  const OpenClipboard = user32.func('int __stdcall OpenClipboard(uintptr_t owner)')
  const CloseClipboard = user32.func('int __stdcall CloseClipboard()')
  const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()')
  const GetClipboardData = user32.func('uintptr_t __stdcall GetClipboardData(uint32 format)')
  const SetClipboardData = user32.func('uintptr_t __stdcall SetClipboardData(uint32 format, uintptr_t mem)')
  const GetClipboardSequenceNumber = user32.func('uint32 __stdcall GetClipboardSequenceNumber()')
  const OpenInputDesktop = user32.func('uintptr_t __stdcall OpenInputDesktop(uint32 flags, int inherit, uint32 access)')
  const GetUserObjectInformationW = user32.func('int __stdcall GetUserObjectInformationW(uintptr_t obj, int index, _Out_ uint8_t *info, uint32 length, _Out_ uint32 *needed)')
  const CloseDesktop = user32.func('int __stdcall CloseDesktop(uintptr_t desk)')
  const LockWorkStation = user32.func('int __stdcall LockWorkStation()')
  const PostMessageW = user32.func('int __stdcall PostMessageW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)')
  const SetThreadExecutionState = kernel32.func('uint32 __stdcall SetThreadExecutionState(uint32 flags)')
  k.struct('SYSTEM_POWER_STATUS', {
    ACLineStatus: 'uint8',
    BatteryFlag: 'uint8',
    BatteryLifePercent: 'uint8',
    SystemStatusFlag: 'uint8',
    BatteryLifeTime: 'uint32',
    BatteryFullLifeTime: 'uint32',
  })
  const GetSystemPowerStatus = kernel32.func('int __stdcall GetSystemPowerStatus(_Out_ SYSTEM_POWER_STATUS *status)')
  const powrprof = k.load('powrprof.dll')
  const PowerGetActiveScheme = powrprof.func('uint32 __stdcall PowerGetActiveScheme(uintptr_t root, _Out_ void **scheme)')
  const PowerSetActiveScheme = powrprof.func('uint32 __stdcall PowerSetActiveScheme(uintptr_t root, GUID *scheme)')
  const PowerReadACValueIndex = powrprof.func('uint32 __stdcall PowerReadACValueIndex(uintptr_t root, GUID *scheme, GUID *subgroup, GUID *setting, _Out_ uint32 *value)')
  const PowerWriteACValueIndex = powrprof.func('uint32 __stdcall PowerWriteACValueIndex(uintptr_t root, GUID *scheme, GUID *subgroup, GUID *setting, uint32 value)')
  const LocalFree = kernel32.func('uintptr_t __stdcall LocalFree(void *mem)')
  // Privacy mode's cover window.
  const WNDCLASSEXW = k.struct('WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: 'void *',
    cbClsExtra: 'int32',
    cbWndExtra: 'int32',
    hInstance: 'uintptr_t',
    hIcon: 'uintptr_t',
    hCursor: 'uintptr_t',
    hbrBackground: 'uintptr_t',
    lpszMenuName: 'str16',
    lpszClassName: 'str16',
    hIconSm: 'uintptr_t',
  })
  k.struct('MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT, lPrivate: 'uint32' })
  const GetModuleHandleW = kernel32.func('uintptr_t __stdcall GetModuleHandleW(str16 name)')
  const GetProcAddress = kernel32.func('void * __stdcall GetProcAddress(uintptr_t module, str name)')
  const GetStockObject = gdi32.func('uintptr_t __stdcall GetStockObject(int kind)')
  const RegisterClassExW = user32.func('uint16 __stdcall RegisterClassExW(WNDCLASSEXW *cls)')
  const CreateWindowExW = user32.func(
    'uintptr_t __stdcall CreateWindowExW(uint32 exStyle, str16 className, str16 title, uint32 style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t instance, void *param)',
  )
  const DestroyWindow = user32.func('int __stdcall DestroyWindow(uintptr_t hwnd)')
  const SetLayeredWindowAttributes = user32.func('int __stdcall SetLayeredWindowAttributes(uintptr_t hwnd, uint32 key, uint8 alpha, uint32 flags)')
  const SetWindowDisplayAffinity = user32.func('int __stdcall SetWindowDisplayAffinity(uintptr_t hwnd, uint32 affinity)')
  const SetWindowPos = user32.func('int __stdcall SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int w, int h, uint32 flags)')
  const PeekMessageW = user32.func('int __stdcall PeekMessageW(_Out_ MSG *msg, uintptr_t hwnd, uint32 min, uint32 max, uint32 remove)')
  const TranslateMessage = user32.func('int __stdcall TranslateMessage(MSG *msg)')
  const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(MSG *msg)')
  const PostThreadMessageW = user32.func('int __stdcall PostThreadMessageW(uint32 thread, uint32 msg, uintptr_t wParam, intptr_t lParam)')
  const magnification = k.load('magnification.dll')
  const MagInitialize = magnification.func('int __stdcall MagInitialize()')
  const MagShowSystemCursor = magnification.func('int __stdcall MagShowSystemCursor(int show)')
  let magReady = false
  // Exported by user32 since Windows XP, not in the SDK headers: a MessageBox that closes by itself.
  const MessageBoxTimeoutW = user32.func('int __stdcall MessageBoxTimeoutW(uintptr_t hwnd, str16 text, str16 caption, uint32 type, uint16 lang, uint32 ms)')
  const GetObjectW = gdi32.func('int __stdcall GetObjectW(uintptr_t obj, int size, _Out_ BITMAP *out)')
  const GetBitmapBits = gdi32.func('int32 __stdcall GetBitmapBits(uintptr_t bitmap, int32 size, _Out_ uint8_t *bits)')
  const GetDIBits = gdi32.func('int __stdcall GetDIBits(uintptr_t dc, uintptr_t bitmap, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32 usage)')
  const DeleteObject = gdi32.func('int __stdcall DeleteObject(uintptr_t obj)')
  const GlobalAlloc = kernel32.func('uintptr_t __stdcall GlobalAlloc(uint32 flags, uintptr_t bytes)')
  const GlobalLock = kernel32.func('void * __stdcall GlobalLock(uintptr_t mem)')
  const GlobalUnlock = kernel32.func('int __stdcall GlobalUnlock(uintptr_t mem)')
  const GlobalSize = kernel32.func('uintptr_t __stdcall GlobalSize(uintptr_t mem)')
  const GlobalFree = kernel32.func('uintptr_t __stdcall GlobalFree(uintptr_t mem)')
  const CreateDXGIFactory1 = dxgi.func('long __stdcall CreateDXGIFactory1(GUID *riid, _Out_ void **factory)')
  const GetDpiForMonitor = shcore.func('long __stdcall GetDpiForMonitor(uintptr_t monitor, int type, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)')
  const GetUserNameW = advapi32.func('int __stdcall GetUserNameW(_Out_ uint8_t *buffer, _Inout_ uint32 *size)')

  // COM: a method is the n-th pointer in the object's vtable.
  const Release = k.proto('uint32 __stdcall ReleaseFn(void *self)')
  const EnumAdapters1 = k.proto('long __stdcall EnumAdapters1Fn(void *self, uint32 index, _Out_ void **adapter)')
  const GetDesc1 = k.proto('long __stdcall GetDesc1Fn(void *self, _Out_ DXGI_ADAPTER_DESC1 *desc)')
  const EnumOutputs = k.proto('long __stdcall EnumOutputsFn(void *self, uint32 index, _Out_ void **output)')
  const OutputGetDesc = k.proto('long __stdcall OutputGetDescFn(void *self, _Out_ DXGI_OUTPUT_DESC *desc)')
  const method = (obj: unknown, index: number) => k.decode(k.decode(obj, 'void *'), index * 8, 'void *')
  const release = (obj: unknown) => k.call(method(obj, 2), Release, obj)

  // Privacy mode's cover: one black window over the whole virtual desktop, kept out of every
  // capture. Its messages are pumped on this thread (the agent's main one) while it shows, so
  // Windows never takes it for hung; it goes when the agent does.
  const WS_POPUP = 0x80000000
  const WS_EX = { TOPMOST: 0x8, TRANSPARENT: 0x20, TOOLWINDOW: 0x80, LAYERED: 0x80000, NOACTIVATE: 0x8000000 }
  const WDA_EXCLUDEFROMCAPTURE = 0x11
  const HWND_TOPMOST = -1
  const SWP = { NOACTIVATE: 0x10, SHOWWINDOW: 0x40 }
  const LWA_ALPHA = 0x2
  const BLACK_BRUSH = 4
  const PM_REMOVE = 1
  let coverClass = false
  let coverHwnd = 0
  let pump: NodeJS.Timeout | null = null

  const placeCover = () =>
    SetWindowPos(
      coverHwnd,
      HWND_TOPMOST,
      GetSystemMetrics(SM.XVIRTUALSCREEN),
      GetSystemMetrics(SM.YVIRTUALSCREEN),
      GetSystemMetrics(SM.CXVIRTUALSCREEN),
      GetSystemMetrics(SM.CYVIRTUALSCREEN),
      SWP.NOACTIVATE | SWP.SHOWWINDOW,
    )

  function showCover(): boolean {
    if (coverHwnd) return true
    const instance = GetModuleHandleW(null)
    if (!coverClass) {
      coverClass =
        RegisterClassExW({
          cbSize: k.sizeof(WNDCLASSEXW),
          style: 0,
          // Painting its class brush is all it does.
          lpfnWndProc: GetProcAddress(GetModuleHandleW('user32.dll'), 'DefWindowProcW'),
          cbClsExtra: 0,
          cbWndExtra: 0,
          hInstance: instance,
          hIcon: 0,
          hCursor: 0,
          hbrBackground: GetStockObject(BLACK_BRUSH),
          lpszMenuName: null,
          lpszClassName: COVER_CLASS,
          hIconSm: 0,
        }) !== 0
      if (!coverClass) return false
    }
    const exStyle = WS_EX.TOPMOST | WS_EX.TRANSPARENT | WS_EX.TOOLWINDOW | WS_EX.LAYERED | WS_EX.NOACTIVATE
    const hwnd = CreateWindowExW(exStyle, COVER_CLASS, COVER_CLASS, WS_POPUP, 0, 0, 1, 1, 0, 0, instance, null)
    if (!hwnd) return false
    // Opaque, and out of every capture; if Windows won't keep it out, no cover at all.
    if (!SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) || !SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
      DestroyWindow(hwnd)
      return false
    }
    coverHwnd = hwnd
    placeCover()
    let ticks = 0
    pump = setInterval(() => {
      const msg = {}
      while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
        TranslateMessage(msg)
        DispatchMessageW(msg)
      }
      // Displays come and go, and a topmost window raised over it goes under again.
      if (++ticks % 40 === 0) placeCover()
    }, 50)
    pump.unref()
    return true
  }

  function hideCover() {
    if (pump) clearInterval(pump)
    pump = null
    if (coverHwnd) DestroyWindow(coverHwnd)
    coverHwnd = 0
  }

  /** The active power plan's GUID; Windows hands it over in memory the caller frees. */
  const activeScheme = (): string | null => {
    const out: unknown[] = [null]
    if (PowerGetActiveScheme(0, out) !== 0 || !out[0]) return null
    try {
      return guidText(k.decode(out[0], 'GUID') as Guid)
    } finally {
      LocalFree(out[0])
    }
  }

  // Before anything measures the screen: real pixels everywhere (-4 = PER_MONITOR_AWARE_V2).
  SetProcessDpiAwarenessContext(-4)

  const sendMouse = (flags: number, data: number, dx: number, dy: number) =>
    SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: EXTRA } } }, 40) === 1
  const sendKey = (flags: number, vk: number, scan: number) =>
    SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan & 0xffff, dwFlags: flags, time: 0, dwExtraInfo: EXTRA } } }, 40) === 1

  // enigo's to_absolute (win_impl.rs:41-51) is ⌊(v − origin) × 65535 / extent⌋, which Windows
  // maps back one pixel short (measured here: a move to where the pointer is drifts it up and
  // left by 1 px). ⌈(v − origin) × 65536 / extent⌉ is the exact inverse: no drift.
  const toAbsolute = (v: number, origin: number, extent: number) => (extent > 0 ? Math.min(65535, Math.max(0, Math.ceil(((v - origin) * 65536) / extent))) : null)

  const moveTo = (x: number, y: number) => {
    const dx = toAbsolute(x, GetSystemMetrics(SM.XVIRTUALSCREEN), GetSystemMetrics(SM.CXVIRTUALSCREEN))
    const dy = toAbsolute(y, GetSystemMetrics(SM.YVIRTUALSCREEN), GetSystemMetrics(SM.CYVIRTUALSCREEN))
    if (dx === null || dy === null) return false
    return sendMouse(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, 0, dx, dy)
  }

  const withClipboard = <T>(fn: () => T): T | null => {
    // Another program may hold it for a moment.
    for (let i = 0; i < 5; i++) {
      if (OpenClipboard(0)) {
        try {
          return fn()
        } finally {
          CloseClipboard()
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return null
  }

  const BUTTON_FLAGS: Record<Button, [number, number, number]> = {
    left: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP, 0],
    right: [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP, 0],
    middle: [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP, 0],
    back: [MOUSEEVENTF.XDOWN, MOUSEEVENTF.XUP, 1], // XBUTTON1
    forward: [MOUSEEVENTF.XDOWN, MOUSEEVENTF.XUP, 2], // XBUTTON2
  }

  return {
    displays() {
      const out: Display[] = []
      const factory: unknown[] = [null]
      // IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}
      const iid = { Data1: 0x770aae78, Data2: 0xf26f, Data3: 0x4dba, Data4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87] }
      if (CreateDXGIFactory1(iid, factory) < 0 || !factory[0]) return out
      try {
        for (let a = 0; a < 16; a++) {
          const adapter: unknown[] = [null]
          const hr = k.call(method(factory[0], 12), EnumAdapters1, factory[0], a, adapter) as number
          if (hr === DXGI_ERROR_NOT_FOUND || hr < 0 || !adapter[0]) break
          try {
            const desc: Record<string, unknown> = {}
            const vendorId = (k.call(method(adapter[0], 10), GetDesc1, adapter[0], desc) as number) >= 0 ? (desc.VendorId as number) : null
            for (let o = 0; o < 16; o++) {
              const output: unknown[] = [null]
              const r = k.call(method(adapter[0], 7), EnumOutputs, adapter[0], o, output) as number
              if (r === DXGI_ERROR_NOT_FOUND || r < 0 || !output[0]) break
              try {
                const d = {} as { DeviceName: string; DesktopCoordinates: { left: number; top: number; right: number; bottom: number }; AttachedToDesktop: number; Monitor: number }
                if ((k.call(method(output[0], 7), OutputGetDesc, output[0], d) as number) < 0 || !d.AttachedToDesktop) continue
                const r2 = d.DesktopCoordinates
                const dpi = [0]
                const dpiY = [0]
                const scale = GetDpiForMonitor(d.Monitor, 0, dpi, dpiY) >= 0 && dpi[0] ? dpi[0] / 96 : 1
                out.push({
                  adapter: a,
                  output: o,
                  name: d.DeviceName,
                  x: r2.left,
                  y: r2.top,
                  width: r2.right - r2.left,
                  height: r2.bottom - r2.top,
                  primary: r2.left === 0 && r2.top === 0,
                  scale,
                  vendorId,
                })
              } finally {
                release(output[0])
              }
            }
          } finally {
            release(adapter[0])
          }
        }
      } finally {
        release(factory[0])
      }
      return out
    },

    cursorPos() {
      const pt = {} as { x: number; y: number }
      return GetCursorPos(pt) ? { x: pt.x, y: pt.y } : null
    },

    cursorHandle() {
      const info = { cbSize: 24, flags: 0, hCursor: 0, ptScreenPos: { x: 0, y: 0 } }
      if (!GetCursorInfo(info) || !(info.flags & CURSOR_SHOWING) || !info.hCursor) return null
      return Number(info.hCursor)
    },

    cursorShape(handle) {
      const ii = {} as { xHotspot: number; yHotspot: number; hbmMask: number; hbmColor: number }
      if (!GetIconInfo(handle, ii)) return null
      try {
        if (!ii.hbmMask) return null
        const bm = {} as { bmWidth: number; bmHeight: number; bmWidthBytes: number; bmPlanes: number; bmBitsPixel: number }
        if (!GetObjectW(ii.hbmMask, k.sizeof(BITMAP), bm) || bm.bmPlanes !== 1 || bm.bmBitsPixel !== 1) return null
        const width = bm.bmWidth
        const height = ii.hbmColor ? bm.bmHeight : bm.bmHeight / 2
        if (width <= 0 || height <= 0 || width > 512 || height > 512) return null
        const mask = Buffer.alloc(bm.bmWidthBytes * bm.bmHeight)
        if (GetBitmapBits(ii.hbmMask, mask.length, mask) !== mask.length) return null
        let bgra: Buffer | null = null
        if (ii.hbmColor) {
          bgra = Buffer.alloc(width * height * 4)
          const info = Buffer.alloc(40 + 1024)
          info.writeUInt32LE(40, 0) // biSize
          info.writeInt32LE(width, 4)
          info.writeInt32LE(-height, 8) // top-down
          info.writeUInt16LE(1, 12) // planes
          info.writeUInt16LE(32, 14) // bit count; compression 0 = BI_RGB
          const dc = GetDC(0)
          try {
            if (!GetDIBits(dc, ii.hbmColor, 0, height, bgra, info, 0)) return null
          } finally {
            ReleaseDC(0, dc)
          }
        }
        return cursorImage({ width, height, mask, maskStride: bm.bmWidthBytes, bgra, hotx: ii.xHotspot, hoty: ii.yHotspot })
      } finally {
        if (ii.hbmColor) DeleteObject(ii.hbmColor)
        if (ii.hbmMask) DeleteObject(ii.hbmMask)
      }
    },

    moveTo,

    button(b, down) {
      const [press, lift, data] = BUTTON_FLAGS[b]
      return sendMouse(down ? press : lift, data, 0, 0)
    },

    wheel(dx, dy) {
      if (dy) sendMouse(MOUSEEVENTF.WHEEL, dy, 0, 0)
      if (dx) sendMouse(MOUSEEVENTF.HWHEEL, dx, 0, 0)
    },

    scanKey(code, down) {
      let flags = KEYEVENTF.SCANCODE
      if (code >> 8 === 0xe0 || code >> 8 === 0xe1) flags |= KEYEVENTF.EXTENDEDKEY
      if (!down) flags |= KEYEVENTF.KEYUP
      return sendKey(flags, 0, code)
    },

    vkKey(vk, down) {
      const scan = MapVirtualKeyW(vk, 0)
      let flags = down ? 0 : KEYEVENTF.KEYUP
      if (scan >> 8 === 0xe0 || scan >> 8 === 0xe1) flags |= KEYEVENTF.EXTENDEDKEY
      return sendKey(flags, vk, scan)
    },

    unicodeKey(unit, down) {
      return sendKey(KEYEVENTF.UNICODE | (down ? 0 : KEYEVENTF.KEYUP), 0, unit)
    },

    keyState(vk) {
      const x = GetKeyState(vk)
      return { down: (x & 0x8000) !== 0, toggled: (x & 1) === 1 }
    },

    clipboardSeq: () => GetClipboardSequenceNumber(),

    readClipboard() {
      return withClipboard(() => {
        const h = GetClipboardData(CF_UNICODETEXT)
        if (!h) return null
        const p = GlobalLock(h)
        if (!p) return null
        try {
          const size = Number(GlobalSize(h))
          const text = Buffer.from(new Uint8Array(k.view(p, size))).toString('utf16le')
          const end = text.indexOf('\0')
          return end < 0 ? text : text.slice(0, end)
        } finally {
          GlobalUnlock(h)
        }
      })
    },

    writeClipboard(text) {
      const bytes = Buffer.from(`${text}\0`, 'utf16le')
      const h = GlobalAlloc(GMEM_MOVEABLE, bytes.length)
      if (!h) return false
      const p = GlobalLock(h)
      if (!p) {
        GlobalFree(h)
        return false
      }
      new Uint8Array(k.view(p, bytes.length)).set(bytes)
      GlobalUnlock(h)
      const ok = withClipboard(() => {
        EmptyClipboard()
        return SetClipboardData(CF_UNICODETEXT, h) !== 0
      })
      // Windows owns the memory once SetClipboardData succeeds.
      if (!ok) GlobalFree(h)
      return ok === true
    },

    inputDesktop() {
      const desk = OpenInputDesktop(0, 0, 0x0001) // DESKTOP_READOBJECTS
      if (!desk) return null
      try {
        const buf = Buffer.alloc(512)
        const needed = [0]
        if (!GetUserObjectInformationW(desk, 2, buf, buf.length, needed)) return null // UOI_NAME
        const name = buf.toString('utf16le')
        return name.slice(0, Math.max(0, name.indexOf('\0')))
      } finally {
        CloseDesktop(desk)
      }
    },

    lockWorkStation: () => LockWorkStation() !== 0,

    wake() {
      // Posted, not sent: a window that doesn't answer can't hold the agent up.
      PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, -1)
      // The pointer one pixel over and straight back, absolute so it lands exactly where it
      // was: real mouse input, which ends Windows' display-off (and Modern Standby) as a
      // person's would; a move of nothing may not count. Where the pointer can't be read (the
      // lock screen), that move of nothing is still worth a try.
      const pt = { x: 0, y: 0 }
      if (GetCursorPos(pt)) {
        const right = GetSystemMetrics(SM.XVIRTUALSCREEN) + GetSystemMetrics(SM.CXVIRTUALSCREEN) - 1
        moveTo(pt.x < right ? pt.x + 1 : pt.x - 1, pt.y)
        moveTo(pt.x, pt.y)
      } else sendMouse(MOUSEEVENTF.MOVE, 0, 0, 0)
      // Without CONTINUOUS: the display's idle timer starts again, and keepAwake's state stays.
      SetThreadExecutionState(ES.DISPLAY_REQUIRED)
    },

    // Per thread: this is the agent's main thread, which lives as long as the agent.
    holdAwake(system, display) {
      // `>>> 0`: JavaScript's | gives a signed number, and 0x80000000 would come out negative.
      SetThreadExecutionState((ES.CONTINUOUS | (system ? ES.SYSTEM_REQUIRED : 0) | (display ? ES.DISPLAY_REQUIRED : 0)) >>> 0)
    },

    onMains() {
      const s = { ACLineStatus: 255 }
      if (!GetSystemPowerStatus(s)) return null
      // 0 battery, 1 mains, 255 unknown.
      return s.ACLineStatus === 1 ? true : s.ACLineStatus === 0 ? false : null
    },

    buttons(scheme) {
      const plan = scheme ?? activeScheme()
      if (!plan) return null
      const power = [0]
      const lid = [0]
      // 0 is ERROR_SUCCESS.
      if (PowerReadACValueIndex(0, guidOf(plan), SUB_BUTTONS, POWER_BUTTON, power) !== 0) return null
      if (PowerReadACValueIndex(0, guidOf(plan), SUB_BUTTONS, LID, lid) !== 0) return null
      return { scheme: plan, power: power[0], lid: lid[0] }
    },

    setButtons(scheme, b) {
      const plan = guidOf(scheme)
      if (PowerWriteACValueIndex(0, plan, SUB_BUTTONS, POWER_BUTTON, b.power) !== 0) return false
      if (PowerWriteACValueIndex(0, plan, SUB_BUTTONS, LID, b.lid) !== 0) return false
      // The active plan takes a change when it is made active again.
      return scheme !== activeScheme() || PowerSetActiveScheme(0, plan) === 0
    },

    cover(on) {
      if (!on) {
        hideCover()
        return true
      }
      return coverSupported() && showCover()
    },

    postThreadMessage: (thread, message) => PostThreadMessageW(thread, message, 0, 0) !== 0,

    showPointer(show, nudge = false) {
      magReady ||= MagInitialize() !== 0
      if (!magReady || !MagShowSystemCursor(show ? 1 : 0)) return false
      if (show && nudge) {
        const pt = { x: 0, y: 0 }
        if (GetCursorPos(pt)) {
          moveTo(pt.x + 1, pt.y)
          moveTo(pt.x, pt.y)
        }
      }
      return true
    },

    askYesNo(text, title, timeoutMs) {
      // MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SYSTEMMODAL | MB_SETFOREGROUND | MB_TOPMOST
      const type = 0x4 | 0x20 | 0x100 | 0x1000 | 0x10000 | 0x40000
      return new Promise(resolve => {
        MessageBoxTimeoutW.async(0, text, title, type, 0, timeoutMs, (err: unknown, res: number) => {
          resolve(err ? 'timeout' : res === 6 ? 'yes' : res === 7 ? 'no' : 'timeout') // IDYES, IDNO; 32000 = timed out
        })
      })
    },

    userName() {
      const buf = Buffer.alloc(514)
      const size = [257]
      if (GetUserNameW(buf, size) && size[0] > 1) return buf.toString('utf16le', 0, (size[0] - 1) * 2)
      return os.userInfo().username
    },
  }
}
