import { ensureBinaries, RELEASE } from '../hub/rustdesk-server.ts'
import { log } from '../log.ts'

// npm run setup:hub: puts hbbs.exe and hbbr.exe (rustdesk-server 1.1.16, sha256-pinned) in
// %LOCALAPPDATA%\shubham-agentic\rustdesk-server. Safe to run again: it skips when both are there.
//   --zip <file>   use a release zip you already have (it is checked the same way)
//   --dir <folder> put the exes somewhere else (tests only: a new path means a new firewall prompt)

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const setup = log.child('setup')
try {
  const bins = await ensureBinaries({ zip: flag('--zip'), dir: flag('--dir'), log: setup })
  setup.info(
    bins.fetched
      ? `done: hbbs.exe and hbbr.exe ${RELEASE.version} are in ${bins.dir}`
      : `hbbs.exe and hbbr.exe ${RELEASE.version} are already in ${bins.dir}; nothing to do`,
  )
  setup.info('the hub agent starts them itself (npm run agent -- --role hub)')
} catch (e) {
  setup.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
