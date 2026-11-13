// Order o528e: the pages of a PDF from the CRM, drawn as pictures on the PC that serves the page (the Server), so the phone's WebView, which has no PDF
// viewer of its own, shows them as plain pictures. No new package (Lead, 13 Nov: pdf.js is Shubham's call): Windows' own PDF reader (Windows.Data.Pdf, the
// one the Photos and Reader apps use), from Windows PowerShell 5.1. One PowerShell at a time for the whole app, a few pages per run (the one asked for and the
// next two, which a swipe wants next), each page written to a temporary name and then renamed, so a half-written picture is never served. Not on Windows:
// there is no reader (the card then offers the download only).

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

/** The PowerShell, run with -EncodedCommand (no quoting of a path on a command line). It reads SAD_PDF_IN (the PDF), SAD_PDF_PAGES (1-based, comma
 *  separated; empty: count only), SAD_PDF_WIDTH (pixels) and SAD_PDF_OUT (each page goes to <SAD_PDF_OUT><n>.jpg), and prints the number of pages. A page
 *  whose longer side would pass 8192 pixels at that width is drawn smaller (a long strip of a drawing). */
export const PDF_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$all = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asOp = $all | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
$asAct = $all | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [type]$t) { $k = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); $k.Wait(-1) | Out-Null; $k.Result }
function AwaitAction($a) { $k = $asAct.Invoke($null, @($a)); $k.Wait(-1) | Out-Null }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SAD_PDF_IN)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$n = [int]$doc.PageCount
$w = [int]$env:SAD_PDF_WIDTH
$most = 8192
function Draw($p, [double]$dw, [double]$dh, [bool]$jpeg) {
  $o = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $o.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($dw))
  $o.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round($dh))
  if ($jpeg) { $o.BitmapEncoderId = [Windows.Graphics.Imaging.BitmapEncoder]::JpegEncoderId }
  $mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($p.RenderToStreamAsync($mem, $o))
  $size = [uint32]$mem.Size
  $r = New-Object Windows.Storage.Streams.DataReader($mem.GetInputStreamAt(0))
  $null = Await ($r.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $r.ReadBytes($bytes)
  $r.Dispose()
  $mem.Dispose()
  return ,$bytes
}
if ($env:SAD_PDF_PAGES) {
  # Windows draws at the screen's scale (150%: 720 pixels for 480): measured once per run by a 100-pixel PNG of the first page (its width is in its
  # header), then every page is asked for that much less.
  $first = $doc.GetPage(0)
  $probe = Draw $first 100 100 $false
  $first.Dispose()
  $scale = [double](([int]$probe[16] * 16777216) + ([int]$probe[17] * 65536) + ([int]$probe[18] * 256) + [int]$probe[19]) / 100.0
  if ($scale -le 0) { $scale = 1.0 }
  foreach ($one in $env:SAD_PDF_PAGES.Split(',')) {
    $i = [int]$one
    if ($i -lt 1 -or $i -gt $n) { continue }
    $p = $doc.GetPage([uint32]($i - 1))
    $ratio = $p.Size.Height / [Math]::Max(1.0, $p.Size.Width)
    $dw = [double]$w
    $dh = [Math]::Round($w * $ratio)
    if ($dh -gt $most) { $dh = $most; $dw = [Math]::Max(1, [Math]::Round($most / $ratio)) }
    if ($dw -gt $most) { $dw = $most; $dh = [Math]::Max(1, [Math]::Round($most * $ratio)) }
    # JPEG: a fifth of a PNG's bytes for a scanned page, and as sharp to read (measured on a real CRM PDF).
    $bytes = Draw $p ($dw / $scale) ($dh / $scale) $true
    $out = $env:SAD_PDF_OUT + $i + '.jpg'
    [System.IO.File]::WriteAllBytes($out + '.tmp', $bytes)
    Move-Item -LiteralPath ($out + '.tmp') -Destination $out -Force
    $p.Dispose()
  }
}
[Console]::Out.Write($n)
`

/** Runs the script with these settings; answers what it printed. */
export type PdfRun = (env: { SAD_PDF_IN: string; SAD_PDF_PAGES: string; SAD_PDF_WIDTH: string; SAD_PDF_OUT: string }, timeoutMs: number) => Promise<string>

export const runPowerShell: PdfRun = (env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(PDF_SCRIPT, 'utf16le').toString('base64')
    // execFile's timeout stops this one child (its own pid), nothing else.
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(new Error(String(stderr || err.message).replace(/\s+/g, ' ').trim().slice(0, 300)), { timedOut: (err as { killed?: boolean }).killed === true }))
        else resolve(String(stdout).trim())
      },
    )
  })

export class PdfUnreadable extends Error {}

export interface PdfPages {
  /** Whether pages can be drawn on this PC at all. */
  readonly can: boolean
  /** How many pages the PDF at `file` has (asked once per `key`). */
  count(key: string, file: string): Promise<number>
  /** Page `page` (1-based) drawn `width` pixels wide: the path of its JPEG, `out(page, width)`; drawn now (with the next two) unless it is there already. */
  page(key: string, file: string, page: number, width: number, out: (page: number, width: number) => string): Promise<string>
}

export function createPdfPages(o: { run?: PdfRun; can?: boolean; timeoutMs?: number; ahead?: number } = {}): PdfPages {
  const run = o.run ?? runPowerShell
  const can = o.can ?? process.platform === 'win32'
  const timeoutMs = o.timeoutMs ?? 90_000
  const ahead = o.ahead ?? 2
  const counts = new Map<string, number>()
  const busy = new Map<string, Promise<void>>()
  let chain: Promise<unknown> = Promise.resolve()
  /** One PowerShell at a time, for the whole app. */
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const p = chain.then(job, job)
    chain = p.catch(() => undefined)
    return p
  }
  const exists = (file: string) =>
    stat(file).then(
      s => s.isFile() && s.size > 0,
      () => false,
    )
  const unreadable = (e: unknown) => new PdfUnreadable((e as { timedOut?: boolean }).timedOut ? 'Drawing this PDF took too long.' : `Windows could not read this PDF (it may be locked with a password or damaged): ${(e as Error).message}`)

  const counting = new Map<string, Promise<number>>()
  function count(key: string, file: string): Promise<number> {
    const known = counts.get(key)
    if (known !== undefined) return Promise.resolve(known)
    if (!can) return Promise.reject(new PdfUnreadable('The pages of a PDF are drawn on Windows only.'))
    let going = counting.get(key)
    if (!going) {
      going = queue(() => run({ SAD_PDF_IN: file, SAD_PDF_PAGES: '', SAD_PDF_WIDTH: '0', SAD_PDF_OUT: '' }, timeoutMs))
        .catch(e => {
          throw unreadable(e)
        })
        .then(said => {
          const n = Number(said.split(/\s+/).pop())
          if (!Number.isSafeInteger(n) || n < 1) throw new PdfUnreadable('Windows found no pages in this PDF.')
          counts.set(key, n)
          return n
        })
        .finally(() => counting.delete(key))
      counting.set(key, going)
    }
    return going
  }

  return {
    can,
    count,
    async page(key, file, page, width, out) {
      const want = out(page, width)
      if (await exists(want)) return want
      const n = await count(key, file)
      if (page < 1 || page > n) throw new PdfUnreadable(`This PDF has ${n} page${n === 1 ? '' : 's'}.`)
      const job = `${key}:${width}:${page}`
      // From here to busy.set nothing waits: two asks for the same page join one run.
      let running = busy.get(job)
      if (!running) {
        // This page and the next ones nobody is drawing, in one run (those drawn already are left out when it runs); each is "busy" until it ends.
        const list: number[] = [page]
        for (let p = page + 1; p <= Math.min(n, page + ahead); p++) if (!busy.has(`${key}:${width}:${p}`)) list.push(p)
        const prefix = want.slice(0, -`${page}.jpg`.length)
        running = queue(async () => {
          const todo: number[] = []
          for (const p of list) if (!(await exists(out(p, width)))) todo.push(p)
          if (todo.length === 0) return
          await run({ SAD_PDF_IN: file, SAD_PDF_PAGES: todo.join(','), SAD_PDF_WIDTH: String(width), SAD_PDF_OUT: prefix }, timeoutMs)
        })
          .catch(e => {
            throw unreadable(e)
          })
          .finally(() => {
            for (const p of list) busy.delete(`${key}:${width}:${p}`)
          })
        for (const p of list) busy.set(`${key}:${width}:${p}`, running)
      }
      await running
      if (!(await exists(want))) throw new PdfUnreadable('Windows did not draw that page.')
      return want
    },
  }
}
