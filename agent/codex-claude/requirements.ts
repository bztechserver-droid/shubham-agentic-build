/** The exact versions Codex in Claude Code is proved with. Any other version is refused at start-up
 * ("The target has not proved this execution capability"), so these are what each PC must have. */
export const BRIDGE_REQUIREMENTS = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  node: '24.22.1',
  claude: '2.1.319',
  codex: '0.163.0',
})
