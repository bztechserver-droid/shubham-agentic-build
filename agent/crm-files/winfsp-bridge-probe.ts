import { parentPort, workerData } from 'node:worker_threads'
import { createBridgeClient, type BridgeBuffers } from './winfsp-bridge.ts'
import { createFsAnswers } from './winfsp-ops.ts'

// A worker used by the tests (winfsp-fs.test.ts): it does what the drive's worker does, without WinFsp: asks the main thread through the bridge and reports what the answers looked like.
const { bufs, script } = workerData as { bufs: BridgeBuffers; script: string }
const ops = createBridgeClient(parentPort!, bufs, 3000)
// As the drive's worker does for an agent without a spool: no saves, a read-only volume (the 'writes' script keeps them).
if (script !== 'writes') ops.writes = undefined
const answers = createFsAnswers(ops)
const out: Record<string, unknown> = {}
if (script === 'tree') {
  out.root = ops.stat('\\')
  out.missing = ops.stat('\\nope')
  out.list1 = ops.list('\\', null)
  out.listAfter = ops.list('\\', 'b.txt')
  out.sec = answers.getSecurityByName('\\a.txt')
  out.secMissing = answers.getSecurityByName('\\zzz')
  const buf = new Uint8Array(10)
  out.read = answers.read('\\a.txt', 3, buf)
  out.readBytes = Buffer.from(buf.subarray(0, (out.read as { bytes: number }).bytes)).toString()
  const big = new Uint8Array(3 * 1024 * 1024 + 5)
  const r = answers.read('\\big.bin', 100, big)
  let ok = r.bytes > 0
  for (let i = 0; i < r.bytes && ok; i += 4093) if (big[i] !== (((100 + i) * 7 + ((100 + i) >> 8)) & 0xff)) ok = false
  out.bigRead = { status: r.status, bytes: r.bytes, ok }
  out.eof = answers.read('\\a.txt', 999, new Uint8Array(4))
  out.dir = answers.read('\\', 0, new Uint8Array(4))
} else if (script === 'writes') {
  const w = ops.writes!
  const status = (fn: () => unknown) => {
    try {
      fn()
      return 'done'
    } catch (e) {
      return (e as { nt?: number }).nt ?? (e as Error).message
    }
  }
  out.readOnly = answers.readOnly
  out.created = w.create('\\a.txt', false)
  out.wrote = w.write(7, 5, Buffer.from('hello'), false)
  out.big = w.write(7, 0, Buffer.alloc(1024 * 1024, 7), true).written
  out.size = w.setSize(7, 3)
  out.opened = w.open('\\a.txt', true)
  out.can = [w.canDelete(7, '\\a.txt'), w.canDelete(0, '\\x.tmp')]
  out.release = status(() => w.release(7, true))
  out.rename = status(() => w.rename('\\a', '\\b', true))
  out.remove = status(() => w.remove('\\x.tmp'))
  out.denied = status(() => w.open('\\denied', false))
  out.collision = status(() => w.rename('\\a', '\\c', false))
  out.missing = status(() => w.create('\\gone', false))
  out.boom = status(() => w.create('\\boom', false))
  out.tooBig = status(() => w.write(7, 0, Buffer.alloc(1024 * 1024 + 1), false))
} else if (script === 'readonly-writes') {
  out.hasWrites = ops.writes !== undefined
  out.readOnly = answers.readOnly
} else if (script === 'slow') {
  try {
    ops.stat('\\hang')
    out.slow = 'answered'
  } catch (e) {
    out.slow = (e as Error).message
  }
  out.after = ops.stat('\\')
}
parentPort!.postMessage({ type: 'done', out })
