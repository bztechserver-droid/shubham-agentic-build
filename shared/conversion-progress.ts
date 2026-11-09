export const CONVERSION_STAGES = ['checking', 'stopping', 'reading', 'converting', 'verifying', 'saving', 'opening', 'complete', 'failed'] as const
export type ConversionStage = typeof CONVERSION_STAGES[number]
export interface ConversionProgress {
  version: 1
  operationId: string
  agentId: string
  stage: ConversionStage
  startedAtMs: number
  updatedAtMs: number
  completedBytes: number
  totalBytes: number
  convertedRows: number
}
export const CONVERSION_LABELS: Record<ConversionStage, string> = {
  checking: 'Checking the conversation', stopping: 'Saving the final messages', reading: 'Reading saved history',
  converting: 'Converting the conversation', verifying: 'Verifying the complete transfer', saving: 'Saving the converted conversation',
  opening: 'Opening the new terminal', complete: 'Conversation converted', failed: 'Conversion needs attention',
}
export function readConversionProgress(value: unknown): ConversionProgress | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid conversion progress')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(k => !['version','operationId','agentId','stage','startedAtMs','updatedAtMs','completedBytes','totalBytes','convertedRows'].includes(k))
    || r.version !== 1 || typeof r.operationId !== 'string' || !/^[\w-]{16,128}$/.test(r.operationId)
    || typeof r.agentId !== 'string' || !/^[\w-]{1,128}$/.test(r.agentId) || !CONVERSION_STAGES.includes(r.stage as ConversionStage)
    || ['startedAtMs','updatedAtMs','completedBytes','totalBytes','convertedRows'].some(k => !Number.isSafeInteger(r[k]) || (r[k] as number) < 0)
    || (r.completedBytes as number) > (r.totalBytes as number) || (r.updatedAtMs as number) < (r.startedAtMs as number)) throw Error('Invalid conversion progress')
  return r as unknown as ConversionProgress
}
