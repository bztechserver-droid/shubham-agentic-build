// o430d (Shubham, 14 Nov 2026): the Agents sidebar can list the PCs instead of the floors: one group per PC, with its two control chats (Chat 1 and Chat 2).
// The PCs and their names come from the hub (the PCs a chat can run on now: `pcs`) and from every PC that has a control workspace (a floor with
// workspace 'pc-control' and its targetPcId, made for every device the hub knows). A PC that is not reachable now is offline, and its chats stay listed.
// Nothing is hardcoded. Pure, tested.

export interface PcViewFloor {
  id: string
  name: string
  workspace?: 'pc-control'
  targetPcId?: string
}

export interface PcViewPc {
  id: string
  name: string
}

export interface PcGroup<F extends PcViewFloor> {
  pcId: string
  /** The hub's name for the PC when it reports one, else the name on its control workspace. */
  name: string
  /** Reachable now (in the hub's `pcs`). */
  online: boolean
  /** Its control workspace (its two chats), or null when the hub knows the PC but it has none yet. */
  floor: F | null
}

/**
 * One group per PC: the hub's PCs first (in the hub's order), then the PCs that only have a control workspace (offline now), in the list's order.
 * A PC appears once. The floors given are the list's floors; only the control workspaces are used here.
 */
export function pcGroups<F extends PcViewFloor>(floors: readonly F[], pcs: readonly PcViewPc[]): PcGroup<F>[] {
  const control = floors.filter((f): f is F & { targetPcId: string } => f.workspace === 'pc-control' && typeof f.targetPcId === 'string' && f.targetPcId !== '')
  const out: PcGroup<F>[] = []
  const seen = new Set<string>()
  for (const pc of pcs) {
    if (!pc.id || seen.has(pc.id)) continue
    seen.add(pc.id)
    const floor = control.find(f => f.targetPcId === pc.id) ?? null
    out.push({ pcId: pc.id, name: pc.name || floor?.name || 'This PC', online: true, floor })
  }
  for (const f of control) {
    if (seen.has(f.targetPcId)) continue
    seen.add(f.targetPcId)
    out.push({ pcId: f.targetPcId, name: f.name, online: false, floor: f })
  }
  return out
}
