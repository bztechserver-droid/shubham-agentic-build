import type { ConversionProgress, ConversionStage } from '../../shared/conversion-progress.ts'

/** Redacted, bounded observations. No paths, history, credentials or start/replay capability. */
export function createConversionProgress(now = Date.now) {
  const records = new Map<string, ConversionProgress>()
  const key = (floor: string, agent: string) => `${floor}:${agent}`
  return {
    get(floor: string, agent: string) {
      const r = records.get(key(floor, agent))
      return r && now() - r.updatedAtMs < 24 * 60 * 60_000 ? { ...r } : null
    },
    begin(floor: string, agent: string, operationId: string) {
      const current = records.get(key(floor, agent))
      if (current?.operationId === operationId) return
      if (records.size >= 256) {
        const oldest = [...records.entries()].filter(([,v]) => ['complete','failed'].includes(v.stage)).sort((a,b) => a[1].updatedAtMs-b[1].updatedAtMs)[0]
        if (oldest) records.delete(oldest[0]); else throw Error('Too many active conversions')
      }
      const at = now()
      records.set(key(floor, agent), { version: 1, operationId, agentId: agent, stage: 'checking', startedAtMs: at, updatedAtMs: at, completedBytes: 0, totalBytes: 0, convertedRows: 0 })
    },
    update(floor: string, agent: string, stage: ConversionStage, transfer?: { completedBytes: number; totalBytes: number; convertedRows: number }) {
      const k = key(floor, agent), r = records.get(k)
      if (!r) return
      records.set(k, { ...r, ...transfer, stage, updatedAtMs: now() })
    },
  }
}
