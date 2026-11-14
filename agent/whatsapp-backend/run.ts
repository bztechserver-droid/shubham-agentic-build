// Order o8d7e (F-223): starts WhatsApp's backend on this Server. Port: WA_BACKEND_PORT (50000 or higher); state: WA_BACKEND_DIR.
// Run: node agent/whatsapp-backend/run.ts (Node 24). Stops on Ctrl+C with Chrome closed properly; the login is kept.
import path from 'node:path'
import { createLogger } from '../log.ts'
import { startBackend } from './server.ts'

const port = Number(process.env.WA_BACKEND_PORT ?? 50070)
const dir = process.env.WA_BACKEND_DIR ?? path.join(process.env.LOCALAPPDATA ?? '.', 'shubham-agentic', 'whatsapp-backend')
const log = createLogger({ console: true, dir: null })

const backend = await startBackend({ port, dir, log })
const stop = () => {
  backend.close().then(() => process.exit(0), () => process.exit(1))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
