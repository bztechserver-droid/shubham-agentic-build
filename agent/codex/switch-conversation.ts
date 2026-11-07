import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeFileContext, conversationLines, writeClaudeRollout } from './from-claude.ts'
import { writeCodexAsClaude } from './to-claude.ts'

export interface SwitchConversationOptions {
  to: 'codex' | 'claude'
  file: string
  cwd: string
  codexHome?: string
  projectsDir?: string
}

/** Standalone disk conversion. Returns a fresh binding; reads only the specified transcript. */
export function switchConversation(options: SwitchConversationOptions): { id: string; file: string } {
  if (options.to === 'claude') {
    if (!options.projectsDir) throw new Error('Claude projects directory is required')
    return writeCodexAsClaude(conversationLines(options.file), options.projectsDir, options.cwd)
  }
  if (!options.codexHome) throw new Error('Codex home is required')
  return writeClaudeRollout(claudeFileContext(options.file).lines, options.codexHome, options.cwd, new Date(), true)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--to' || (args[1] !== 'codex' && args[1] !== 'claude')) {
    console.error('Usage: node agent/codex/switch-conversation.ts --to codex|claude <file> (run from the intended cwd; CODEX_HOME / CLAUDE_CONFIG_DIR select destinations)')
    process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(switchConversation({ to: args[1], file: args[2], cwd: process.cwd(),
        codexHome: process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
        projectsDir: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects') })))
    } catch {
      console.error('Conversion failed: check the transcript, destination permissions and conversation content.')
      process.exitCode = 1
    }
  }
}
