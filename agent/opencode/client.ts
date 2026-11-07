export class OpenCodeClient {
  readonly url: string
  #headers: Record<string, string>
  constructor(port: number, password: string, cwd: string) {
    this.url = `http://127.0.0.1:${port}`
    this.#headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json', 'x-opencode-directory': cwd }
  }
  async request(route: string, method = 'GET', body?: unknown, timeout = 30000): Promise<any> {
    const res = await fetch(this.url + route, { method, headers: this.#headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) })
    if (!res.ok) { await res.body?.cancel(); throw new Error(`OpenCode request failed (${res.status}).`) }
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
  async events(signal: AbortSignal, onEvent: (event: any) => void): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch(this.url + '/event', { headers: this.#headers, signal })
        if (!res.ok || !res.body) throw new Error('OpenCode event connection failed')
        const decoder = new TextDecoder(); let pending = ''
        for await (const chunk of res.body) {
          pending += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
          let end: number
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2)
            for (const line of frame.split('\n')) if (line.startsWith('data: ')) { try { onEvent(JSON.parse(line.slice(6))) } catch { /* malformed event */ } }
          }
          if (pending.length > 4 * 1024 * 1024) throw new Error('OpenCode event frame too large')
        }
      } catch { if (signal.aborted) return }
      if (!signal.aborted) { onEvent({ type: 'reconnect' }); await new Promise(resolve => setTimeout(resolve, 1000)) }
    }
  }
}
