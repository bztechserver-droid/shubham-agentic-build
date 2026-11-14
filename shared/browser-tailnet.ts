// Order o34a3 (Shubham: "The whole idea is people will open their Tailscale ports, I should be able to use and navigate using my assistant here."):
// the Browser page's "Tailnet" list, built from PC control › Ports (shared/pc-ports.ts: each PC's ports as its agent reports them, with links that
// were already checked to be Tailscale names or addresses). Shared ports first (they open now from any of his devices), then the other ports that
// something listens on (they open on that PC, or once shared). The app's own ports are left out (the app inside its own browser).

import { agentMayOpen } from './browser.ts'
import type { PcPortsReport } from './pc-ports.ts'

export interface TailnetShortcut {
  /** The address that opens it (always a tailnet one). */
  url: string
  /** Which PC, and what the port is ("Chat 1 (stable port)", "node"...). */
  pc: string
  what: string
  port: number
  /** Shared on Tailscale now (it opens from his other devices). */
  shared: boolean
}

export function tailnetShortcuts(pcs: { name: string; report: PcPortsReport }[]): TailnetShortcut[] {
  const out: TailnetShortcut[] = []
  const seen = new Set<string>()
  for (const { name, report } of pcs) {
    for (const r of report.rows) {
      if (r.group === 'app') continue
      const shared = r.url !== null || r.serverUrl !== null
      const url = r.url ?? r.serverUrl ?? (r.listening === true ? r.address : null)
      if (!url || !agentMayOpen(url) || seen.has(url)) continue
      seen.add(url)
      out.push({ url, pc: name, what: r.program && r.what !== r.program ? `${r.what} (${r.program})` : r.what, port: r.port, shared })
    }
  }
  return out.sort((a, b) => Number(b.shared) - Number(a.shared) || a.pc.localeCompare(b.pc) || a.port - b.port)
}
