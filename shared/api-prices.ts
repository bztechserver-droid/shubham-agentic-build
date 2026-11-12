import type { FastModel } from './fast.ts'

// Order o7f34: what the API answer costs. The prices are Anthropic's, as its pricing page lists them (platform.claude.com/docs/en/about-claude/
// pricing, read 12 Nov 2026), USD per million tokens. Only what the efficient route uses is here: Haiku 5.5 (Fast) and Sonnet 5.5 (Thorough).
// The cache columns are what a prompt cache costs (a write, and a read of the same prefix again); the page's prompt is cached, so a repeat
// question costs less on its prompt. Batch and fast mode are not used and not priced here.

export const API_MODEL_IDS: Record<FastModel, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' }

export interface Price {
  input: number
  output: number
  /** A prompt written to the cache (5-minute cache). */
  cacheWrite: number
  /** A prompt read from the cache. */
  cacheRead: number
}

/** Haiku 5.5 has a higher price for a prompt over 100,000 tokens; the route's prompts are well under that. */
export const PRICES: Record<FastModel, { upTo100k: Price; over100k?: Price }> = {
  haiku: {
    upTo100k: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    over100k: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  sonnet: { upTo100k: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
}

export interface TokenUse {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** What one answer costs in dollars, from its token counts (the prompt is input + cache writes + cache reads). */
export function costUsd(model: FastModel, u: TokenUse): number {
  const prompt = u.input + u.cacheWrite + u.cacheRead
  const p = model === 'haiku' && prompt > 100_000 && PRICES.haiku.over100k ? PRICES.haiku.over100k : PRICES[model].upTo100k
  const dollars = (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1_000_000
  return Math.round(dollars * 1e6) / 1e6
}
