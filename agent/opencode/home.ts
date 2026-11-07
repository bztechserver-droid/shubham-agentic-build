import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ApiCredential } from './crm.ts'

export function isolatedEnvironment(root: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'Path']) if (base[k]) env[k] = base[k]!
  for (const [k, dir] of Object.entries({ HOME: 'home', USERPROFILE: 'home', OPENCODE_TEST_HOME: 'home', XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', APPDATA: 'roaming', LOCALAPPDATA: 'local', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', OPENCODE_CONFIG_DIR: 'config-dir' })) {
    env[k] = path.join(root, dir); mkdirSync(env[k], { recursive: true })
  }
  for (const flag of ['PURE', 'DISABLE_AUTOUPDATE', 'DISABLE_DEFAULT_PLUGINS', 'DISABLE_LSP_DOWNLOAD', 'DISABLE_MODELS_FETCH', 'DISABLE_PROJECT_CONFIG', 'DISABLE_EXTERNAL_SKILLS', 'DISABLE_CLAUDE_CODE', 'DISABLE_EMBEDDED_WEB_UI', 'DISABLE_TERMINAL_TITLE']) env[`OPENCODE_${flag}`] = 'true'
  env.OPENCODE_AUTH_CONTENT = '{}'
  // 1.19.4's config loader calls Arborist even in PURE mode. Its package
  // resolver must remain offline: no unapproved background registry downloads.
  env.npm_config_offline = 'true'
  env.npm_config_registry = 'http://127.0.0.1:9'
  env.npm_config_cache = path.join(root, 'npm-cache')
  env.npm_config_fetch_retries = '0'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.OPENCODE_DB = path.join(root, 'data', 'opencode.db')
  return env
}
/** Key is added to the backend environment only, after all non-secret config is built. */
export function providerEnvironment(env: Record<string, string>, credential: ApiCredential): Record<string, string> {
  return { ...env, [credential.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']: credential.key }
}
