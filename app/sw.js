// F-036: the service worker that makes the page installable as an app on the phone.
// It keeps nothing: every request goes to the network as before (the page, its assets, the
// agent API and its WebSockets are never touched). Only when opening a page fails outright
// (the phone offline, the server or the gate down) does it answer with a small page saying
// so, with a Try again button, rather than the browser's own error, which in an installed
// app has no address bar to retry from. (F-057: the page presses it by itself as soon as the
// server answers again.)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

const OFFLINE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a"><title>Can't reach the server</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#ededed;font:15px/1.5 system-ui,sans-serif}
  main{min-height:100%;display:grid;place-content:center;gap:12px;padding:24px;text-align:center}
  .mark{margin:0 auto;width:48px;height:48px;border-radius:12px;background:#d4a437;color:#0a0a0a;display:grid;place-items:center;font:700 20px ui-monospace,Consolas,monospace}
  h1{margin:8px 0 0;font-size:18px} p{margin:0;color:#a1a1a1;max-width:32ch}
  button{margin:12px auto 0;height:44px;padding:0 20px;border:0;border-radius:8px;background:#ededed;color:#0a0a0a;font:600 15px system-ui,sans-serif}
</style></head>
<body><main>
  <div class="mark">&gt;_</div>
  <h1>Can't reach the server</h1>
  <p>Check that this phone is online and on Tailscale, and that the server is on.</p>
  <button onclick="location.reload()">Try again</button>
</main>
<script>
  // F-057: it tries again by itself, so that an update or a restart of the server, or a phone that
  // was offline, needs no tap: every few seconds, the moment the phone is back online, and the
  // moment this page is shown again. The app itself comes up as soon as the server answers.
  const back = () => fetch(location.href, { cache: 'no-store' }).then(r => { if (r.ok) location.reload() }, () => {})
  setInterval(back, 4000)
  addEventListener('online', back)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) back() })
</script></body></html>`

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.mode !== 'navigate') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/agent-api')) return
  event.respondWith(
    fetch(req).catch(
      () => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }),
    ),
  )
})
