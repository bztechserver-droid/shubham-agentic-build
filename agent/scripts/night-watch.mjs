// The night watch (F-058/F-081): a small process OUTSIDE the app that looks at the app every few seconds and keeps a log.
//   node night-watch.mjs [--state <state root>] [--apply]
// It does three things, and nothing else:
//   1. LOG: every 5 minutes one `sample` line (is the app up, memory, the build running and the newest published
//      one, each chat's state), and an `event` line for every stop, start, crash, restart and chat end it can
//      tell from the app's own logs, with its cause (update, stop request, internal error, crash or kill, idle
//      reaper, memory low). File: <state>/agent/agentic/night-log.jsonl (JSON lines, 5 MB then it starts a new one).
//   2. OPEN-CHATS LIST: an app that was started the old way (Start.cmd, not the guard) never writes
//      <state>/agent/agentic/open-chats.json, so an update under the guard would reopen none of its chats. While
//      the guard says the running agent is not its own ("adopted"), this writes that list from the app's own
//      answer every 5 s, in the format the app reads at its start (agent/agentic/recover.ts). Once the agent is the
//      guard's, the agent keeps the list itself and this stops.
//   3. APPLY (F-081), only with --apply, and only when <state>/agent/agentic/auto-update.json says so: presses what the
//      Build page's Update now presses, when no chat is mid-answer and no publish is running, once an hour at most.
//      Without --apply it never does it.
// Plain node, no packages: it runs from <state>/nightwatch/, a copy that no update of the app touches.
// One at a time: it holds a loopback port; a second one exits at once.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const LOCK_PORT = 21231
const SNAPSHOT_EVERY_MS = 5000
const SAMPLE_EVERY_MS = 5 * 60_000
const LOG_MAX_BYTES = 5 * 1024 * 1024
const APPLY_GAP_MS = 60 * 60_000

// ---- pure parts (tested in night-watch.test.ts)

/** What an agent log or guard log line means for the night log, or null when it is not worth a line. */
export function classifyLine(line) {
  const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) +(\w+) +(.*)$/.exec(line)
  if (!m) return null
  const [, at, level, text] = m
  const ev = (kind, cause, extra = {}) => ({ at, kind, cause, text: text.slice(0, 240), ...extra })
  if (/^stopping: updating to the newer build/.test(text)) return ev('app-stop', 'update')
  if (/^stopping: (Ctrl\+C|SIGTERM|Ctrl\+Break|asked by the parent process|the parent process went away)/.test(text)) return ev('app-stop', 'stop-request')
  if (/^stopping: internal error/.test(text)) return ev('app-stop', 'internal-error')
  if (/^stopping:/.test(text)) return ev('app-stop', 'other')
  if (/^hub .*version|^member .*version/.test(text) || /^ready: the app/.test(text)) return ev('app-start', null)
  if (/exit-watchdog/.test(text)) return ev('app-stop', 'hung-exit')
  if (/while stopping: .* didn't finish/.test(text)) return ev('app-stop-slow', 'hung-exit')
  const chat = /chat ([0-9a-f]{8}): (.*)$/.exec(text)
  if (chat) {
    if (/stopped after .* unwatched and idle/.test(chat[2])) return ev('chat-stop', 'idle-reaper', { chat: chat[1] })
    if (/^ended/.test(chat[2])) return ev('chat-end', null, { chat: chat[1] })
    if (/^(started|resumed) in/.test(chat[2])) return ev('chat-start', null, { chat: chat[1] })
    return null
  }
  if (/^recovery:/.test(text)) return ev('recovery', null)
  if (/(^| )agent: (exited|not answering|started|answering again|ending pid)/.test(text)) return ev('guard', /exited \(code 75\)/.test(text) ? 'update' : /not answering|ending pid/.test(text) ? 'hung' : null)
  if (/internal error/.test(text) || level === 'ERROR') return ev('error', 'internal-error')
  return null
}

/** The open-chats list (agent/agentic/recover.ts format) from the app's /agentic/floors answer. */
export function snapshotChats(answer) {
  const live = answer && typeof answer.live === 'object' && answer.live ? answer.live : {}
  const out = []
  for (const floor of Array.isArray(answer?.floors) ? answer.floors : []) {
    for (const agent of Array.isArray(floor.agents) ? floor.agents : []) {
      const state = agent.sessionId ? live[agent.sessionId] : undefined
      if (state === 'idle' || state === 'running' || state === 'question') out.push({ sessionId: agent.sessionId, floorId: floor.id, agentId: agent.id, state })
    }
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * Whether to write `next` over `prev`. Never while the app says it is stopping (its chats are being closed and would
 * read as none), and a list that has become empty is only believed the second time in a row.
 */
export function snapshotDecision({ prev, next, stopping, emptyBefore }) {
  const same = JSON.stringify(prev) === JSON.stringify(next)
  if (stopping || same) return { write: false, emptyNow: false }
  if (next.length === 0 && prev.length > 0) return { write: emptyBefore, emptyNow: !emptyBefore }
  return { write: true, emptyNow: false }
}

/** F-081: may a newer build be applied now? Returns { apply } or { skip: why }. */
export function applyDecision({ file, update, publishState, states, lastAppliedAt, now, healthy }) {
  if (!file || file.autoApplyWhenQuiet !== true) return { skip: null }
  if (!healthy) return { skip: 'the app is not healthy' }
  if (!update || update.state !== 'available' || !update.available) return { skip: 'no newer build' }
  if (publishState === 'running') return { skip: 'a publish is running' }
  if (states.some(s => s === 'running' || s === 'question')) return { skip: 'a chat is mid-answer' }
  if (lastAppliedAt && now - lastAppliedAt < APPLY_GAP_MS) return { skip: 'applied less than 60 min ago' }
  return { apply: true }
}

// ---- the running part

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const iso = () => new Date().toISOString()

function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const dayStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

async function main() {
  const state = path.resolve(arg('state') ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'shubham-agentic'))
  const buildRoot = arg('build')
  const apply = flag('apply')
  const agentic = path.join(state, 'agent', 'agentic')
  const logsDir = path.join(state, 'agent', 'logs')
  const nightLog = path.join(agentic, 'night-log.jsonl')
  const listFile = path.join(agentic, 'open-chats.json')
  const autoFile = path.join(agentic, 'auto-update.json')
  const apiPort = Number(process.env.SAD_API_PORT) || 21221
  const uiPort = Number(process.env.SAD_UI_PORT) || 5173
  const guardPort = Number(process.env.SAD_GUARD_PORT) || 21228
  const token = () => {
    try {
      return readFileSync(path.join(state, 'agent', 'api-token'), 'utf8').trim()
    } catch {
      return ''
    }
  }

  // One at a time.
  const lock = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      lock.once('error', reject)
      lock.listen({ port: Number(process.env.SAD_NIGHTWATCH_PORT) || LOCK_PORT, host: '127.0.0.1', exclusive: true }, resolve)
    })
  } catch {
    process.exit(3)
  }

  try {
    mkdirSync(path.join(state, 'nightwatch'), { recursive: true })
    writeFileSync(path.join(state, 'nightwatch', 'watch.pid'), String(process.pid))
  } catch {
    // Only for the remover.
  }

  const note = (obj, file = nightLog) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.${Date.now()}.old`)
      appendFileSync(file, JSON.stringify({ t: iso(), ...obj }) + '\n')
    } catch {
      // The log is a convenience; the watch goes on.
    }
  }

  const get = async (port, p, ms = 3000, useToken = false) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(ms), cache: 'no-store', headers: useToken ? { 'x-sad-token': token() } : {} })
      const text = await res.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        // Not JSON.
      }
      return { status: res.status, body }
    } catch {
      return null
    }
  }

  // ---- log tails: what the app and the guard said since last time
  const offsets = new Map()
  function newLines(file) {
    if (!existsSync(file)) return []
    const size = statSync(file).size
    let from = offsets.get(file)
    if (from === undefined) {
      // The first look reads nothing old.
      offsets.set(file, size)
      return []
    }
    if (size < from) from = 0
    if (size === from) return []
    const fd = openSync(file, 'r')
    try {
      const len = Math.min(size - from, 2 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, from)
      offsets.set(file, from + len)
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean)
    } finally {
      closeSync(fd)
    }
  }
  let lastStoppingAt = 0
  function tailEvents() {
    for (const [name, prefix] of [['agent', 'agent'], ['guard', 'guard']]) {
      for (const line of newLines(path.join(logsDir, `${prefix}-${dayStamp()}.log`))) {
        const e = classifyLine(line)
        if (!e) continue
        if (e.kind === 'app-stop' || e.kind === 'app-stop-slow') lastStoppingAt = Date.now()
        note({ kind: 'event', source: name, ...e })
      }
    }
  }
  const stoppingRecently = () => Date.now() - lastStoppingAt < 3 * 60_000

  // ---- the open-chats list
  let emptyBefore = false
  let lastWritten = readJson(listFile, { chats: [] }).chats ?? []
  async function snapshot(guard) {
    // Only for an agent the guard did not start: its own does it itself.
    if (!guard || guard.agent?.adopted !== true) return
    const r = await get(apiPort, '/agent-api/agentic/floors', 3000, true)
    if (!r || r.status !== 200 || !r.body) return
    const next = snapshotChats(r.body)
    const d = snapshotDecision({ prev: lastWritten, next, stopping: stoppingRecently(), emptyBefore })
    emptyBefore = d.emptyNow
    if (!d.write) return
    atomicWrite(listFile, JSON.stringify({ v: 1, savedAt: iso(), chats: next }))
    lastWritten = next
    note({ kind: 'open-chats-list', chats: next.length, states: next.map(c => c.state) })
  }

  // ---- the sample
  function memory() {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$o = Get-CimInstance Win32_OperatingSystem; '{0},{1},{2}' -f $o.FreePhysicalMemory, $o.FreeVirtualMemory, $o.TotalVirtualMemorySize"], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const [freePhys, freeVirt, totalVirt] = String(r.stdout ?? '').trim().split(',').map(n => Math.round(Number(n) / 1024))
    return { freePhysMB: freePhys || null, freeCommitMB: freeVirt || null, commitLimitMB: totalVirt || null }
  }
  let lastAgentPid = null
  let lastMem = null
  async function sample(guard) {
    const api = await get(apiPort, '/agent-api/health')
    const page = await get(uiPort, '/')
    const info = await get(apiPort, '/agent-api/build/info', 4000, true)
    const floors = await get(apiPort, '/agent-api/agentic/floors', 4000, true)
    const names = {}
    for (const f of floors?.body?.floors ?? []) for (const a of f.agents ?? []) if (a.sessionId) names[a.sessionId] = `${f.name} / ${a.name}`
    const chats = Object.entries(floors?.body?.live ?? {}).map(([sid, st]) => ({ chat: sid.slice(0, 8), who: names[sid] ?? '?', state: st }))
    lastMem = memory()
    const agentPid = guard?.agent?.pid ?? null
    if (lastAgentPid !== null && agentPid !== null && agentPid !== lastAgentPid && !stoppingRecently()) {
      note({ kind: 'event', source: 'watch', cause: 'crash-or-kill', text: `the agent's process changed (${lastAgentPid} -> ${agentPid}) with no "stopping" line in its log`, lowMemory: (lastMem.freeCommitMB ?? 1e9) < 1500 })
    }
    if (agentPid !== null) lastAgentPid = agentPid
    const running = (() => {
      try {
        return buildRoot ? JSON.parse(readFileSync(path.join(buildRoot, 'RELEASE.json'), 'utf8')).version : null
      } catch {
        return null
      }
    })()
    note({
      kind: 'sample',
      app: { api: api?.status === 200, page: page?.status === 200, guard: guard ? { agent: guard.agent?.state, adopted: guard.agent?.adopted, restarts: guard.agent?.restarts, pid: guard.guard?.pid, keeper: guard.keeper?.state ?? null } : 'no guard' },
      memory: lastMem,
      build: { running: info?.body?.current?.version ?? running, onDisk: running, newest: info?.body?.publish?.published?.version ?? info?.body?.update?.available?.version ?? null, update: info?.body?.update?.state ?? null, publish: info?.body?.publish?.state ?? null },
      chats,
    })
    if (api?.status !== 200) note({ kind: 'event', source: 'watch', cause: 'app-down', text: 'the app\'s API did not answer' })
  }

  // ---- F-081: apply a newer build when quiet (only with --apply)
  let lastApplied = readJson(autoFile, {})?.lastApplied?.at ? Date.parse(readJson(autoFile, {}).lastApplied.at) : 0
  async function maybeApply() {
    if (!apply) return
    const file = readJson(autoFile, null)
    const info = (await get(apiPort, '/agent-api/build/info', 4000, true))?.body
    const floors = (await get(apiPort, '/agent-api/agentic/floors', 4000, true))?.body
    const healthy = (await get(apiPort, '/agent-api/health'))?.status === 200
    const d = applyDecision({ file, update: info?.update, publishState: info?.publish?.state, states: Object.values(floors?.live ?? {}), lastAppliedAt: lastApplied, now: Date.now(), healthy })
    if (d.skip !== undefined && d.skip !== null) {
      const f = readJson(autoFile, {})
      if (f.lastSkipped?.why !== d.skip) {
        atomicWrite(autoFile, JSON.stringify({ ...f, lastSkipped: { at: iso(), why: d.skip } }, null, 2))
        note({ kind: 'apply-skipped', why: d.skip })
      }
      return
    }
    if (!d.apply) return
    const again = readJson(autoFile, null)
    if (again?.autoApplyWhenQuiet !== true) return
    const res = await fetch(`http://127.0.0.1:${apiPort}/agent-api/build/update`, { method: 'POST', headers: { 'x-sad-token': token(), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) }).catch(() => null)
    const f = readJson(autoFile, {})
    lastApplied = Date.now()
    atomicWrite(autoFile, JSON.stringify({ ...f, lastApplied: { at: iso(), from: info?.current?.version ?? null, to: info?.update?.available?.version ?? null, note: res?.ok ? '' : `the app answered ${res?.status ?? 'nothing'}` } }, null, 2))
    note({ kind: 'applied', from: info?.current?.version, to: info?.update?.available?.version, ok: !!res?.ok })
  }

  note({ kind: 'watch-start', pid: process.pid, mode: apply ? 'apply allowed (if the switch is on)' : 'log only', state })
  tailEvents() // sets the offsets
  let nextSample = 0
  for (;;) {
    try {
      const guard = (await get(guardPort, '/status'))?.body ?? null
      tailEvents()
      await snapshot(guard)
      if (Date.now() >= nextSample) {
        nextSample = Date.now() + SAMPLE_EVERY_MS
        await sample(guard)
        await maybeApply()
      }
    } catch (e) {
      note({ kind: 'watch-error', error: e instanceof Error ? e.message : String(e) })
    }
    await sleep(SNAPSHOT_EVERY_MS)
  }
}

if (import.meta.main) await main()
