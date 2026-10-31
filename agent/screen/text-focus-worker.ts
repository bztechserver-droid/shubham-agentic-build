import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import type * as Koffi from 'koffi'
import { editableOf, UIA, type FocusedInfo } from './text-focus.ts'

// UI Automation on its own thread (F-017, text-focus.ts): every `intervalMs`, and when the main
// thread says a click just landed, is the element with the keyboard focus a text box? Only a
// change goes back. COM is called through its vtables: IUIAutomation (CoCreateInstance of
// CUIAutomation) and the IUIAutomationElement it hands back, in UIAutomationClient.h's order.

const { intervalMs } = workerData as { intervalMs: number }
const port = parentPort!
const k = createRequire(import.meta.url)('koffi') as typeof Koffi
const ole32 = k.load('ole32.dll')
const oleaut32 = k.load('oleaut32.dll')

// Named types, for the declarations below.
k.struct('GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: k.array('uint8', 8) })
// VARIANT: the type, three reserved words, then the value (a VARIANT_BOOL at offset 8); 24 bytes.
k.struct('VARIANT', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', boolVal: 'int16', rest: k.array('uint8', 14) })
const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 coinit)')
const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(GUID *clsid, void *outer, uint32 ctx, GUID *iid, _Out_ void **out)')
const VariantClear = oleaut32.func('int32 __stdcall VariantClear(VARIANT *v)')
const GetFocusedElement = k.proto('int32 __stdcall GetFocusedElement(void *self, _Out_ void **element)')
const GetInt = k.proto('int32 __stdcall GetInt(void *self, _Out_ int32 *value)')
const GetPropertyValue = k.proto('int32 __stdcall GetPropertyValue(void *self, int32 id, _Out_ VARIANT *value)')
const Release = k.proto('uint32 __stdcall Release(void *self)')

// Vtable slots: IUnknown's Release is 2; IUIAutomation::GetFocusedElement 8;
// IUIAutomationElement::GetCurrentPropertyValue 10 and get_CurrentControlType 21.
const SLOT = { release: 2, focused: 8, property: 10, controlType: 21 }
const VT_BOOL = 11
const COINIT_MULTITHREADED = 0
const CLSCTX_INPROC_SERVER = 1

const guid = (s: string) => {
  const h = s.replace(/-/g, '')
  return { d1: parseInt(h.slice(0, 8), 16), d2: parseInt(h.slice(8, 12), 16), d3: parseInt(h.slice(12, 16), 16), d4: [...Buffer.from(h.slice(16), 'hex')] }
}
const CLSID_CUIAutomation = guid('ff48dba4-60ef-4201-aa87-54103eef594e')
const IID_IUIAutomation = guid('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee')

/** Calls slot `i` of a COM object's vtable, the object first. */
const call = (obj: unknown, i: number, proto: Koffi.IKoffiCType, ...args: unknown[]) =>
  k.call(k.decode(k.decode(obj, 'void *'), i * 8, 'void *'), proto, obj, ...args) as number

CoInitializeEx(null, COINIT_MULTITHREADED)
const made: unknown[] = [null]
const hr = CoCreateInstance(CLSID_CUIAutomation, null, CLSCTX_INPROC_SERVER, IID_IUIAutomation, made)
const uia = made[0]

function bool(element: unknown, property: number): boolean {
  const v: { vt?: number; boolVal?: number } = {}
  if (call(element, SLOT.property, GetPropertyValue, property, v) !== 0) return false
  const yes = v.vt === VT_BOOL && v.boolVal !== 0
  VariantClear(v)
  return yes
}

function focused(): FocusedInfo | null {
  const out: unknown[] = [null]
  if (call(uia, SLOT.focused, GetFocusedElement, out) !== 0 || !out[0]) return null
  const element = out[0]
  try {
    const type = [0]
    return {
      controlType: call(element, SLOT.controlType, GetInt, type) === 0 ? type[0] : 0,
      valuePattern: bool(element, UIA.IsValuePatternAvailable),
      readOnly: bool(element, UIA.ValueIsReadOnly),
    }
  } finally {
    call(element, SLOT.release, Release)
  }
}

let last: boolean | null = null
function check() {
  let editable = false
  try {
    editable = editableOf(focused())
  } catch {
    // Nothing focused that UI Automation can reach (the lock screen, say): no text box.
  }
  if (editable === last) return
  last = editable
  port.postMessage({ t: 'focus', editable })
}

if (hr !== 0 || !uia) {
  port.postMessage({ t: 'error', message: `UI Automation isn't available (0x${(hr >>> 0).toString(16)})` })
} else {
  port.on('message', (m: { t?: string }) => {
    // After a click the focus moves a moment later: look then, and once more.
    if (m.t === 'check') for (const ms of [120, 400]) setTimeout(check, ms)
  })
  setInterval(check, intervalMs)
  check()
}
