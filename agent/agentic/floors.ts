import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import {
  AGENT_BRIEF_MAX,
  AGENT_EFFORTS,
  AGENT_MODELS,
  FLOOR_PREAMBLE_MAX,
  MAX_AGENTS_PER_FLOOR,
  type AgentEffort,
  type AgentModel,
  type Floor,
  type FloorAgent,
  type FloorPatch,
  type NewAgent,
} from '../../shared/agentic.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-018: floors and their agents (agentic-claude-manager server/lib/floors.js), kept in
// <state>/agent/agentic/floors.json. A floor starts with its boss seated; the page owns the
// chart (it sends the whole agent list back), but not the chat bindings: an agent's sessionId
// is set only here, when its chat is opened, so a page saving a stale copy can't unbind it.

const SESSION_ID_RE = /^[0-9a-zA-Z-]{8,64}$/
const NAME_MAX = 80
const ROLE_MAX = 120
const LIST_MAX = 64

const now = () => new Date().toISOString()
const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback)
const strList = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim().slice(0, 200)))].slice(0, LIST_MAX) : []
const isModel = (v: unknown): v is AgentModel => typeof v === 'string' && (AGENT_MODELS as readonly string[]).includes(v)
const isEffort = (v: unknown): v is AgentEffort => typeof v === 'string' && (AGENT_EFFORTS as readonly string[]).includes(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** F-021: a floor's folder on each of the hub's other PCs: device id to an absolute path. */
const folderMap = (v: unknown): Record<string, string> =>
  isObject(v)
    ? Object.fromEntries(
        Object.entries(v)
          .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '' && e[0].length <= 64)
          .slice(0, LIST_MAX)
          .map(([k, d]) => [k, d.trim().slice(0, 1024)]),
      )
    : {}

const LEAD_MD =
  '# Lead\n\n' +
  'The boss of this floor. Runs the work, does not do the work.\n\n' +
  '- Keeps an accurate picture of every agent and what they are on.\n' +
  '- Decomposes incoming work and hands it to the right owner.\n' +
  '- Owns only the high-leverage calls: sign-offs, conflicts, integration.\n' +
  '- Escalates to the human only for spend, destructive actions, or scope changes.\n'

function hydrateAgent(raw: unknown, index: number): FloorAgent {
  const a = isObject(raw) ? raw : {}
  const name = str(a.name, NAME_MAX).trim()
  return {
    id: typeof a.id === 'string' && a.id ? a.id.slice(0, 64) : randomUUID(),
    name: name || 'Untitled',
    role: str(a.role, ROLE_MAX).trim(),
    isBoss: a.isBoss === true,
    reportsTo: typeof a.reportsTo === 'string' && a.reportsTo ? a.reportsTo : null,
    md: str(a.md, AGENT_BRIEF_MAX),
    sessionId: typeof a.sessionId === 'string' && SESSION_ID_RE.test(a.sessionId) ? a.sessionId : null,
    model: isModel(a.model) ? a.model : '',
    effort: isEffort(a.effort) ? a.effort : '',
    skills: strList(a.skills),
    mcpServers: strList(a.mcpServers),
    x: num(a.x, 80 + (index % 4) * 250),
    y: num(a.y, 240 + Math.floor(index / 4) * 190),
  }
}

/**
 * One boss, no duplicate ids, and a chart that is a tree: a reportsTo that names nobody, or
 * that loops back on itself, goes to the boss. Repaired on every read and write.
 */
function repairAgents(agents: FloorAgent[]): FloorAgent[] {
  const seen = new Set<string>()
  const list = agents.filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true)))
  if (!list.length) return list
  const bossAt = list.findIndex(a => a.isBoss)
  const boss = list[bossAt === -1 ? 0 : bossAt]
  for (const a of list) a.isBoss = a === boss
  boss.reportsTo = null
  const byId = new Map(list.map(a => [a.id, a]))
  for (const a of list) {
    if (a.isBoss) continue
    if (!a.reportsTo || !byId.has(a.reportsTo) || a.reportsTo === a.id) {
      a.reportsTo = boss.id
      continue
    }
    // Walk up; a loop that never reaches the boss is cut here.
    const path = new Set([a.id])
    let up = byId.get(a.reportsTo)
    while (up && !up.isBoss) {
      if (path.has(up.id)) {
        a.reportsTo = boss.id
        break
      }
      path.add(up.id)
      up = up.reportsTo ? byId.get(up.reportsTo) : undefined
    }
  }
  return list
}

function hydrateFloor(raw: unknown): Floor | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const created = typeof raw.createdAt === 'string' ? raw.createdAt : now()
  return {
    id: raw.id,
    name: str(raw.name, NAME_MAX).trim() || 'New floor',
    globalPrompt: str(raw.globalPrompt, FLOOR_PREAMBLE_MAX),
    codeDir: typeof raw.codeDir === 'string' && raw.codeDir.trim() ? raw.codeDir.trim() : null,
    folders: folderMap(raw.folders),
    createdAt: created,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : created,
    agents: repairAgents((Array.isArray(raw.agents) ? raw.agents : []).slice(0, MAX_AGENTS_PER_FLOOR).map(hydrateAgent)),
  }
}

const clone = <T>(v: T): T => structuredClone(v)

export interface FloorStore {
  list(): Floor[]
  get(id: string): Floor | null
  create(name?: string): Floor
  patch(id: string, patch: FloorPatch): Floor
  remove(id: string): Floor | null
  reorder(order: string[]): Floor[]
  /**
   * F-033: an agent moved, keeping its chat: before `before` (another agent there; last when
   * left out) on its own floor, or onto another floor (under that floor's boss; its own floor's
   * chart repaired, a new boss when it was the boss).
   */
  moveAgent(fromFloorId: string, agentId: string, toFloorId: string, before?: string | null): { from: Floor; to: Floor }
  addAgent(floorId: string, req: NewAgent): { floor: Floor; agent: FloorAgent }
  /** Binds (or with null unbinds) an agent's chat. */
  bindSession(floorId: string, agentId: string, sessionId: string | null): Floor
  /** The floor and agent a chat belongs to: how a tool call knows who is calling. */
  bySession(sessionId: string): { floor: Floor; agent: FloorAgent } | null
}

/** Reads `file` (a corrupt one is set aside as .corrupt-<time>, never overwritten) and keeps it written. */
export function createFloorStore(file: string, onChange: () => void = () => {}): FloorStore {
  let floors: Floor[] = load()

  function load(): Floor[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    try {
      const data: unknown = JSON.parse(text)
      const list = isObject(data) && Array.isArray(data.floors) ? data.floors : []
      return list.map(hydrateFloor).filter((f): f is Floor => f !== null)
    } catch {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
      return []
    }
  }

  function save() {
    writeAtomic(file, `${JSON.stringify({ floors }, null, 2)}\n`)
    onChange()
  }

  function find(id: string): Floor {
    const f = floors.find(x => x.id === id)
    if (!f) throw apiError(404, 'No such floor')
    return f
  }

  function agentOf(floor: Floor, agentId: string): FloorAgent {
    const a = floor.agents.find(x => x.id === agentId)
    if (!a) throw apiError(404, 'No such agent on this floor')
    return a
  }

  function uniqueName(floor: Floor, wanted: string, exceptId?: string): boolean {
    const w = wanted.trim().toLowerCase()
    return !floor.agents.some(a => a.id !== exceptId && a.name.trim().toLowerCase() === w)
  }

  return {
    list: () => clone(floors),
    get: id => {
      const f = floors.find(x => x.id === id)
      return f ? clone(f) : null
    },

    create(name) {
      const t = now()
      const floor: Floor = {
        id: randomUUID(),
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, NAME_MAX) : 'New floor',
        globalPrompt: '',
        codeDir: null,
        folders: {},
        createdAt: t,
        updatedAt: t,
        agents: [hydrateAgent({ name: 'Lead', role: 'Orchestrator', isBoss: true, md: LEAD_MD, x: 320, y: 40 }, 0)],
      }
      floors = [floor, ...floors]
      save()
      return clone(floor)
    },

    patch(id, p) {
      const floor = find(id)
      if (p.name !== undefined) {
        if (typeof p.name !== 'string' || !p.name.trim()) throw apiError(400, 'A floor needs a name')
        floor.name = p.name.trim().slice(0, NAME_MAX)
      }
      if (p.globalPrompt !== undefined) {
        if (typeof p.globalPrompt !== 'string') throw apiError(400, 'globalPrompt is text')
        if (p.globalPrompt.length > FLOOR_PREAMBLE_MAX) throw apiError(400, `The preamble is longer than ${FLOOR_PREAMBLE_MAX} characters`)
        floor.globalPrompt = p.globalPrompt
      }
      if (p.codeDir !== undefined) {
        if (p.codeDir !== null && typeof p.codeDir !== 'string') throw apiError(400, 'codeDir is a folder path, or null')
        floor.codeDir = p.codeDir && p.codeDir.trim() ? p.codeDir.trim() : null
      }
      if (p.folderFor !== undefined) {
        const f = p.folderFor
        if (!isObject(f) || typeof f.id !== 'string' || !f.id || (f.dir !== null && typeof f.dir !== 'string')) throw apiError(400, 'folderFor is {id, dir}')
        const folders = { ...floor.folders }
        if (f.dir && f.dir.trim()) folders[f.id] = f.dir.trim()
        else delete folders[f.id]
        floor.folders = folderMap(folders)
      }
      if (p.agents !== undefined) {
        if (!Array.isArray(p.agents)) throw apiError(400, 'agents is a list')
        if (p.agents.length > MAX_AGENTS_PER_FLOOR) throw apiError(400, `At most ${MAX_AGENTS_PER_FLOOR} agents on a floor`)
        const before = new Map(floor.agents.map(a => [a.id, a]))
        // The boss can be removed too: the page marks who takes over (else repairAgents makes
        // it the first agent), and taking the last agent off leaves an empty floor.
        const next = p.agents.map((raw, i) => {
          const a = hydrateAgent(raw, i)
          // The binding is the server's: kept from what was there, never taken from the page.
          a.sessionId = before.get(a.id)?.sessionId ?? null
          return a
        })
        const names = new Set<string>()
        for (const a of next) {
          const n = a.name.trim().toLowerCase()
          if (names.has(n)) throw apiError(400, `Two agents are called "${a.name}"; names are unique on a floor`)
          names.add(n)
        }
        floor.agents = repairAgents(next)
      }
      floor.updatedAt = now()
      save()
      return clone(floor)
    },

    remove(id) {
      const f = floors.find(x => x.id === id)
      if (!f) return null
      floors = floors.filter(x => x !== f)
      save()
      return clone(f)
    },

    reorder(order) {
      const rank = new Map(order.map((id, i) => [id, i]))
      floors = [...floors].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      save()
      return clone(floors)
    },

    moveAgent(fromFloorId, agentId, toFloorId, before) {
      const from = find(fromFloorId)
      const to = find(toFloorId)
      const agent = agentOf(from, agentId)
      if (to !== from) {
        if (to.agents.length >= MAX_AGENTS_PER_FLOOR) throw apiError(409, `${to.name} already has ${MAX_AGENTS_PER_FLOOR} agents, the most it can`)
        if (!uniqueName(to, agent.name)) throw apiError(409, `There is already an agent called "${agent.name}" on ${to.name}; rename one first`)
      }
      from.agents = from.agents.filter(a => a !== agent)
      if (to !== from) {
        // Its reports stay behind, moving up to its manager there; there, it joins under the boss.
        for (const a of from.agents) if (a.reportsTo === agent.id) a.reportsTo = agent.reportsTo
        const wasBoss = agent.isBoss
        agent.isBoss = to.agents.length === 0
        agent.reportsTo = to.agents.find(a => a.isBoss)?.id ?? null
        if (wasBoss && from.agents.length) {
          const next = from.agents.find(a => a.reportsTo === agent.id || a.reportsTo === null) ?? from.agents[0]
          next.isBoss = true
        }
        from.agents = repairAgents(from.agents)
        from.updatedAt = now()
      }
      const at = before ? to.agents.findIndex(a => a.id === before) : -1
      to.agents.splice(at === -1 ? to.agents.length : at, 0, agent)
      to.agents = repairAgents(to.agents)
      to.updatedAt = now()
      save()
      return { from: clone(from), to: clone(to) }
    },

    addAgent(floorId, req) {
      const floor = find(floorId)
      if (floor.agents.length >= MAX_AGENTS_PER_FLOOR) throw apiError(409, `This floor already has ${MAX_AGENTS_PER_FLOOR} agents, the most it can`)
      let name = typeof req.name === 'string' ? req.name.trim().slice(0, NAME_MAX) : ''
      if (!name) {
        let n = Math.max(1, floor.agents.length)
        do name = `Agent ${n++}`
        while (!uniqueName(floor, name))
      } else if (!uniqueName(floor, name)) throw apiError(409, `There is already an agent called "${name}" on this floor`)
      const boss = floor.agents.find(a => a.isBoss)
      let reportsTo = boss?.id ?? null
      if (typeof req.reportsTo === 'string' && req.reportsTo.trim()) {
        const want = req.reportsTo.trim().toLowerCase()
        const manager = floor.agents.find(a => a.id === req.reportsTo || a.name.trim().toLowerCase() === want)
        if (!manager) throw apiError(400, `No agent called "${req.reportsTo}" to report to`)
        reportsTo = manager.id
      }
      if (req.model !== undefined && !isModel(req.model)) throw apiError(400, 'model is opus, sonnet or haiku')
      if (req.effort !== undefined && !isEffort(req.effort)) throw apiError(400, 'effort is low, medium, high, xhigh or max')
      const index = floor.agents.length
      // The first agent on an empty floor is its boss, at the boss's desk; the rest go in rows below.
      const desk = index === 0 ? { x: 320, y: 40 } : { x: 80 + ((index - 1) % 4) * 250, y: 240 + Math.floor((index - 1) / 4) * 190 }
      const agent = hydrateAgent(
        {
          name,
          role: req.role ?? '',
          md: typeof req.md === 'string' && req.md.trim() ? req.md : `# ${name}\n\nWhat this agent is for.\n`,
          reportsTo,
          model: req.model ?? '',
          effort: req.effort ?? '',
          ...desk,
        },
        index,
      )
      floor.agents = repairAgents([...floor.agents, agent])
      floor.updatedAt = now()
      save()
      return { floor: clone(floor), agent: clone(agent) }
    },

    bindSession(floorId, agentId, sessionId) {
      const floor = find(floorId)
      const agent = agentOf(floor, agentId)
      if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) throw apiError(400, 'Not a chat id')
      if (sessionId !== null) {
        // One chat, one agent: taking it from whoever had it.
        for (const f of floors) for (const a of f.agents) if (a.sessionId === sessionId && a !== agent) a.sessionId = null
      }
      agent.sessionId = sessionId
      floor.updatedAt = now()
      save()
      return clone(floor)
    },

    bySession(sessionId) {
      for (const floor of floors) {
        const agent = floor.agents.find(a => a.sessionId === sessionId)
        if (agent) return { floor: clone(floor), agent: clone(agent) }
      }
      return null
    },
  }
}
