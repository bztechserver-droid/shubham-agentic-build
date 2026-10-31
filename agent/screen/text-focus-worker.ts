import { parentPort, workerData } from 'node:worker_threads'
import { runUia } from './text-focus-uia.ts'

// UI Automation on a thread of the agent: the old way (F-017), now only with SAD_TEXT_FOCUS=worker. The
// asking is text-focus-uia.ts; the default is text-focus-process.ts, a process of its own, because koffi
// can end the whole process it runs in with a failure no try/catch sees (F-058).
const port = parentPort!
runUia({
  intervalMs: (workerData as { intervalMs: number }).intervalMs,
  post: m => port.postMessage(m),
  onMessage: listener => void port.on('message', listener),
})
