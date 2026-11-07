import { claudeFileContext, writeClaudeRollout } from './from-claude.ts'

const [source, home] = process.argv.slice(2)
if (!source || !home || process.argv.length !== 4) {
  console.error('Usage: node agent/codex/convert-claude.ts <claude.jsonl> <codex-home>')
  process.exitCode = 1
} else {
  try {
    // Explicit cwd is this invocation's directory; no transcript metadata or credentials are copied.
    const result = writeClaudeRollout(claudeFileContext(source).lines, home, process.cwd())
    console.log(JSON.stringify(result))
  } catch {
    console.error('Conversion failed: check the input file and destination permissions.')
    process.exitCode = 1
  }
}
