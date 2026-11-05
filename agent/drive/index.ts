import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createBackup, type Backup, type BackupOptions } from './backup.ts'
import { localTarget } from './backup-local.ts'
import type { BackupTarget } from './backup-target.ts'
import { googleTarget, parsePartialKeys, type GoogleKeys, type GoogleOptions } from './google.ts'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import type { DriveBackupInfo, DriveBackupState, DriveGoogleSource, DriveSettings, DriveStatus, DriveWebdav } from '../../shared/drive.ts'
import type { ApiMount, MountRequest } from '../api.ts'
import type { Logger } from '../log.ts'
import { createDriveDevices } from './devices.ts'
import { createLinkServer, linkRemote, type HubCall, type LinkPeerInfo } from './link.ts'
import { createLocalSync } from './local-sync.ts'
import { createPairing } from './pairing.ts'
import { driveMount, driveRaw, SYNC_ROUTES, type DriveHost } from './routes.ts'
import { startDriveListener, type DriveListener } from './server.ts'
import { storeRemote } from './sync-remote.ts'
import { applySettings, createDriveStore, DEFAULT_SETTINGS, driveError, PIECE_BYTES, type DriveStore, type DriveStoreOptions } from './store.ts'
import { DEFAULT_HTTPS_PORT, defaultRunner, serveOff, serveOn, serveState, tailnetInfo, type Runner } from './tailscale.ts'

// F-097: the Common Drive inside the agent. The store is opened the first time it is needed (so an agent that never touches the
// drive makes no folder), kept while it is switched on, and swept every hour (the Bin, abandoned uploads, the journal).
// Its settings are saved in the agent's own state folder, not in the pool, so they survive moving the pool.
// WebDAV (agent/drive/server.ts) listens only while the setting is on, on this PC's loopback; the tailnet's HTTPS address in front of it
// is a second, separate switch (tailscale serve, never funnel).

/** `C:\Common Drive` on Windows (the system drive), `~/Common Drive` anywhere else. */
export function defaultDriveRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') return path.win32.join(`${env.SystemDrive ?? 'C:'}\\`, 'Common Drive')
  return path.join(homedir(), 'Common Drive')
}

/** The port the WebDAV listener takes on this PC's loopback. */
export const DEFAULT_WEBDAV_PORT = 21280

export interface DriveOptions {
  /** The agent's state folder for the drive (settings.json and devices.json go here). */
  dir: string
  root?: string
  /** This PC's name: who a change is by when the caller doesn't say. */
  device: string
  /** The drive lives on the hub; on a member PC every call answers "disabled" for now (the laptop forwards in a later part). */
  role: 'hub' | 'member'
  log?: Logger
  webdavPort?: number
  httpsPort?: number
  /** The built sync program (default: dist-sync/common-drive-sync.mjs in the build). */
  programFile?: string
  /** F-097: which paired phone a device key belongs to (the voice pairing's), for phone uploads; without it no phone can upload. */
  deviceOf?: (headers: MountRequest['headers']) => { id: string; name: string } | null
  /** F-125: the COMPANY's (bztech68) Google keys file (default: gdrive-bztech68.env in the agent's secrets folder, beside the drive folder). Never read until a token is needed. */
  keysFile?: string
  /**
   * F-125: Shubham's own (shubhambhole68) key files, the old way: each one fills in what the ones before it lack (Google's client JSON has the id and secret, an env file the refresh token).
   * Default: gdrive-shubhambhole68.env, auth secret.json and client_secret*.json on this user's Desktop, then the old gdrive-shubhambhole68.env in the secrets folder. Used only when the setting says shubhambhole68.
   */
  personalKeys?: string[]
  /** F-125: the CRM backend's .env: the one place the import button reads the company's three Google keys from (nothing else in it is read). */
  crmEnvFile?: string
  /** F-125: makes a file readable by this user only (default: icacls on Windows, chmod 600 elsewhere). */
  lockFile?: (file: string) => Promise<void>
  /** The folder the backup copies into when there are no Google keys (default: G:\My Drive\Common Drive when that Google Drive for desktop folder exists; null for none). */
  backupFolder?: string | null
  /** Tests: the fake Google's addresses and quick waits; the backup loop's timings. */
  google?: Partial<GoogleOptions>
  backup?: Partial<BackupOptions>
  /** Tests: quicker waits for the sync folder of this PC. */
  localSync?: { scanEveryMs?: number; pollMs?: number }
  /** Tests: the clock and the free-space check, passed to the store; a fake `tailscale` command. */
  store?: Partial<DriveStoreOptions>
  runner?: Runner
}

export interface Drive {
  mount: ApiMount
  /** The open store, or null when the drive is off or not on this PC. */
  store(): Promise<DriveStore | null>
  settings(): DriveSettings
  /** The hub's end of the member link: one request from a member PC (agentic's 'drive' op). */
  linkCall(from: LinkPeerInfo, body: unknown): Promise<unknown>
  /** A member PC: how to reach the hub over the link (agentic's driveRequest). Starts the sync folder if it was on. */
  setHubRequest(call: HubCall | null): void
  /** Which paired phone a device key belongs to (the voice pairing's); without it no phone can upload. */
  setPhoneAuth(deviceOf: ((headers: MountRequest['headers']) => { id: string; name: string } | null) | null): void
  close(): Promise<void>
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createDrive(o: DriveOptions): Drive {
  const file = path.join(o.dir, 'settings.json')
  const root = path.resolve(o.root ?? defaultDriveRoot())
  const run = o.runner ?? defaultRunner
  const httpsPort = o.httpsPort ?? DEFAULT_HTTPS_PORT
  const programFile = o.programFile ?? path.resolve(import.meta.dirname, '..', '..', 'dist-sync', 'common-drive-sync.mjs')
  let cfg: DriveSettings = { ...DEFAULT_SETTINGS }
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<DriveSettings>
    cfg = applySettings(cfg, saved, 0)
  } catch {
    // None yet, or damaged: the defaults.
  }
  const save = () => {
    mkdirSync(o.dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, file)
  }

  let opened: Promise<DriveStore> | null = null
  let sweeper: NodeJS.Timeout | undefined
  const open = (): Promise<DriveStore> => {
    opened ??= createDriveStore({ root, device: o.device, log: o.log, ...cfg, ...o.store }).then(s => {
      s.setSettings(cfg)
      void s.sweep().catch(e => o.log?.warn(`drive sweep: ${message(e)}`))
      sweeper = setInterval(() => void s.sweep().catch(() => undefined), 60 * 60 * 1000)
      sweeper.unref()
      return s
    })
    opened.catch(() => (opened = null))
    return opened
  }
  const shut = async () => {
    if (sweeper) clearInterval(sweeper)
    sweeper = undefined
    const p = opened
    opened = null
    if (p) await p.then(s => s.close(), () => undefined)
  }

  // ---- WebDAV ---------------------------------------------------------------------------------------------------------
  const devices = createDriveDevices(path.join(o.dir, 'devices.json'))
  const pairing = createPairing()
  let listener: DriveListener | null = null
  let listenerError: string | undefined
  let owner: string | null = null
  let syncing: Promise<void> = Promise.resolve()

  const storeOrNull = async (): Promise<DriveStore | null> => {
    if (o.role !== 'hub' || !cfg.enabled) return null
    return open()
  }
  const why = () => (o.role !== 'hub' ? 'The Common Drive lives on the hub PC; this PC reaches it through the sync folder.' : 'The Common Drive is switched off. Switch it on in Settings.')

  /** Starts or stops the listener to match the setting. One at a time. */
  const syncListener = (): Promise<void> => {
    syncing = syncing.then(async () => {
      const want = o.role === 'hub' && cfg.enabled && cfg.webdavEnabled
      if (want && !listener) {
        try {
          owner = (await tailnetInfo(run))?.owner ?? owner
          listener = await startDriveListener({
            port: o.webdavPort ?? DEFAULT_WEBDAV_PORT,
            store: storeOrNull,
            why,
            devices,
            owner: () => owner,
            refreshOwner: async () => {
              owner = (await tailnetInfo(run))?.owner ?? owner
            },
            log: o.log?.child('webdav'),
            api: rest => api(rest),
            pairing: { redeem: code => pairing.redeem(code), createDevice: name => devices.create(name) },
          })
          listenerError = undefined
          o.log?.info(`WebDAV is on at http://127.0.0.1:${listener.port}/dav/`)
        } catch (e) {
          listenerError = `WebDAV could not start: ${message(e)}`
          o.log?.warn(listenerError)
        }
      } else if (!want && listener) {
        const l = listener
        listener = null
        // The tailnet address goes with it: nothing may point at a listener that is gone.
        await serveOff(httpsPort, run).catch(() => undefined)
        await l.close()
        o.log?.info('WebDAV is off')
      }
    })
    return syncing
  }

  const webdavInfo = async (): Promise<DriveWebdav> => {
    const tn = listener ? await tailnetInfo(run) : null
    const st = tn && listener ? await serveState(httpsPort, listener.port, run) : { serving: false, funnel: false }
    const port = listener?.port ?? o.webdavPort ?? DEFAULT_WEBDAV_PORT
    return {
      enabled: cfg.webdavEnabled && cfg.enabled,
      running: listener !== null,
      port,
      localUrl: `http://127.0.0.1:${port}/dav/`,
      tailnet: { available: tn !== null, serving: st.serving && !st.funnel, httpsPort, ...(tn && st.serving && !st.funnel ? { url: `https://${tn.dnsName}:${httpsPort}/dav/` } : {}) },
      devices: devices.list(),
      ...(listenerError ? { error: listenerError } : {}),
    }
  }

  // ---- the backup (Google Drive, or a folder when there are no keys) ----------------------------------------------------
  // F-125: two Google accounts, picked by the setting "googleSource". "company" (the default) is bztech68, the account the CRM uses: its three keys live in
  // gdrive-bztech68.env in the agent's secrets folder, put there by the import button from the CRM's own .env. "shubhambhole68" is Shubham's own account, the old
  // way: read from his Desktop files (or the old secrets-folder file), never copied. This code only checks that a file exists and hands the googleTarget a function
  // that reads it when a token is needed. The values are never kept here, logged or shown; the page learns only "set" or "missing".
  const secretsDir = path.join(path.dirname(o.dir), 'secrets')
  const companyFile = o.keysFile ?? path.join(secretsDir, 'gdrive-bztech68.env')
  const crmEnvFile = o.crmEnvFile ?? path.join(homedir(), 'Desktop', 'Github', 'CRM', 'sam-crm-be', '.env')
  const desktop = path.join(homedir(), 'Desktop')
  const ACCOUNT: Record<DriveGoogleSource, string> = { company: 'bztech68', shubhambhole68: 'shubhambhole68' }
  const sourceNow = (): DriveGoogleSource => (cfg.googleSource === 'shubhambhole68' ? 'shubhambhole68' : 'company')
  /** The files that can hold an account's keys, in the order they are read. */
  const keyFiles = (src: DriveGoogleSource): string[] => {
    if (src === 'company') return [companyFile]
    if (o.personalKeys) return o.personalKeys
    let clientJson: string[] = []
    try {
      clientJson = readdirSync(desktop)
        .filter(n => /^client_secret.*\.json$/i.test(n))
        .sort()
        .map(n => path.join(desktop, n))
    } catch {
      // No Desktop to look in.
    }
    return [path.join(desktop, 'gdrive-shubhambhole68.env'), path.join(desktop, 'auth secret.json'), ...clientJson, path.join(secretsDir, 'gdrive-shubhambhole68.env')]
  }
  /** A text file as text; Windows editors sometimes save UTF-16. */
  const readText = async (file: string): Promise<string> => {
    const buf = await readFile(file)
    return buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8')
  }
  /** All three keys of an account, or null. Held by the caller for as long as it needs them, and nowhere else. */
  const readKeys = async (src: DriveGoogleSource): Promise<GoogleKeys | null> => {
    const got: Partial<GoogleKeys> = {}
    for (const f of keyFiles(src)) {
      if (!existsSync(f)) continue
      let part: Partial<GoogleKeys>
      try {
        part = parsePartialKeys(await readText(f))
      } catch {
        continue
      }
      got.clientId ??= part.clientId
      got.clientSecret ??= part.clientSecret
      got.refreshToken ??= part.refreshToken
    }
    return got.clientId && got.clientSecret && got.refreshToken ? { clientId: got.clientId, clientSecret: got.clientSecret, refreshToken: got.refreshToken } : null
  }
  const anyKeyFile = (src: DriveGoogleSource) => keyFiles(src).some(f => existsSync(f))
  const fallbackFolder = o.backupFolder === undefined ? (existsSync('G:\\My Drive') ? 'G:\\My Drive\\Common Drive' : null) : o.backupFolder
  let backup: Backup | null = null
  const googles = new Map<DriveGoogleSource, BackupTarget>()
  const backupTarget = async (): Promise<BackupTarget | null> => {
    const src = sourceNow()
    if (anyKeyFile(src)) {
      let g = googles.get(src)
      if (!g) {
        g = googleTarget({ keys: () => readKeys(src), account: ACCOUNT[src], ...o.google })
        googles.set(src, g)
      }
      return g
    }
    return fallbackFolder ? localTarget(fallbackFolder) : null
  }
  const makeBackup = () =>
    (backup ??= createBackup({ store: storeOrNull, target: backupTarget, stateFile: path.join(o.dir, 'backup-state.json'), log: o.log?.child('backup'), ...o.backup }))
  /** Starts or stops the backup loop to match the setting. */
  const syncBackup = async () => {
    const want = o.role === 'hub' && cfg.enabled && cfg.backupEnabled
    if (want) makeBackup().start()
    else if (backup) {
      await backup.stop()
      backup = null
    }
  }
  const backupInfo = async (): Promise<DriveBackupInfo> => {
    const target = await backupTarget()
    const st: DriveBackupState & { held?: number } = backup && cfg.backupEnabled ? backup.status() : { state: 'off' }
    const src = sourceNow()
    const keysBySource: Record<DriveGoogleSource, 'set' | 'missing'> = {
      company: (await readKeys('company')) ? 'set' : 'missing',
      shubhambhole68: (await readKeys('shubhambhole68')) ? 'set' : 'missing',
    }
    return {
      ...st,
      target: target?.label ?? null,
      keys: keysBySource[src] === 'set',
      source: src,
      keysBySource,
      canImport: existsSync(crmEnvFile),
      fallbackFolder,
      ...(!target && cfg.backupEnabled
        ? {
            error:
              src === 'company'
                ? 'There is nowhere to copy to: the company (bztech68) Google keys are missing. Import them, or have Google Drive for desktop on G:.'
                : 'There is nowhere to copy to: the shubhambhole68 Google keys are missing from the Desktop. Put gdrive-shubhambhole68.env there, or have Google Drive for desktop on G:.',
          }
        : {}),
    }
  }
  /** Restricts a file to this user: icacls on Windows (no inherited rights), chmod 600 elsewhere. A failure is not fatal (the folder is the user's own) but is said. */
  const lockFile =
    o.lockFile ??
    (async (file: string): Promise<void> => {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          execFile('icacls', [file, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { windowsHide: true }, err => (err ? reject(err) : resolve()))
        })
      } else await chmod(file, 0o600)
    })
  /** F-125: writes the company's keys file: only the three keys, to a temporary file that is locked before anything goes in it, then renamed over the real one. */
  const writeCompanyKeys = async (k: GoogleKeys): Promise<void> => {
    await mkdir(path.dirname(companyFile), { recursive: true })
    const tmp = `${companyFile}.${process.pid}.tmp`
    try {
      await writeFile(tmp, '', { mode: 0o600 })
      try {
        await lockFile(tmp)
      } catch (e) {
        o.log?.warn(`drive: could not restrict ${path.basename(companyFile)} to this user (${message(e).slice(0, 80)}); the secrets folder's own rights apply`)
      }
      await writeFile(tmp, `# The company's (bztech68) Google keys, copied by the app from the CRM's .env. Keep this file private.\nGDRIVE_CLIENT_ID=${k.clientId}\nGDRIVE_CLIENT_SECRET=${k.clientSecret}\nGDRIVE_REFRESH_TOKEN=${k.refreshToken}\n`)
      await rename(tmp, companyFile)
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  // ---- the sync folder on this PC (inside the app) ------------------------------------------------------------------------
  let hubCall: HubCall | null = null
  let deviceOf = o.deviceOf ?? null
  const localSync = createLocalSync({
    dir: o.dir,
    device: o.device,
    poolRoot: o.role === 'hub' ? root : undefined,
    remote: async () => {
      if (o.role === 'hub') {
        const s = await storeOrNull()
        return s ? storeRemote(s, o.device) : null
      }
      return hubCall ? linkRemote(hubCall) : null
    },
    why: () => (o.role === 'hub' ? why() : 'This PC can not reach the hub right now.'),
    log: o.log?.child('sync'),
    ...o.localSync,
  })
  const linkCall = createLinkServer(storeOrNull, why)

  const host: DriveHost = {
    device: o.device,
    store: storeOrNull,
    why,
    settings: () => ({ ...cfg }),
    async patch(patch) {
      const before = sourceNow()
      const s = opened ? await opened.catch(() => null) : null
      if (s) cfg = s.setSettings({ ...patch })
      else cfg = applySettings(cfg, patch, 0)
      save()
      if (!cfg.enabled) await shut()
      else if (o.role === 'hub') await open().catch(() => undefined)
      await syncListener()
      await syncBackup()
      if (sourceNow() !== before) {
        // Another account: its Drive has none of the copies yet, so the next pass is a full check against what is really there.
        googles.clear()
        if (backup && cfg.backupEnabled) void backup.verify().catch(() => undefined)
      }
      return { ...cfg }
    },
    phoneDevice: headers => deviceOf?.(headers) ?? null,
    localSync: () => localSync.info(),
    localSyncSet: patch => localSync.set(patch),
    localSyncRun: () => localSync.run(),
    localSyncAllowDeletes: () => localSync.allowDeletes(),
    backup: backupInfo,
    async backupImportKeys() {
      if (o.role !== 'hub') throw driveError(409, 'disabled', why())
      let text: string
      try {
        text = await readText(crmEnvFile)
      } catch {
        throw driveError(404, 'notfound', "The CRM's .env file is not on this PC, so there is nothing to import.")
      }
      // Only the three keys are taken. Everything else in that file (GDRIVE_PUBLIC, the folder, any other setting) is neither read nor kept.
      const p = parsePartialKeys(text)
      if (!p.clientId || !p.clientSecret || !p.refreshToken) {
        throw driveError(409, 'notfound', "The CRM's .env file does not hold all three Google keys (GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN).")
      }
      await writeCompanyKeys({ clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: p.refreshToken })
      googles.clear()
      o.log?.info(`drive: the company's Google keys were imported into ${path.basename(companyFile)}`)
      if (backup && cfg.backupEnabled) void backup.verify().catch(() => undefined)
      return backupInfo()
    },
    backupState: () => (backup && cfg.backupEnabled ? backup.status() : { state: 'off' }),
    async backupRun() {
      if (!cfg.backupEnabled) throw driveError(409, 'disabled', 'The backup is switched off. Switch it on in Settings.')
      await makeBackup().verify().catch(() => undefined) // a failure is in its status
      return backupInfo()
    },
    async backupAllowDeletes() {
      if (!backup || !cfg.backupEnabled) throw driveError(409, 'disabled', 'The backup is switched off.')
      backup.allowMassDelete()
      await backup.runOnce().catch(() => undefined)
      return backupInfo()
    },
    async offStatus(): Promise<DriveStatus> {
      return {
        enabled: cfg.enabled,
        root,
        limitBytes: cfg.limitBytes,
        usedBytes: 0,
        binBytes: 0,
        versionsBytes: 0,
        diskFreeBytes: 0,
        rev: 0,
        pieceBytes: PIECE_BYTES,
        binDays: cfg.binDays,
        versionsKept: cfg.versionsKept,
        webdav: { enabled: cfg.webdavEnabled },
        backup: { state: 'off' },
        now: Date.now(),
      }
    },
    webdav: webdavInfo,
    syncProgram: () => (existsSync(programFile) ? programFile : null),
    async syncPair(name) {
      if (o.role !== 'hub') throw driveError(409, 'disabled', why())
      if (!listener) throw driveError(409, 'disabled', 'Switch on "other devices" first (the same switch as WebDAV): sync devices connect through it.')
      const clean = [...name].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && !':/\\'.includes(c)).join('').trim().slice(0, 40)
      if (!clean) throw driveError(400, 'badname', 'A device needs a name.')
      return pairing.start(clean)
    },
    async webdavCreateDevice(name) {
      if (o.role !== 'hub') throw driveError(409, 'disabled', why())
      return devices.create(name)
    },
    async webdavRevokeDevice(name) {
      devices.revoke(name)
      return webdavInfo()
    },
    async webdavTailscale(on) {
      await syncListener()
      if (!listener) throw driveError(409, 'disabled', 'Switch WebDAV on first.')
      if (on) {
        const tn = await tailnetInfo(run)
        if (!tn) throw driveError(409, 'disabled', 'Tailscale is not running on this PC.')
        owner = tn.owner
        try {
          await serveOn(httpsPort, listener.port, run)
        } catch (e) {
          throw driveError(409, 'disabled', message(e))
        }
      } else {
        await serveOff(httpsPort, run).catch(e => {
          throw driveError(409, 'disabled', message(e))
        })
      }
      return webdavInfo()
    },
  }

  /** The page's routes that a sync device may use, on the listener's /api (after its sign-in). */
  const api = driveRaw(host, SYNC_ROUTES)

  if (cfg.webdavEnabled) void syncListener()
  if (cfg.backupEnabled) void syncBackup()
  // The hub's own sync folder, if it was on, starts now; a member PC's waits for setHubRequest.
  if (o.role === 'hub') void localSync.resume()

  return {
    mount: driveMount(host),
    store: storeOrNull,
    settings: () => ({ ...cfg }),
    linkCall: (from, body) => linkCall(from, body),
    setPhoneAuth(fn) {
      deviceOf = fn
    },
    setHubRequest(call) {
      hubCall = call
      if (call) void localSync.resume()
    },
    async close() {
      await localSync.close()
      const l = listener
      listener = null
      await l?.close()
      await backup?.stop()
      backup = null
      await shut()
    },
  }
}
