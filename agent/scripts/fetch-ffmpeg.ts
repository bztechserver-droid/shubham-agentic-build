import { log } from '../log.ts'
import { ensureFfmpeg, FFMPEG } from '../screen/ffmpeg.ts'

// npm run setup:screen: puts ffmpeg.exe (FFmpeg 9.0.2, sha256-pinned) in
// %LOCALAPPDATA%\shubham-agentic\ffmpeg, for the app's own screen (F-006). Safe to run again: it
// skips when the right one is there. A running agent notices it within a minute; the Devices
// page's Set up does the same download.
//   --zip <file>   use a release zip you already have (it is checked the same way)

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const setup = log.child('setup')
try {
  const { exe, fetched } = await ensureFfmpeg({ zip: flag('--zip'), log: setup })
  setup.info(fetched ? `done: FFmpeg ${FFMPEG.version} is at ${exe}` : `FFmpeg ${FFMPEG.version} is already at ${exe}; nothing to do`)
  setup.info('other PCs can now open this PC’s own screen through the app (a running agent notices within a minute)')
} catch (e) {
  setup.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
