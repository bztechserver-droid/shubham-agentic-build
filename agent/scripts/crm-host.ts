import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// F-126: the Windows CRM drive host (crm-fs/, C# on WinFsp) goes into every build that can make it. It is built on the publishing PC with the pinned .NET SDK
// (unzipped under %LOCALAPPDATA%\dotnet-sdk-8, called by full path, nothing on PATH) from the sources in Dev's crm-fs/, with the packages restored in LOCKED mode
// (packages.lock.json) and nuget.org signatures required (nuget.config). The build runs in a SHORT folder: the net48 reference assemblies are not found past MAX_PATH.
// The finished program is copied to <build>/crm-fs/, and its SHA-256 goes into RELEASE.json (crmFsSha256), which the agent checks before it starts the host.
// If it can't be made (no SDK, not Windows, a failure) the publish says so plainly and carries on: the page then tells the person the drive program is not in this build.

export const CRM_HOST_DIR = 'crm-fs'
/** Where the built program waits in Dev between the build and the assembly (not in git). */
export const CRM_HOST_OUT = 'dist-crmfs'
export const CRM_HOST_EXE = 'crm-fs.exe'
const SOURCES = ['Program.cs', 'crm-fs.csproj', 'nuget.config', 'packages.lock.json']

export type Run = (cmd: string, args: string[], cwd: string, o?: { shell?: boolean; env?: NodeJS.ProcessEnv }) => Promise<void>

export interface CrmHostBuild {
  built: boolean
  /** SHA-256 of crm-fs.exe when built. */
  sha256?: string
  /** Plain words for the publish log when it was not built. */
  why?: string
}

export interface CrmHostOptions {
  /** dotnet.exe of the pinned SDK (default: %LOCALAPPDATA%\dotnet-sdk-8\dotnet.exe). */
  sdk?: string
  /** A short folder to build in (default: <system drive>\crmfs-build). */
  workDir?: string
  platform?: NodeJS.Platform
}

export function defaultSdk(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LOCALAPPDATA ?? '', 'dotnet-sdk-8', 'dotnet.exe')
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Builds the host. Never throws for a missing SDK or a failed build: it says why in the result. */
export async function buildCrmHost(dev: string, run: Run, o: CrmHostOptions = {}): Promise<CrmHostBuild> {
  rmSync(path.join(dev, CRM_HOST_OUT), { recursive: true, force: true })
  if ((o.platform ?? process.platform) !== 'win32') return { built: false, why: 'this PC is not Windows, and the drive host is a Windows program' }
  const sdk = o.sdk ?? defaultSdk()
  if (!existsSync(sdk)) return { built: false, why: `the .NET SDK was not found at ${sdk}` }
  const src = path.join(dev, CRM_HOST_DIR)
  const missing = SOURCES.filter(f => !existsSync(path.join(src, f)))
  if (missing.length) return { built: false, why: `crm-fs/ is missing ${missing.join(', ')}` }

  const work = o.workDir ?? path.join(process.env.SystemDrive ?? 'C:', 'crmfs-build')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  for (const f of SOURCES) cpSync(path.join(src, f), path.join(work, f))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_HOME: path.join(path.dirname(sdk), '.home'),
    NUGET_PACKAGES: path.join(work, '.nuget'),
  }
  try {
    await run(sdk, ['restore', 'crm-fs.csproj', '--locked-mode'], work, { env })
    await run(sdk, ['build', 'crm-fs.csproj', '-c', 'Release', '--no-restore'], work, { env })
    const out = path.join(work, 'bin', 'Release', 'net48')
    const exe = path.join(out, CRM_HOST_EXE)
    if (!existsSync(exe) || statSync(exe).size < 10_000) return { built: false, why: `the build made no usable ${CRM_HOST_EXE}` }
    const dest = path.join(dev, CRM_HOST_OUT)
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(out)) if (!/\.pdb$/i.test(name) && statSync(path.join(out, name)).isFile()) cpSync(path.join(out, name), path.join(dest, name))
    return { built: true, sha256: sha256Of(path.join(dest, CRM_HOST_EXE)) }
  } catch (e) {
    return { built: false, why: `the build failed (${(e as Error).message.split('\n')[0].slice(0, 160)})` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Puts the built host into the assembled build (<build>/crm-fs/) and returns the exe's SHA-256. Throws if it isn't there. */
export function shipCrmHost(dev: string, stage: string): string {
  const exe = path.join(dev, CRM_HOST_OUT, CRM_HOST_EXE)
  if (!existsSync(exe)) throw new Error(`The CRM drive host was not built: ${exe} is missing.`)
  cpSync(path.join(dev, CRM_HOST_OUT), path.join(stage, CRM_HOST_DIR), { recursive: true })
  return sha256Of(path.join(stage, CRM_HOST_DIR, CRM_HOST_EXE))
}
