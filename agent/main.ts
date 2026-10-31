import type net from 'node:net'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { duplexPair, type Duplex } from 'node:stream'
import { AGENT_API_PREFIX, type AgentSettings, type AgentState, type DeviceInfo, type JoinState, type ScreenVia } from '../shared/agent-api.ts'
import { agenticOff, createAgentic } from './agentic/index.ts'
import type { LinkPeer } from './agentic/roam.ts'
import { findTranscript } from './agentic/transcripts.ts'
import { apiError, startApi, type Api, type ApiActions, type ApiMount } from './api.ts'
import { createBuild, findDevDir, type Build } from './build.ts'
import { createBridge } from './claude/bridge.ts'
import { CrmError } from './claude/crm.ts'
import { createFailover } from './claude/failover.ts'
import { CHECK_EVERY_MS, createClaudeSubscription, TOKEN_VAR } from './claude/index.ts'
import { startRowWatch } from './claude/rowwatch.ts'
import { loadUserEnv } from './claude/userenv.ts'
import { loadConfig, loadOrCreateApiToken, updateConfig, type Config } from './config.ts'
import { answerPush, type HubSideOptions } from './connect.ts'
import { createDeviceStore, type HubBundle } from './devices.ts'
import { createDiscoveryClient, startDiscoveryAnswer, type DiscoveryClient } from './discovery.ts'
import { externalServers } from './hub/external-servers.ts'
import { startServers, type Servers } from './hub/rustdesk-server.ts'
import { loadOrCreateIdentity } from './link/identity.ts'
import type { Control, Mux, OpenMeta, StreamUser } from './link/mux.ts'
import { listenTls } from './link/tls.ts'
import { createHubLinks, createMemberLinks, type HubLinks, type MemberLinks } from './links.ts'
import { closeLog, initLog, log as rootLog, type Logger } from './log.ts'
import { inCidr, localSubnets, parseHostPort, tailnetAddress } from './net.ts'
import { createPairingHub, normalizeCode, startJoin, type Join, type PairingHub } from './pairing.ts'
import { startRegistration, type Registration } from './rendezvous/hbbs.ts'
import { createTunnels, directAnswers, findRustdesk, getRustdeskId, launchRustdesk, rustdeskHandler } from './rustdesk.ts'
import { createSavedPasswords } from './saved-passwords.ts'
import { createAppScreen } from './screen/index.ts'
import { startUiServer, type UiServer } from './ui-server.ts'

// The device agent (agent/SPEC.md): `npm run agent [-- --role hub|member]`.
//   hub:    supervises hbbs/hbbr, registers with hbbs, listens for members on its LAN and
//           Tailscale addresses, answers hbbs's pushes, pairs new PCs, answers LAN discovery.
//   member: keeps one link to its hub (direct, over Tailscale, through hbbs, or through hbbr,
//           as its How to connect setting allows), joins a hub,
//           looks for hubs on the LAN while the Devices page is open (not paired yet), or for
//           its own hub when every path to it failed (its LAN address may have changed).
// Both: the local API for the app, RustDesk screens tunnelled over the link (Mode 1), the
// app's own screen for the other PC's viewer (F-006, agent/screen/: no RustDesk needed), and
// Claude on this PC on the subscription the CRM gives the person signed in here (F-007,
// agent/claude/; SAD_CRM_URL for another CRM).
// Test-only env: SAD_TEST_SKIP_DIRECT=1 leaves out the direct probe (the e2e's hub-lan step);
// SAD_TEST_NO_RUSTDESK=1 never runs RustDesk.exe (Open screen answers the tunnel's port);
// SAD_LOG_LEVEL=debug logs the detail too. The app's own screen has its own (screen/index.ts).

export const VERSION = '0.1.0'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const IDLE_JOIN: JoinState = { status: 'idle', hubAddress: null, sas: null, error: null }
/** F-014: who is controlling, in the notice and on This PC, when it is this PC's own page from another device. */
const OWN_PAGE = "Another device on this PC's page"
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/
/** F-028: Tailscale's addresses (100.64.0.0/10), and this PC itself. */
const isTailnetAddress = (a: string) => {
  const ip = a.replace(/^::ffff:/, '')
  return inCidr(ip, '100.64.0.0/10') || ip === '127.0.0.1' || ip === '::1'
}

export interface Agent {
  state(): AgentState
  /** The API's port (the configured one, or the one picked for port 0). */
  apiPort: number
  stop(): Promise<void>
}

/** F-020: what the entry adds: more of the API (the build's), and Dev's folder on this PC. */
export interface AgentExtras {
  mounts?: ApiMount[]
  /** On the hub, a floor with no folder of its own works in Dev: the build is how Dev is edited. */
  devDir?: string | null
  /** False: the Agents section is off here (Dev beside the build, which runs the chats). On when left out. */
  agents?: boolean
}

export async function startAgent(config: Config, log: Logger = rootLog, extras: AgentExtras = {}): Promise<Agent> {
  const { paths, ports, role } = config
  const testNoRustdesk = process.env.SAD_TEST_NO_RUSTDESK === '1'
  const skipDirect = process.env.SAD_TEST_SKIP_DIRECT === '1'
  if (testNoRustdesk) log.warn('SAD_TEST_NO_RUSTDESK=1: RustDesk.exe is never run (test mode)')
  if (skipDirect) log.warn('SAD_TEST_SKIP_DIRECT=1: the direct probe is skipped (test mode)')

  const identity = await loadOrCreateIdentity(paths.identity, m => log.info(m))
  const token = loadOrCreateApiToken(paths.root)
  const devices = createDeviceStore(paths.devices)
  let route = config.route
  const subnets = () => localSubnets({ lanAddress: config.lanAddress })
  const lanAddress = () => subnets()[0]?.address ?? null
  const tailnet = () => tailnetAddress()
  const exe = testNoRustdesk ? null : findRustdesk()
  const rustdeskId = exe ? await getRustdeskId(exe) : null
  log.info(`${role} ${config.name} (${identity.id}), version ${VERSION}; LAN ${lanAddress() ?? 'none yet'}; Tailscale ${tailnet() ?? 'not running'}; RustDesk ${exe ? `${rustdeskId ?? 'ID unknown'} at ${exe}` : 'not found'}`)

  let api: Api | null = null
  const changed = () => api?.changed()
  const timers: NodeJS.Timeout[] = []
  const every = (ms: number, fn: () => void) => timers.push(setInterval(fn, ms))

  // Mode 1: either end serves 'rustdesk' streams from its own direct-access port, and either
  // end may open a screen on the other. F-006: either end also serves 'screen' streams, its
  // own screen through the app, with no RustDesk on either side.
  const tunnels = createTunnels({ log: log.child('rustdesk') })
  // What the other end was last told (announceScreens).
  let announced = ''
  let stayReachable = config.stayReachable
  const appScreen = createAppScreen({
    paths,
    hostname: config.name,
    reachable: stayReachable,
    log: log.child('screen'),
    onChange: () => {
      changed()
      announceScreens()
    },
  })
  const onOpen = {
    rustdesk: rustdeskHandler({ port: config.rustdeskDirectPort, lan: lanAddress, log: log.child('rustdesk') }),
    screen: appScreen.handler,
    // F-021: the Agents section's streams between the hub's PCs (agentic/roam.ts).
    agentic: (meta: OpenMeta) => {
      if (!agentic) throw new Error('the Agents section is off on this PC')
      return agentic.serve(meta)
    },
  }
  /** F-021: a link, as the Agents section uses it: 'agentic' streams on it. */
  const linkPeer = (mux: Mux, id: string, name: string): LinkPeer => ({ id, name, token: mux, open: meta => mux.open('agentic', meta) })
  let screen = false
  const hello = (): Control => ({ t: 'hello', id: identity.id, name: config.name, role, version: VERSION, rustdeskId, screen, appScreen: appScreen.status().ready })
  const claude = createClaudeSubscription({ paths, deviceId: identity.id, log: log.child('claude'), onChange: () => changed() })
  // F-008: other PCs' passwords remembered for Control (only as H1, never handed out).
  const saved = createSavedPasswords(paths.savedPasswords, log.child('saved'))
  // F-018: the Agentic Workflow section (floors, agents and their Claude chats), at /agentic.
  // Each chat starts on the CLAUDE_CODE_OAUTH_TOKEN this account has now (F-007 keeps it there).
  const userEnv = loadUserEnv()
  // Tests (e2e step 11): a pretend claude, and a scratch Claude folder for its conversations
  // and ~/.claude.json, so the real ones are never touched.
  const testClaudeHome = process.env.SAD_TEST_CLAUDE_HOME || null
  const agentic = extras.agents === false ? null : createAgentic({
    dir: path.join(paths.agent, 'agentic'),
    defaultCodeDir: role === 'hub' && extras.devDir ? extras.devDir : undefined,
    claude: process.env.SAD_TEST_CLAUDE || undefined,
    projectsDir: testClaudeHome ? path.join(testClaudeHome, 'projects') : undefined,
    claudeJson: testClaudeHome ? path.join(testClaudeHome, '.claude.json') : undefined,
    apiUrl: () => `http://127.0.0.1:${api?.port ?? ports.api}${AGENT_API_PREFIX}`,
    log: log.child('agentic'),
    // F-058: under the guard, the chats that were open when the app last stopped come back.
    resumeChats: process.env.SAD_RESUME_CHATS === '1',
    token: () => {
      try {
        return userEnv?.get(TOKEN_VAR) || null
      } catch {
        return null
      }
    },
    // F-021: one session used from the hub's PCs in turn; the hub keeps the floors.
    team: {
      self: () => ({ id: identity.id, name: config.name }),
      role: () => role,
      hub: () => {
        const h = devices.hub()
        if (role !== 'member' || !h) return null
        const mux = member?.links.mux() ?? null
        return { id: h.id, name: h.name, link: mux ? linkPeer(mux, h.id, h.name) : null }
      },
      member: id => {
        const mux = hub?.links.mux(id) ?? null
        const m = devices.member(id)
        return mux && m ? linkPeer(mux, id, m.name) : null
      },
    },
  })

  // Claude subscription failover (agent/claude/failover.ts): when the weekly limit of the Claude subscription is used up, the
  // person is moved to the office's other one in the CRM and the chats that hit the limit carry on there. Only chats on this
  // PC can be restarted; without the Agents section the switch is still made, only no chat is restarted.
  const projectsDir = testClaudeHome ? path.join(testClaudeHome, 'projects') : undefined
  const chatBridge = agentic ? createBridge({ agentic: () => agentic, find: sid => findTranscript(sid, projectsDir), log: log.child('failover') }) : null
  const failover = createFailover({ claude, bridge: () => chatBridge, log: log.child('failover') })
  const rowWatch = agentic
    ? startRowWatch({
        chats: () => agentic.chats.live().map(c => ({ sessionId: c.sessionId, name: agentic.floors.bySession(c.sessionId)?.agent.name ?? c.sessionId.slice(0, 8), startedAt: c.startedAt })),
        find: sid => findTranscript(sid, projectsDir),
        onLimit: e => failover.limitHit(e),
        onMoved: id => failover.chatMoved(id),
        log: log.child('failover'),
      })
    : null

  let hub: { servers: Servers; pairing: PairingHub; links: HubLinks; stop: () => Promise<void> } | null = null
  let member: { links: MemberLinks; discovery: DiscoveryClient } | null = null
  let join: Join | null = null
  let joinSeq = 0
  let joinState: JoinState = IDLE_JOIN
  // A member's LAN discovery runs while the Devices page is open and it has no hub (the Join
  // dialog's list), or while it has lost its hub (where is it now?).
  let pageOpen = false
  let seekingHub = false

  if (role === 'hub') hub = await startHub()
  else member = startMember()

  async function checkScreen() {
    const now = await directAnswers(config.rustdeskDirectPort, lanAddress())
    if (appScreen.recheck()) log.info(`the app's own screen: ${appScreen.status().reason ?? 'ready'}`)
    if (now !== screen) log.info(`RustDesk direct access on port ${config.rustdeskDirectPort} ${now ? 'answers' : 'does not answer'}`)
    screen = now
    announceScreens()
    changed()
  }

  // The other end's Control button follows both: RustDesk's direct port, and the app's own screen.
  function announceScreens() {
    const status = { t: 'status', screen, appScreen: appScreen.status().ready }
    const key = JSON.stringify(status)
    if (key === announced) return
    announced = key
    hub?.links.broadcast(status)
    member?.links.send(status)
  }

  // ---- the hub

  async function startHub() {
    // startServers reports its first states before it returns: hold onServers until all is set up.
    let started = false
    // F-058: under the guard (SAD_RUSTDESK_EXTERNAL=1) hbbs and hbbr are the keeper's, a process of
    // its own, so they go on when this agent dies; this only reads their state. Without it, as before.
    const serverOptions = {
      log: log.child('rustdesk-server'),
      onChange: () => {
        if (started) onServers()
        changed()
      },
    }
    const servers: Servers = process.env.SAD_RUSTDESK_EXTERNAL === '1' ? externalServers(config, serverOptions) : startServers(config, serverOptions)
    const lanNow = () => {
      const lan = lanAddress()
      return lan ? { address: lan, peer: `${lan}:${ports.peer}`, hbbs: `${lan}:${ports.hbbs}`, hbbr: `${lan}:${ports.hbbr}` } : null
    }
    // Declared before anything that reads their addresses (boundListener is below).
    const lanListener = boundListener('LAN', lanAddress, false)
    const tailnetListener = boundListener('Tailscale', tailnet, true)
    const bundle = (): HubBundle => {
      const lan = lanNow()
      if (!lan) throw apiError(409, 'This PC has no LAN address yet, so no other PC can reach it')
      return {
        id: identity.id,
        name: config.name,
        spkiSha256: identity.spkiSha256.toString('hex'),
        lan: { peer: lan.peer, hbbs: lan.hbbs, hbbr: lan.hbbr },
        public: { hbbs: `${config.publicHost}:${ports.hbbs}`, hbbr: `${config.publicHost}:${ports.hbbr}` },
        tailnet: tailnetListener.address(),
        licenceKey: servers.licenceKey(),
      }
    }
    const bundleOrNull = () => {
      try {
        return bundle()
      } catch {
        return null
      }
    }
    const pairing = createPairingHub({
      devices,
      bundle,
      addresses: () => {
        const lan = lanNow()
        const ts = tailnetListener.address()
        return [...(lan ? [lan.peer] : []), ...(ts ? [ts] : [])]
      },
      onChange: changed,
      log: log.child('pairing'),
    })
    const links = createHubLinks({
      devices,
      pairing,
      hello: () => ({ ...hello(), hub: bundleOrNull() }),
      subnets,
      onOpen,
      onChange: changed,
      log: log.child('links'),
    })

    // Members reach the hub on its LAN address and on its Tailscale address (never 0.0.0.0,
    // which Christopher's remote gate would share), each rebound when its address changes.
    function boundListener(what: string, address: () => string | null, viaTailnet: boolean) {
      let server: net.Server | null = null
      let at: string | null = null
      let binding = false
      return {
        /** 'ip:port' while listening, else null. */
        address: () => (at ? `${at}:${ports.peer}` : null),
        async update() {
          const now = address()
          if (binding || now === at) return
          binding = true
          try {
            if (server) {
              server.close()
              server = null
              at = null
              log.info(`stopped listening for members on the old ${what} address`)
            }
            if (!now) return
            server = await listenTls(
              now,
              ports.peer,
              identity,
              peer => links.accept(peer, { kind: 'direct', address: `${peer.tls.remoteAddress}:${peer.tls.remotePort}`, tailnet: viaTailnet }),
              { log: m => log.child('tls').debug(m) },
            )
            at = now
            log.info(`listening for members on ${now}:${ports.peer} (${what})`)
          } catch (e) {
            log.error(`cannot listen for members on ${now}:${ports.peer} (${what}): ${message(e)}; trying again in 10 s`)
          } finally {
            binding = false
          }
        },
        close: () => server?.close(),
      }
    }
    const relisten = () => Promise.all([lanListener.update(), tailnetListener.update()])

    const hubSide: HubSideOptions = {
      identity: { id: identity.id, keyPem: identity.keyPem, certPem: identity.certPem },
      version: VERSION,
      lan: lanAddress,
      ports,
      licenceKey: () => servers.licenceKey(),
      verifyPeer: (id, spki) => devices.allowed(id, spki) !== null,
      accept: (peer, via) => links.accept(peer, { kind: 'relay', ...via }),
      log: log.child('connect'),
    }

    // Registered with hbbs from the LAN address, so hbbs sees the hub inside --mask. Started
    // again when hbbs (re)starts, so it knows the hub at once rather than within 12 s.
    let registration: Registration | null = null
    let registeredFrom: string | null = null
    let hbbsPid: number | null = null
    function register(force = false) {
      const at = lanAddress()
      const hbbs = servers.status().find(s => s.name === 'hbbs')
      if (!at || hbbs?.state !== 'running') return
      if (!force && registration && registeredFrom === at) return
      registration?.stop()
      registeredFrom = at
      const hbbsLog = log.child('hbbs')
      registration = startRegistration({
        hbbs: `${at}:${ports.hbbs}`,
        bindAddress: at,
        id: identity.id,
        uuid: identity.uuid,
        pk: identity.spkiSha256,
        onPush: (...push) => answerPush(hubSide, ...push),
        relayAllow: [`${at}:${ports.hbbr}`, `${config.publicHost}:${ports.hbbr}`],
        // A paired member's last address keeps a slot free, whoever else is pushing.
        trusted: ip => links.knownIp(ip),
        log: m => hbbsLog.info(m),
      })
    }

    // Members learn the hub's new details (LAN address, hbbs key) over their links.
    let lastBundle = ''
    function shareBundle() {
      const now = JSON.stringify(bundleOrNull())
      if (now === lastBundle) return
      const first = lastBundle === ''
      lastBundle = now
      if (!first) links.broadcast({ t: 'hub', hub: JSON.parse(now) as unknown })
    }

    function onServers() {
      const hbbs = servers.status().find(s => s.name === 'hbbs')
      if (hbbs?.state === 'running' && hbbs.pid !== hbbsPid) {
        hbbsPid = hbbs.pid
        register(true)
      }
      shareBundle()
    }

    const discovery = await startDiscoveryAnswer({
      port: ports.discovery,
      answer: () => {
        const lan = lanNow()
        return lan ? { id: identity.id, name: config.name, peer: lan.peer } : null
      },
      subnets,
      log: log.child('discovery'),
    }).catch((e: unknown) => {
      log.warn(`discovery: cannot listen on UDP ${ports.discovery}: ${message(e)}; new PCs must type the hub's address`)
      return null
    })

    started = true
    onServers()
    await relisten()
    every(10_000, () => {
      void relisten()
      register()
      shareBundle()
    })

    return {
      servers,
      pairing,
      links,
      async stop() {
        pairing.stop()
        links.stop('the hub is stopping')
        registration?.stop()
        lanListener.close()
        tailnetListener.close()
        await discovery?.close()
        await servers.stop()
      },
    }
  }

  // ---- a member

  function startMember() {
    const discovery = createDiscoveryClient({ port: ports.discovery, subnets, onChange: changed, log: log.child('discovery') })
    const links = createMemberLinks({
      identity,
      devices,
      hello,
      route: () => route,
      skipDirect,
      subnets,
      tailnet,
      version: VERSION,
      onOpen,
      // Where the pinned hub's ID answered on the LAN: tried with its stored address.
      lanPeers: () => {
        const id = devices.hub()?.id
        return id ? discovery.addresses(id) : []
      },
      seekHub: on => {
        seekingHub = on
        updateDiscovery(discovery)
      },
      onChange: changed,
      log: log.child('link'),
    })
    return { links, discovery }
  }

  function updateDiscovery(discovery: DiscoveryClient | undefined = member?.discovery) {
    if (!discovery) return
    if (devices.hub() ? seekingHub : pageOpen) discovery.start()
    else discovery.stop()
  }

  // The Devices page is open while a WebSocket client is connected.
  function onClients(count: number) {
    pageOpen = count > 0
    updateDiscovery()
  }

  // ---- state and actions

  function state(): AgentState {
    const lan = subnets()[0] ?? null
    const own: DeviceInfo | null = member?.links.device() ?? null
    return {
      self: {
        id: identity.id,
        name: config.name,
        role,
        lanAddress: lan?.address ?? null,
        lanSubnet: lan?.cidr ?? null,
        tailnetAddress: tailnet(),
        rustdeskId,
        version: VERSION,
        paired: role === 'hub' || devices.hub() !== null,
        canOpenScreen: screen,
        canOpenAppScreen: appScreen.status().ready,
        savedPassword: saved.ways(identity.id),
      },
      servers: hub ? hub.servers.status() : null,
      devices: (hub ? hub.links.devices() : own ? [own] : []).map(d => ({ ...d, savedPassword: saved.ways(d.id) })),
      pairing: hub ? hub.pairing.state() : null,
      join: member ? joinState : null,
      discovered: member && !devices.hub() ? member.discovery.list() : [],
      settings: { route, stayReachable },
      appScreen: appScreen.status(),
      claude: claude.status(),
      updatedAt: new Date().toISOString(),
    }
  }

  const needHub = () => {
    if (!hub) throw apiError(409, 'Only the hub does that; this PC is a member')
    return hub
  }
  const needMember = () => {
    if (!member) throw apiError(409, 'This PC is the hub; members join it')
    return member
  }
  // The live link to a device, for its screen.
  const muxOf = (id: string) => (hub ? hub.links.mux(id) : devices.hub()?.id === id ? (member?.links.mux() ?? null) : null)
  const known = (id: string) => (hub ? devices.member(id) !== null : devices.hub()?.id === id)
  // F-014: Control and Remember me also take this PC's own ID, for its page opened elsewhere.
  const knownOrOwn = (id: string) => id === identity.id || known(id)

  // F-014: this PC's own screen, for its own page opened on another device (the phone, through
  // the remote gate: it has no agent to link from). There is no link to go over: the page's pipe
  // gets one end of an in-process pair, and the other end goes to the same handler a link's
  // stream of that kind reaches, so the login, the password and the rest are as for another PC.
  async function ownScreen(via: ScreenVia): Promise<Duplex> {
    let serve: StreamUser
    try {
      serve = await onOpen[via === 'app' ? 'screen' : 'rustdesk']({ from: { id: identity.id, name: OWN_PAGE } })
    } catch (e) {
      throw apiError(502, `This PC couldn't open its screen: ${message(e)}`)
    }
    const [page, host] = duplexPair()
    // Either end gone takes the other along (the page's pipe closing, or the session ending).
    page.once('close', () => host.destroy())
    host.once('close', () => page.destroy())
    serve(host)
    return page
  }

  const actions: ApiActions = {
    state,
    startPairing: () => needHub().pairing.start(),
    cancelPairing: () => needHub().pairing.cancel(),
    approve: requestId => {
      // paired: false while the PC's own user has yet to confirm the number; it is stored then.
      const { deviceId, member: stored } = needHub().pairing.approve(requestId)
      return { ok: true, deviceId, paired: stored !== null }
    },
    reject: requestId => needHub().pairing.reject(requestId),
    join(req) {
      const m = needMember()
      if (!parseHostPort(req.hubAddress)) throw apiError(400, `"${req.hubAddress}" is not an address like 192.168.1.118:21220`)
      const code = normalizeCode(req.code)
      if (!CODE.test(code)) throw apiError(400, 'The code is 8 characters, like K7M3-Q9PX')
      join?.cancel()
      const seq = ++joinSeq
      join = startJoin({
        hubAddress: req.hubAddress,
        hubId: req.hubId ?? null,
        code,
        identity,
        name: config.name,
        rustdeskId,
        version: VERSION,
        onState: s => {
          if (seq !== joinSeq) return
          joinState = s
          changed()
        },
        onPaired: bundle => {
          devices.setHub(bundle)
          seekingHub = false
          updateDiscovery(m.discovery)
          m.links.hubChanged()
        },
        log: log.child('join'),
      })
      return joinState
    },
    confirmJoin: ({ match }) => {
      needMember()
      if (!join || joinState.status !== 'confirm') throw apiError(409, 'No join is waiting for you to check its number')
      return join.confirm(match)
    },
    cancelJoin: () => {
      needMember()
      join?.cancel()
      join = null
      joinState = IDLE_JOIN
      changed()
    },
    check(id) {
      if (!known(id)) throw apiError(404, 'No such device')
      if (hub) return { ok: true, linked: hub.links.check(id) }
      member?.links.check()
    },
    async screen(id) {
      if (!known(id)) throw apiError(404, 'No such device')
      if (!muxOf(id)) throw apiError(409, 'No link to that PC right now')
      if (!exe && !testNoRustdesk) throw apiError(409, 'RustDesk is not installed on this PC (looked in Program Files)')
      const port = await tunnels.open(id, async () => {
        const mux = muxOf(id)
        if (!mux) throw new Error('no link to that PC right now')
        return mux.open('rustdesk')
      })
      if (exe) launchRustdesk(exe, port, log.child('rustdesk'))
      return { ok: true, port, launched: exe !== null }
    },
    // F-005/F-006: the in-app viewer speaks RustDesk's protocol itself over this raw stream, to
    // the RustDesk installed on that PC ('rustdesk') or to the app's own screen there ('screen').
    async remote(id, via) {
      if (id === identity.id) return ownScreen(via)
      if (!known(id)) throw apiError(404, 'No such device')
      const mux = muxOf(id)
      if (!mux) throw apiError(409, 'No link to that PC right now')
      try {
        return await mux.open(via === 'app' ? 'screen' : 'rustdesk')
      } catch (e) {
        throw apiError(502, `That PC couldn't open its screen: ${message(e)}`)
      }
    },
    screenPassword({ password }) {
      try {
        appScreen.setPassword(password)
      } catch (e) {
        throw apiError(400, message(e))
      }
      return { ok: true, passwordSet: password !== null }
    },
    screenSetup() {
      appScreen.setup()
      return { ok: true }
    },
    // F-007. The CRM's no is the page's 400 with the CRM's own sentence; no answer is 502.
    async claudeSignIn({ login, password }) {
      try {
        return await claude.signIn(login, password)
      } catch (e) {
        if (e instanceof CrmError) throw apiError(e.status === null || e.status >= 500 ? 502 : 400, e.message)
        throw e
      }
    },
    claudeCheck: ({ replace }) => claude.check({ replace }),
    claudeSignOut: () => claude.signOut(),
    // Claude subscription failover and the person's own switch (agent/claude/failover.ts).
    claudeSwitchRefresh: ({ readings }) => claude.refreshSwitch({ readings }),
    async claudeSwitchPreview(to) {
      const p = await failover.preview(to)
      if ('error' in p) throw apiError(400, p.error)
      return p
    },
    async claudeSwitch(req) {
      const r = await failover.switchNow(req)
      return { ok: r.ok, message: r.message, restarted: r.restarted, failed: r.failed }
    },
    claudeSwitchAuto: ({ on }) => claude.setAuto(on),
    // F-013: this PC's keys while a Control page here has the focus.
    grabKeys: (onKey, onEnd) => appScreen.grabKeys(onKey, onEnd),
    // F-008. Only for a paired PC, or this one (F-014); the saved H1 never leaves this process.
    savedLogin(id, { via, salt, challenge }) {
      if (!knownOrOwn(id)) throw apiError(404, 'No such device')
      const digest = saved.answer(id, via, salt, challenge)
      if (!digest) changed()
      return { digest: digest ? digest.toString('base64') : null }
    },
    savePassword(id, { via, salt, h1 }) {
      if (!knownOrOwn(id)) throw apiError(404, 'No such device')
      saved.save(id, via, salt, Buffer.from(h1, 'base64'))
      changed()
      return { ok: true }
    },
    forgetPassword(id, { via }) {
      if (!knownOrOwn(id)) throw apiError(404, 'No such device')
      const forgotten = saved.forget(id, via)
      changed()
      return { ok: true, forgotten }
    },
    remove(id) {
      if (!needHub().links.remove(id)) throw apiError(404, 'No such device')
      // A PC taken off the list takes its saved passwords with it.
      saved.forget(id)
    },
    settings(patch): AgentSettings {
      if (patch.route !== undefined && patch.route !== route) {
        updateConfig({ route: patch.route }, { root: paths.root })
        route = patch.route
        log.info(`how to connect: ${route}`)
        // The setting decides the path: run the decision again now.
        member?.links.check()
        changed()
      }
      if (patch.stayReachable !== undefined && patch.stayReachable !== stayReachable) {
        updateConfig({ stayReachable: patch.stayReachable }, { root: paths.root })
        stayReachable = patch.stayReachable
        log.info(`stay reachable for Control on mains power: ${stayReachable ? 'on' : 'off'}`)
        appScreen.setReachable(stayReachable)
        changed()
      }
      return { route, stayReachable }
    },
  }

  try {
    api = await startApi({ port: ports.api, token, actions, onClients, log: log.child('api'), mounts: [agentic?.mount ?? agenticOff(), ...(extras.mounts ?? [])] })
  } catch (e) {
    await stopAll()
    throw new Error(`cannot open the local API on 127.0.0.1:${ports.api}: ${message(e)} (is another agent running?)`, { cause: e })
  }

  void checkScreen()
  every(60_000, () => void checkScreen())
  // The CRM decides what Claude here runs on: asked at start and every hour while signed in.
  void claude.check()
  every(CHECK_EVERY_MS, () => void claude.check())
  // Round trips and last-seen times move with every ping: keep the page current.
  every(5000, () => changed())

  async function stopAll() {
    for (const t of timers) clearInterval(t)
    // Claude subscription failover first: nothing may start restarting a chat while they are being closed.
    failover.stop()
    rowWatch?.stop()
    claude.close()
    agentic?.close()
    appScreen.close(`The app on ${config.name} stopped`)
    join?.cancel()
    member?.discovery.stop()
    member?.links.stop('the agent is stopping')
    tunnels.closeAll()
    await hub?.stop()
  }

  let stopping: Promise<void> | null = null
  return {
    state,
    apiPort: api.port,
    stop: () =>
      (stopping ??= (async () => {
        await api?.close()
        await stopAll()
        log.info('stopped')
      })()),
  }
}

// ---------------------------------------------------------------------------------------
// Entry: npm run agent [-- --role hub|member]

if (import.meta.main) {
  const log = rootLog
  let agent: Agent | null = null
  let build: Build | null = null
  let ui: UiServer | null = null
  let uiTailnet: UiServer | null = null
  let exiting = false
  const shutdown = async (why: string, code = 0) => {
    // A second Ctrl+C: don't wait any longer.
    if (exiting) process.exit(1)
    exiting = true
    log.info(`stopping: ${why}`)
    try {
      build?.close()
      await ui?.close()
      await uiTailnet?.close()
      await agent?.stop()
    } catch (e) {
      log.error(`while stopping: ${message(e)}`)
      code ||= 1
    }
    await closeLog()
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown('Ctrl+C'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGBREAK', () => void shutdown('Ctrl+Break'))
  // Started by another Node process with an IPC channel (the e2e test, a supervisor): it
  // can ask for a clean stop, and its going away stops the agent too. On Windows a signal
  // from another process is always a hard kill.
  process.on('message', msg => {
    if ((msg as { t?: unknown } | null)?.t === 'stop') void shutdown('asked by the parent process')
  })
  process.on('disconnect', () => void shutdown('the parent process went away'))
  process.on('uncaughtException', e => {
    log.error(`internal error: ${e.stack ?? e.message}`)
    void shutdown('internal error', 1)
  })
  process.on('unhandledRejection', e => log.error(`internal error (unhandled rejection): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))

  try {
    const config = loadConfig({ argv: process.argv.slice(2) })
    // SAD_LOG_LEVEL=debug for the detail (links, streams; the app's own screen's logged-only input).
    initLog({ dir: config.paths.logs, level: process.env.SAD_LOG_LEVEL === 'debug' ? 'debug' : undefined })
    // F-020: which build this is, its updates, and Publish on the hub where Dev is beside it.
    const root = path.resolve(import.meta.dirname, '..')
    const devDir = findDevDir(root)
    build = createBuild({
      root,
      devDir,
      role: () => config.role,
      log: log.child('build'),
      restart: code => void shutdown('updating to the newer build', code),
      supervised: process.env.SAD_SUPERVISED === '1',
    })
    // F-020: the build runs the floors and their chats; Dev, only with --agents (its own, apart).
    const agents = build.info().kind === 'build' || process.argv.includes('--agents') || process.env.SAD_AGENTS === '1'
    if (!agents) log.info('the Agents section is off: this is Dev, and the build runs the chats (--agents turns it on here)')
    agent = await startAgent(config, log, { mounts: [build.mount], devDir, agents })
    log.info(`ready: the app's Devices page talks to 127.0.0.1:${agent.apiPort}`)
    // F-020: a build serves its own page (--app <dir>), on 5173 as Vite does in Dev.
    const appIndex = process.argv.indexOf('--app')
    if (appIndex !== -1 && process.argv[appIndex + 1]) {
      const apiPort = agent.apiPort
      const servePage = (): void => {
        startUiServer({
          port: Number(process.env.SAD_UI_PORT) || 5173,
          appDir: path.resolve(process.argv[appIndex + 1]),
          apiPort: () => apiPort,
          token: loadOrCreateApiToken(config.paths.root),
          log: log.child('page'),
        }).then(
          s => {
            if (exiting) void s.close()
            else ui = s
          },
          (e: unknown) => {
            // Taken (Dev's dev server, most often): the agent goes on, and tries again.
            log.error(`couldn't serve the page: ${message(e)}; trying again in 30 s`)
            if (!exiting) setTimeout(servePage, 30_000).unref()
          },
        )
      }
      // F-058: under the guard the page on this port is the guard's (it is never closed, even while
      // this agent restarts); the tailnet one below stays here.
      if (process.env.SAD_PAGE_SERVER === 'guard') log.info('the page on the local port is served by the guard')
      else servePage()
      // F-028: opened to the tailnet (Open-To-Tailnet.cmd, run as administrator, leaves the
      // marker): the page and its API on this PC's Tailscale address too, for the other PCs.
      // Looked for every 30 s, so running the script (or -Remove) needs no restart.
      const marker = path.join(config.paths.root, 'agent', 'open-to-tailnet')
      const tailnetPort = Number(process.env.SAD_UI_TAILNET_PORT) || 5190
      let opening = false
      const tailnetPage = (): void => {
        if (exiting || opening) return
        const want = existsSync(marker)
        if (!want && uiTailnet) {
          void uiTailnet.close()
          uiTailnet = null
          log.info('closed to the tailnet: the page is on this PC only')
          return
        }
        const at = tailnetAddress()
        if (!want || uiTailnet || !at) return
        opening = true
        startUiServer({
          port: tailnetPort,
          host: at,
          appDir: path.resolve(process.argv[appIndex + 1]),
          apiPort: () => apiPort,
          token: loadOrCreateApiToken(config.paths.root),
          log: log.child('page'),
          allowRemote: a => isTailnetAddress(a),
        }).then(
          s => {
            opening = false
            if (exiting) return void s.close()
            uiTailnet = s
            log.info(`opened to the tailnet: the page on http://${at}:${tailnetPort}`)
          },
          (e: unknown) => {
            opening = false
            log.error(`couldn't serve the page on the tailnet: ${message(e)}; trying again in 30 s`)
          },
        )
      }
      tailnetPage()
      setInterval(tailnetPage, 30_000).unref()
    }
    process.send?.({ t: 'ready', apiPort: agent.apiPort })
  } catch (e) {
    log.error(message(e))
    await closeLog()
    process.exit(1)
  }
}
