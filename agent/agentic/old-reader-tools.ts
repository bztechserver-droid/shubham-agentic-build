import type { ToolDef } from './tools.ts'

// Order o5007: the four tools the old-app reader's process is shown (the MCP shim with SAD_TOOLSET=old, and the host's --allowedTools). They
// only READ the old app's folder (Agentic Claude Manager); the hub runs them (old-reader.ts) and refuses anything else from that process's key,
// whatever the model says. This file is only the list (names and schemas), so the shim stays small.

export const OLD_TOOLS: ToolDef[] = [
  {
    name: 'old_map',
    description:
      "The old app's layout: its folders and files (with sizes), two levels below `folder` (the whole app when left out). Use it when you do not know where something lives.",
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: "A folder of the old app, relative to its root (e.g. 'server/lib'). Left out: the root." } },
      additionalProperties: false,
    },
  },
  {
    name: 'old_find',
    description: "Find files of the old app by name or path, case-insensitive: a part of the path ('drive', 'server/lib') or a pattern with * and ? ('frontend/**/*Panel*.tsx'). Returns paths relative to the old app's root.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A part of the path, or a pattern with * (any characters in one folder), ** (any folders) and ?.' },
        limit: { type: 'number', description: 'At most this many paths (default 50, at most 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'old_grep',
    description:
      "Search the old app's files for text. Returns path:line and the line for each match (case-insensitive unless caseSensitive is true). Plain text by default; regex true for a JavaScript regular expression. Narrow it with `path` (a folder, a file, or a pattern like '*.js').",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to look for (at most 200 characters).' },
        regex: { type: 'boolean', description: 'true: `text` is a regular expression.' },
        path: { type: 'string', description: "Only files under this folder, this file, or matching this pattern ('server', 'frontend/src/App.tsx', '*.cs')." },
        caseSensitive: { type: 'boolean' },
        limit: { type: 'number', description: 'At most this many matching lines (default 40, at most 100).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'old_read',
    description: "Read a file of the old app with line numbers: 200 lines from `from` by default (at most 400). Big files: find the place with old_grep first, then read around it.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "The file, relative to the old app's root (e.g. 'server/lib/chats.js')." },
        from: { type: 'number', description: 'The first line to read (1 is the first line of the file).' },
        lines: { type: 'number', description: 'How many lines (default 200, at most 400).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

export const OLD_TOOL_NAMES: readonly string[] = OLD_TOOLS.map(t => t.name)

/** The words the page shows while the reader uses a tool. */
export const OLD_TOOL_LABELS: Record<string, string> = {
  old_map: 'Looking at the old app',
  old_find: 'Finding the files',
  old_grep: 'Searching the old app',
  old_read: 'Reading a file',
}
