/** Inspect bounded known error fields only; never echo raw SDK errors, headers or credentials. */
export function providerErrorMessage(error: unknown, provider?: string): string {
  const messages: string[] = []
  function collect(value: unknown, depth = 0) {
    if (depth > 4) return
    if (typeof value === 'string') { messages.push(value.slice(0, 8192)); return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['message', 'responseBody', 'data', 'error']) collect(record[key], depth + 1)
  }
  collect(error)
  const message = messages.join(' ')
  if (/free usage limit reached/i.test(message) || (provider === 'opencode' && /quota|rate.?limit|usage.?limit/i.test(message))) return 'OpenCode free usage limit reached. This turn did not complete. No paid fallback was used.'
  return provider === 'opencode' ? 'OpenCode could not complete this turn. Check free-model availability. No paid fallback was used.' : 'OpenCode provider error: check the selected API key and model.'
}
