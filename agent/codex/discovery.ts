/** A rollout may first be flushed after lengthy onboarding or a slow first response. Never abandon a live chat. */
export function watchForThread(options: { active: () => boolean; discover: () => boolean; failed?: (error: unknown) => void; intervalMs?: number }): () => void {
  const timer = setInterval(() => {
    if (!options.active()) { clearInterval(timer); return }
    try { if (options.discover()) clearInterval(timer) } catch (error) { options.failed?.(error) }
  }, options.intervalMs ?? 1000)
  timer.unref()
  return () => clearInterval(timer)
}
