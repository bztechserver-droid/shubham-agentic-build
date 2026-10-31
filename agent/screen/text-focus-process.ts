import { runUia } from './text-focus-uia.ts'

// UI Automation in a process of its own (F-017, F-058; text-focus.ts starts this with fork and speaks to
// it over the IPC channel). A native failure here ends this process and nothing else: the agent
// starts it again. If the agent itself goes away, so does this.
process.on('disconnect', () => process.exit(0))
runUia({
  intervalMs: Number(process.argv[2]) || 300,
  post: m => void process.send?.(m),
  onMessage: listener => void process.on('message', listener),
})
