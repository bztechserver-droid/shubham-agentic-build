import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import type { AppScreenInfo, GrabbedKey } from '../../shared/agent-api.ts'
import { loadSchema } from '../../shared/rustdesk/schema.ts'
import type { StatePaths } from '../config.ts'
import type { OpenHandler } from '../link/mux.ts'
import type { Logger } from '../log.ts'
import { ensureFfmpeg, FFMPEG, findFfmpeg, startScreenCapture } from './ffmpeg.ts'
import { hostSession, type HostPlatform, type HostSession, type InputPort, type VideoSource } from './host.ts'
import { createFailures, loadPassword, passwordProblem, savePassword } from './password.ts'
import { createKeyGrab, type KeyGrab } from './grab.ts'
import { createPower, type PowerPort } from './power.ts'
import { createPrivacy } from './privacy.ts'
import { createTextFocus } from './text-focus.ts'
import { coverSupported, loadFailure, loadWin32 } from './win32.ts'

// The app's own screen (F-006): this PC's screen, mouse and keyboard for a paired PC's viewer,
// with no RustDesk on either side. The link's 'screen' streams land here (agent/SPEC.md ›
// F-006); each one is a host session (host.ts) with FFmpeg for the picture (ffmpeg.ts) and
// Windows' own calls for the input (win32.ts). The installed-RustDesk way ('rustdesk' streams,
// F-005) stays beside it, untouched.
//
// Test and dev env:
//   SAD_SCREEN_PATTERN=1  FFmpeg's test pattern instead of the screen, input only logged, no
//                         clipboard or pointer: for tests, nothing of this PC is shown or touched
//   SAD_SCREEN_DRY_INPUT=1  the real screen, but mouse and keyboard only logged, and the power
//                         plan's power button and lid only read
//   SAD_FFMPEG=<exe>      another ffmpeg.exe

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** At most this many PCs at once (one ffmpeg each). */
const MAX_SESSIONS = 3

export interface AppScreen {
  status(): AppScreenInfo
  /** For the link's 'screen' streams. */
  handler: OpenHandler
  /** Sets this PC's control password; null removes it. Throws with the reason for a bad one. */
  setPassword(password: string | null): void
  /** Fetches FFmpeg in the background (Settings › Devices' Set up). */
  setup(): void
  /** Looks for FFmpeg again (after npm run setup:screen); true when readiness changed. */
  recheck(): boolean
  /** "Stay reachable for Control" while on mains power (power.ts). */
  setReachable(on: boolean): void
  /**
   * F-013, the controlling side: this PC's keys (Alt+Tab, the Windows key and the rest) for a
   * Control page here while it has the focus (grab.ts); rejects where it can't.
   */
  grabKeys(onKey: (k: GrabbedKey) => void, onEnd: (why: string) => void): Promise<{ stop(): void }>
  /** Ends every session (the agent is stopping). */
  close(reason: string): void
}

export interface AppScreenOptions {
  paths: StatePaths
  /** This PC's name in the app (Settings › Devices'). */
  hostname: string
  /** "Stay reachable for Control" as config.json has it (on unless turned off). */
  reachable: boolean
  log: Logger
  env?: Record<string, string | undefined>
  onChange(): void
}

/** Logs input instead of sending it (tests, and looking at the picture without touching this PC). */
function loggedInput(log: Logger): InputPort {
  const say = (what: string) => {
    log.debug(`input (not sent): ${what}`)
    return true
  }
  return {
    moveTo: (x, y) => say(`move ${x},${y}`),
    button: (b, down) => say(`${b} ${down ? 'down' : 'up'}`),
    wheel: (dx, dy) => void say(`wheel ${dx},${dy}`),
    scanKey: (code, down) => say(`scan 0x${code.toString(16)} ${down ? 'down' : 'up'}`),
    vkKey: (vk, down) => say(`vk 0x${vk.toString(16)} ${down ? 'down' : 'up'}`),
    unicodeKey: (unit, down) => say(`unicode ${unit} ${down ? 'down' : 'up'}`),
    keyState: () => ({ down: false, toggled: false }),
    lockWorkStation: () => say('lock'),
  }
}

/** A Windows notification, so whoever is at this PC sees it is being controlled. Best effort. */
function toast(title: string, text: string, log: Logger) {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$t = $x.GetElementsByTagName('text')",
    '$t.Item(0).AppendChild($x.CreateTextNode($env:SAD_TOAST_TITLE)) > $null',
    '$t.Item(1).AppendChild($x.CreateTextNode($env:SAD_TOAST_TEXT)) > $null',
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('; ')
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      // The words travel as environment variables, never inside the script.
      env: { ...process.env, SAD_TOAST_TITLE: title, SAD_TOAST_TEXT: text },
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', e => log.debug(`no notification: ${e.message}`))
    child.unref()
  } catch (e) {
    log.debug(`no notification: ${message(e)}`)
  }
}

export function createAppScreen(o: AppScreenOptions): AppScreen {
  const env = o.env ?? process.env
  const log = o.log
  const pattern = env.SAD_SCREEN_PATTERN === '1'
  const dryInput = pattern || env.SAD_SCREEN_DRY_INPUT === '1'
  if (pattern) log.warn('SAD_SCREEN_PATTERN=1: the app’s own screen shows a test pattern and sends no input (test mode)')
  else if (dryInput) log.warn('SAD_SCREEN_DRY_INPUT=1: the app’s own screen shows this PC but only logs mouse and keyboard')

  const schema = loadSchema(readFileSync(new URL('../../shared/rustdesk/message.proto', import.meta.url), 'utf8'))
  const win = pattern ? null : loadWin32()
  const failures = createFailures()
  const sessions = new Map<HostSession, { deviceId: string; name: string; since: string | null }>()
  // F-017: one UI Automation thread for every session that asks, only while one does.
  const textFocus = pattern || !win ? null : createTextFocus({ log })
  let exe = findFfmpeg(env)
  let setupState: AppScreenInfo['setup'] = null
  const username = win?.userName() ?? ''

  const reason = (): string | null => {
    if (!pattern && !win) return loadFailure() ?? 'the Windows calls could not be loaded'
    if (!exe) return 'FFmpeg isn’t set up on this PC yet'
    return null
  }

  const platform: HostPlatform =
    pattern || !win
      ? {
          displays: () => [{ adapter: 0, output: 0, name: 'Test pattern', x: 0, y: 0, width: 1280, height: 720, primary: true, scale: 1, vendorId: null }],
          input: loggedInput(log),
          clipboard: null,
          cursor: null,
          inputDesktop: () => 'Default',
          askYesNo: async () => 'no',
        }
      : {
          displays: () => win.displays(),
          input: dryInput ? loggedInput(log) : win,
          clipboard: win,
          cursor: win,
          inputDesktop: () => win.inputDesktop(),
          askYesNo: (text, title, ms) => win.askYesNo(text, title, ms),
          // Its nudge is input, so not when input is only logged.
          wake: dryInput ? undefined : () => win.wake(),
          // Privacy mode (F-012): one cover for the PC, with its pointer hidden too, so one port
          // all its sessions share. Not while input is only logged, which keeps this PC's own
          // screen as it is too.
          privacy: !dryInput && coverSupported() ? createPrivacy({ calls: win, log }) : null,
          // Only reads which element has the focus, so with input only logged too.
          textFocus,
        }

  // While anyone is logged in, the system and display stay awake (RustDesk's WakeLock): without it
  // Windows turns the display off after its idle time, and the picture stops. And, on mains
  // power, the system stays reachable for Control (power.ts). Not in the test pattern's mode.
  // The power plan is this PC's own: with input only logged, it is read and never changed.
  const powerPort: PowerPort | null =
    pattern || !win
      ? null
      : dryInput
        ? {
            holdAwake: (system, display) => win.holdAwake(system, display),
            onMains: () => win.onMains(),
            buttons: scheme => win.buttons(scheme),
            setButtons: (scheme, b) => {
              log.debug(`power plan ${scheme} not changed (input only logged): power button ${b.power}, lid ${b.lid}`)
              return true
            },
          }
        : win
  const power = createPower({ port: powerPort, reachable: o.reachable, log, onChange: () => o.onChange(), buttonsFile: o.paths.powerButtons })
  const holdAwake = () => power.setControlled([...sessions.values()].some(s => s.since))
  // F-013: made on the first Control page here that asks for this PC's keys.
  let keyGrab: KeyGrab | null = null

  const video: VideoSource = {
    start: (d, codec, drawMouse, events) =>
      startScreenCapture(
        { adapter: d.adapter, output: d.output, vendorId: d.vendorId, width: d.width, height: d.height },
        codec,
        { exe: exe!, drawMouse, log, pattern },
        events,
      ),
  }

  const handler: OpenHandler = meta => {
    const why = reason()
    if (why) throw new Error(`the app’s own screen isn’t ready on ${o.hostname}: ${why}`)
    if (sessions.size >= MAX_SESSIONS) throw new Error(`${o.hostname} is already showing its screen to ${MAX_SESSIONS} PCs`)
    // The links put in who opened the stream, from the paired record (never what the far end says).
    const f = meta.from as { id?: unknown; name?: unknown } | undefined
    const from = { id: typeof f?.id === 'string' ? f.id : 'unknown', name: typeof f?.name === 'string' && f.name ? f.name : 'Another PC' }
    return (stream: Duplex) => {
      const entry = { deviceId: from.id, name: from.name, since: null as string | null }
      const session = hostSession({
        stream,
        schema,
        from,
        hostname: o.hostname,
        username,
        password: () => loadPassword(o.paths.screenPassword),
        failures,
        video,
        platform,
        log,
        onLogin: () => {
          entry.since = new Date().toISOString()
          holdAwake()
          if (!pattern) toast(`${from.name} is controlling this PC`, `Through the app's own screen. It stops when they disconnect.`, log)
          o.onChange()
        },
        onClose: () => {
          sessions.delete(session)
          holdAwake()
          o.onChange()
        },
      })
      sessions.set(session, entry)
    }
  }

  return {
    status: () => ({
      ready: reason() === null,
      reason: reason(),
      ffmpeg: exe ? (env.SAD_FFMPEG ? 'custom' : FFMPEG.version) : null,
      passwordSet: loadPassword(o.paths.screenPassword) !== null,
      setup: setupState,
      sessions: [...sessions.values()].filter(s => s.since).map(s => ({ deviceId: s.deviceId, name: s.name, since: s.since! })),
      power: power.status(),
    }),

    handler,

    setPassword(password) {
      if (password !== null) {
        const problem = passwordProblem(password)
        if (problem) throw new Error(problem)
      }
      savePassword(o.paths.screenPassword, password)
      log.info(password === null ? 'control password removed' : 'control password set')
      o.onChange()
    },

    setup() {
      if (setupState?.state === 'downloading') return
      setupState = { state: 'downloading', progress: 0 }
      o.onChange()
      let shown = 0
      ensureFfmpeg({
        log: log.child('setup'),
        progress: p => {
          if (p - shown < 0.02 && p < 1) return
          shown = p
          setupState = { state: 'downloading', progress: p }
          o.onChange()
        },
      }).then(
        () => {
          exe = findFfmpeg(env)
          setupState = exe ? null : { state: 'failed', error: 'ffmpeg.exe is not where it was put' }
          o.onChange()
        },
        (e: unknown) => {
          setupState = { state: 'failed', error: message(e) }
          log.warn(`FFmpeg setup failed: ${message(e)}`)
          o.onChange()
        },
      )
    },

    recheck() {
      const before = reason() === null
      exe = findFfmpeg(env)
      return before !== (reason() === null)
    },

    setReachable: on => power.setReachable(on),

    grabKeys(onKey, onEnd) {
      if (!win) return Promise.reject(new Error("This PC can't take its keys for Control (it needs 64-bit Windows)"))
      keyGrab ??= createKeyGrab({ log, postThreadMessage: (thread, message) => win.postThreadMessage(thread, message) })
      return keyGrab.start(onKey, onEnd)
    },

    close(why) {
      for (const s of [...sessions.keys()]) s.close(why)
      power.close()
      keyGrab?.close()
      textFocus?.close()
    },
  }
}
