import { statSync } from 'node:fs'

/** A historical cwd is provenance, not proof that the directory exists on this PC.
 * Keep the transcript untouched and use the floor's validated local folder if it moved. */
export function executionLaunchCwd(historical: string | null | undefined, fallback: () => string,
  isDirectory: (directory: string) => boolean = directory => statSync(directory).isDirectory()): string {
  if (historical) {
    try { if (isDirectory(historical)) return historical } catch { /* Missing or inaccessible here. */ }
  }
  return fallback()
}
