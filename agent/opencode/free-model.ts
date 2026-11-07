import { isOpenCodeFreeModel, OPENCODE_FREE_DEFAULT } from '../../shared/opencode.ts'

/** Resolve before spawning; never accept a paid/unknown ID or another provider prefix. */
export function freeModel(selected: string): string {
  const model = selected || OPENCODE_FREE_DEFAULT
  if (!isOpenCodeFreeModel(model)) throw new Error('Choose a verified OpenCode free model. Paid or unknown models are not allowed.')
  return model
}
/** The backend's installed catalog is authoritative; missing/unknown prices fail closed. */
export function verifyFreeModel(providers: any, selected: string): string {
  const model = freeModel(selected)
  const info = providers?.all?.find((p: any) => p.id === 'opencode')?.models?.[model]
  const cost = info?.cost
  const zeroTiers = (value: unknown): boolean => typeof value === 'number' ? value === 0 : value !== null && typeof value === 'object' ? Object.values(value).every(zeroTiers) : false
  if (!info || (info.status && info.status !== 'active') || cost?.input !== 0 || cost?.output !== 0 || cost?.cache?.read !== 0 || cost?.cache?.write !== 0 || !zeroTiers(cost)) throw new Error('The installed OpenCode catalog does not confirm this model is free. No request was sent.')
  return model
}
