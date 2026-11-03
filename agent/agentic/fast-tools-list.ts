import { namesFor } from '../../shared/fast-names.ts'
import { fastTools } from './fast-tools.ts'

// F-086/F-087: the tools the fast Assistant's process is shown (names and schemas), for the MCP shim (SAD_TOOLSET=fast) and the host's --allowedTools.
// The list and the rules are in fast-tools.ts; this is only the array the shim wants. The words follow "What the chats are called": the host starts the
// process with SAD_FAST_NAMES=old|new (its brief is written with the same choice), so the shim shows the same names the brief uses.
export const FAST_TOOLS = fastTools(namesFor(process.env.SAD_FAST_NAMES))
