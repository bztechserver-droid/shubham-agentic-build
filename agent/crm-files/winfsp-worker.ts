import { parentPort, workerData } from 'node:worker_threads'
import { createBridgeClient, type BridgeBuffers } from './winfsp-bridge.ts'
import { mountNative } from './winfsp-native.ts'

// o6e65 S9a: the drive's own thread. WinFsp (through koffi) lives here; every question about the CRM goes to the agent's main thread through the blocking bridge (winfsp-bridge.ts).
// Messages TO the main thread: { type: 'ready' } once the letter is served, { type: 'error', message }, { type: 'stopped' }, { type: 'fs', ... } (the bridge's questions), { type: 'log', line }.
// Message FROM it: { type: 'stop' }. When the worker or the whole agent ends, WinFsp takes the drive away with it (an in-process drive has no one to outlive).

const { bufs, letter, dll, label, writable } = workerData as { bufs: BridgeBuffers; letter: string; dll?: string; label?: string; writable?: boolean }
const port = parentPort!
const ops = createBridgeClient(port, bufs)
// A drive whose agent keeps no spool takes no saves: it is read-only (the volume says so to WinFsp).
if (!writable) ops.writes = undefined

mountNative({ letter, ops, dll, label, log: line => port.postMessage({ type: 'log', line }) }).then(
  mount => {
    port.postMessage({ type: 'ready' })
    port.on('message', (m: { type?: string }) => {
      if (m?.type !== 'stop') return
      mount.stop().then(
        () => port.postMessage({ type: 'stopped' }),
        e => port.postMessage({ type: 'error', message: `the drive did not stop cleanly: ${(e as Error).message}` }),
      ).finally(() => setTimeout(() => process.exit(0), 50))
    })
  },
  e => {
    port.postMessage({ type: 'error', message: (e as Error).message })
    setTimeout(() => process.exit(1), 50)
  },
)
