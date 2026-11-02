// F-080: the names Whisper must get right, given to it as a prompt (with the sentence before, so it
// keeps the thread), and a few fixes for what it still gets wrong; also the lines Whisper is known to
// invent on silence or noise, which are dropped.

export const NAMES = ['Chris', 'Overlay', 'Lead', 'Web', 'Mobile', 'Connection', 'WhatsApp', 'Voice', 'TaxableBZ', 'CRM', 'GST', 'Shubham', 'Claude', 'Tailscale', 'RustDesk', 'APK']

const PROMPT_TAIL = 200

/** The prompt for one sentence: the names (and any the caller adds), then what he said just before. */
export function promptFor(before = '', extra: readonly string[] = []): string {
  const names = [...new Set([...NAMES, ...extra.map(w => w.trim()).filter(w => w && w.length <= 40)])].slice(0, 60)
  const head = `Shubham talks to his agents ${names.join(', ')}.`
  const tail = before.trim().slice(-PROMPT_TAIL)
  return tail ? `${head} ${tail}` : head
}

const FIXES: [RegExp, string][] = [
  [/\btaxable[\s-]*b\.?\s*z\.?(?=\W|$)/gi, 'TaxableBZ'],
  [/\btaxable[\s-]*bees?\b/gi, 'TaxableBZ'],
  [/\bc\.\s?r\.\s?m\.?(?=\W|$)/gi, 'CRM'],
  [/\bg\.\s?s\.\s?t\.?(?=\W|$)/gi, 'GST'],
  [/\bwhats\s?app\b/gi, 'WhatsApp'],
  [/\b(?:kris|chriss)\b/gi, 'Chris'],
]

/** Whisper's well-known inventions on silence, music or noise: a sentence that is only one of these is nothing. */
const INVENTED = [
  /^\s*\[(?:blank_audio|music|silence|no speech|inaudible)\]\s*$/i,
  /^\s*\((?:music|silence|applause|laughs?|background noise)\)\s*$/i,
  /^\s*(?:thank you|thanks for watching|thank you for watching|please subscribe|subtitles by[^.]*)[.!]*\s*$/i,
  /^\s*(?:you|\.+)\s*$/i,
]

/** What Whisper said, cleaned: tags and timestamps out, names fixed, inventions dropped (empty string). */
export function clean(text: string): string {
  let t = text
    .replace(/\[\d\d:\d\d[:.\d]*\s*-->\s*\d\d:\d\d[:.\d]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (INVENTED.some(r => r.test(t))) return ''
  t = t.replace(/\[(?:blank_audio|music|silence|inaudible)\]/gi, ' ').replace(/\s+/g, ' ').trim()
  for (const [r, to] of FIXES) t = t.replace(r, to)
  return t
}

/** The Whisper language for a BCP-47 tag from Settings (en-IN -> en); 'auto' lets Whisper choose. */
export function whisperLang(tag: string | undefined | null): string {
  const t = (tag ?? '').trim().toLowerCase()
  if (!t) return 'en'
  if (t === 'auto') return 'auto'
  const base = t.split(/[-_]/)[0]
  return /^[a-z]{2,3}$/.test(base) ? base : 'en'
}
