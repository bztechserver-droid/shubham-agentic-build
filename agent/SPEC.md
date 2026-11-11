# Device agent: phase 1 spec (F-004)

The why lives in `design/features/F-004-device-link.md` (Round 2, Route A), and the evidence
in `design/features/F-004-research-round2.json`. This file is the build contract: what to
build, the module boundaries, and the exact flows. If the research contradicts something
here, follow the research and fix this file in the same change.

## Phase 1 scope

"At home": everything works on one LAN, with no router and no admin changes.

- The hub (this server PC) runs unmodified RustDesk servers hbbs and hbbr 1.1.16, plus this
  agent.
- Members (the laptop, any PC) run this agent.
- A member pairs with the hub once, then keeps a pinned, mutually authenticated TLS 1.3 link
  to it. **Same network first:** a direct TLS probe to the hub's LAN address.
- Otherwise the member goes through hbbs:
  - hbbs's LAN answer (FetchLocalAddr) gives a direct TLS connection to the hub;
  - otherwise the relay through hbbr.
  The relay path is proven on the LAN with How to connect set to Relay only. Phase 2 only
  adds the public endpoints (router forwards).
- **Tailscale** (added 2026-10-29, Shubham asked for it): when both PCs run Tailscale, the
  hub also listens on its Tailscale address, and a member away from the hub's network links
  there before it tries hbbs. It works before the firewall in front of the hub is opened, and
  stays optional: a PC without Tailscale uses the other ways.
- **How to connect** (the `route` setting, chosen on each member's Devices page): `auto`
  (same network, Tailscale, then hbbs/hbbr), `tailscale` (Tailscale only), `rustdesk` (same
  network, then hbbs/hbbr) or `relay` (hbbr only, for testing). The hub accepts every way.
- RustDesk remote screen ("Mode 1"): the member opens a loopback port, pipes it over the
  link to the hub, and the hub pipes it to RustDesk's direct-access port 21118.
- A Devices page in the app.

Not in phase 1: member-to-member links, members registering with hbbs, start at logon,
Windows services, Mode 2 (RustDesk installs moved onto our hbbs), the phone, and hole
punching (never: pure Node on Windows can't).

## Runtime and layout

- TypeScript run directly by Node (type stripping, Node ≥ 22.18; this PC has 24.22.1).
  **No build step.** Erasable syntax only: no enums, no namespaces, no parameter
  properties. Relative imports keep the `.ts` extension. `tsconfig.agent.json` type-checks
  `agent/` and `shared/` in `npm run build` (strict).
- One dependency: `protobufjs` 8.8.1 (BSD-3). Everything else is `node:*`. X.509
  certificates come from our own tiny DER builder (Ed25519), with no certificate library.
- Tests: `node:test` + `node:assert/strict`, files `agent/**/*.test.ts` (and, since F-005,
  `shared/**/*.test.ts`), run with `npm run test:agent`. The slow end-to-end test with real
  hbbs/hbbr is `agent/test/e2e.ts`, run with `npm run test:e2e`.
- Code style: match `src/` and `feature-log.ts`. Short comments that say why. No classes
  where a function will do.

```
agent/
  main.ts                 entry: parse flags, load config, start everything, log
  config.ts               state root, config.json, ports, env overrides
  log.ts                  tiny logger: console + rotating file in <state>/agent/logs
  net.ts                  LAN address/subnet detection, private-address checks
  rendezvous/
    rendezvous.proto      copy of design/features/F-004-probes/round2/sad-rendezvous.proto
    codec.ts              BytesCodec framing + AddrMangle (port of round2/wire.mjs)
    messages.ts           protobufjs: encode/decode RendezvousMessage
    hbbs.ts               UDP registration loop + push handling; TCP one-shot sends; PunchHoleRequest
    relay.ts              connect to hbbr with RequestRelay{uuid, licence_key}
  link/
    der.ts                minimal DER writer (only what a self-signed Ed25519 cert needs)
    identity.ts           device key + self-signed cert + device id + persistent uuid
    tls.ts                pinned mutual TLS 1.3 over any socket; SAS check number
    mux.ts                one TLS link: JSON control channel + byte streams + ping/RTT
  hub/
    rustdesk-server.ts    fetch (sha256-pinned) + supervise hbbs/hbbr; status; key
  pairing.ts              codes, requests, SAS, approve/reject; member-side join
  devices.ts              devices.json (hub allowlist / member's pinned hub)
  connect.ts              same-network-first + hbbs + relay orchestration, both roles
  links.ts                live links, reconnect, re-probe, per-device Location/Path/evidence
  discovery.ts            UDP 21222 LAN query/answer for "find the hub"
  rustdesk.ts             find RustDesk.exe, --get-id, Mode 1 tunnel + --connect
  api.ts                  HTTP + WebSocket API on 127.0.0.1 (shared/agent-api.ts)
  local-host.ts           which requests are the app's own pages (Vite's proxy and api.ts)
  scripts/
    fetch-rustdesk-server.ts   npm run setup:hub
    firewall-hub.ps1           admin: LocalSubnet (phase 1) or Any (phase 2) inbound rules
  test/
    e2e.ts                hub + member on this PC against real hbbs/hbbr
    fake-rendezvous.ts    stand-in hbbs/hbbr routing like 1.1.16, for the unit tests
    loopback-hub.ts       a whole hub on 127.0.0.1, for the unit tests
shared/agent-api.ts       API types (already written: the contract with the UI)
```

## State, config and ports

- State root: `SAD_HOME` env, else `%LOCALAPPDATA%\shubham-agentic`, which is outside the
  repo. Under it:
  - `agent/config.json`: `{ role, name, ports: { peer, api, discovery, hbbs, hbbr }, publicHost, lanAddress?, route, stayReachable, stablePorts? }`
    (`stablePorts` `{on, share, chat1, chat2, screen, updates}`: this PC's stable ports, see "Stable ports per PC")
    (`route` is `auto` when missing; a file from before it with `forceRelay: true` reads as `relay`;
    `stayReachable` is true when missing, F-006 › Reachable)
  - `agent/identity/device.key` (PKCS#8 PEM), `device.crt` (PEM), `uuid` (16 random bytes, hex)
  - `agent/api-token` (32 random bytes, hex; created at first start; read by Vite's proxy)
  - `agent/devices.json`
  - `agent/logs/agent-YYYYMMDD.log` (kept 14 days)
  - `rustdesk-server/`: hbbs.exe, hbbr.exe, then at runtime hbbs.ini, id_ed25519(.pub),
    db_v2.sqlite3 and logs/. The exes always come from the canonical
    `%LOCALAPPDATA%\shubham-agentic\rustdesk-server\` (`paths.rustdeskServerBin`), even
    under `SAD_HOME`, so a test with a temp `SAD_HOME` still runs the one exe path the
    firewall knows; only the working folder (`paths.rustdeskServer`) moves.
- Defaults:
  - role `member`; `--role hub` on the command line persists it
  - name = `os.hostname()`
  - publicHost `61.246.245.66`
  - ports: peer **21220** (TCP, hub listens), api **21221** (TCP, 127.0.0.1), discovery
    **21222** (UDP), hbbs **21216** (also uses 21215 and 21218), hbbr **21217** (also
    uses 21219)
  - `SAD_API_PORT`, `SAD_PEER_PORT`, `SAD_DISCOVERY_PORT`, `SAD_HBBS_PORT`,
    `SAD_HBBR_PORT`, `SAD_RUSTDESK_DIRECT_PORT` (default 21118) override them, for tests.
    The overrides apply at load and are never written back; the direct port is
    `Config.rustdeskDirectPort`, not a config.json key.
  - In a hand-edited config.json a missing key takes its default and a wrong one is an
    error that names the key (never silently ignored).
- Never use 127.0.0.1 to reach hbbs (21215) or hbbr (21217): loopback callers get their
  admin consoles. Always use the LAN address. The hub registers from its LAN address too,
  so that hbbs sees it inside `--mask`.
- `net.ts` LAN detection: IPv4 from `os.networkInterfaces()`, keeping only addresses that
  are not internal, not 169.254/16 and not 100.64/10, on adapters whose name does not match
  `/tailscale|vethernet|wsl|hyper-v|virtualbox|vmware|loopback|bluetooth/i`. The config's
  `lanAddress` wins when set (`"192.168.1.118"`, or `"192.168.1.118/24"`; an address no
  adapter has right now keeps its own prefix, else /24). Expose `localSubnets(): {address, cidr}[]`
  (also `prefix`, `broadcast`, `adapter`; the main one first), `primaryLan()`,
  `inLocalSubnet(ip)` and `isPrivate(ip)` (RFC 1918, plus IPv6 unique-local).

## Identity (link/identity.ts)

- Ed25519 keypair via `crypto.generateKeyPairSync('ed25519')`. It is never silently
  overwritten: if one file of the pair is missing, refuse and say how to reset.
- A self-signed X.509 v3 certificate from `der.ts`:
  - serial: 16 random bytes, positive
  - issuer and subject: `CN=sad-<id>`
  - validity: from now − 1 day to + 20 years
  - SPKI: `publicKey.export({type:'spki', format:'der'})`
  - signature algorithm: Ed25519, OID 1.3.101.112 with no parameters
  - signed with `crypto.sign(null, tbs, key)`
  - extensions: basicConstraints (critical, not a CA), keyUsage digitalSignature
    (critical), extKeyUsage serverAuth + clientAuth
  The test must load it with `new crypto.X509Certificate(pem)` and check `.verify(publicKey)`.
- `spkiSha256` = sha256(SPKI DER). Device `id` = lowercase RFC 4648 base32 of
  `spkiSha256`, first 16 characters.
- `uuid`: 16 random bytes, persisted. hbbs binds an ID to its first uuid forever, so a
  missing or malformed `uuid` next to an existing key pair is refused too. A brand-new key
  pair keeps a valid `uuid` already on disk.
- API: `loadOrCreateIdentity(dir, log?): Promise<Identity>` with
  `{ id, key: KeyObject, keyPem, certPem, spkiSha256: Buffer, uuid: Buffer }`. Also
  exported: `spkiSha256(publicKey)`, `deviceId(spkiSha256)`, `base32(buf)`,
  `makeCertificate(key, id)`.

## Pinned mutual TLS (link/tls.ts)

- Use `tls.connect({ socket, key, cert, minVersion: 'TLSv1.3', rejectUnauthorized: false, checkServerIdentity: () => undefined })`.
  The server side uses
  `new tls.TLSSocket(socket, { isServer: true, key, cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' })`
  or a `tls.Server` with the same options.
- After `secureConnect`/`secure`, read `getPeerX509Certificate()`, compute the peer's
  `spkiSha256` and `id`, and call the caller's `verifyPeer(id, spkiSha256)`, which returns a
  boolean (or a promise of one; a throw refuses). On false, destroy the socket. No peer
  certificate at all, or a non-Ed25519 one, also means destroy.
- On the client, `secureConnect` comes before the server has checked the client's
  certificate, so a refused client sees its handshake succeed and then the socket close.
- `sas(tlsSocket, memberNonce, hubNonce)`: `exporter = exportKeyingMaterial(32, 'EXPORTER-sad-pairing-sas', <empty context>)`
  (TLS 1.3 treats no context as an empty one; Node's typings require the argument), then
  `uint32(sha256(exporter ‖ memberNonce ‖ hubNonce)) mod 1,000,000`, zero-padded to 6 digits.
  The nonces are 32 random bytes each (`NONCE_BYTES`). Both ends must get the same value for
  the same nonces. Test this.
  - **Changed from the exporter alone (review, 2026-10-29).** In TLS 1.3 the server sends
    the last inputs to the exporter (ServerHello.random, its certificate and signature) after
    it has seen the ClientHello, so a machine in the middle playing the hub could grind its
    ServerHello (an Ed25519 signature and a few HKDFs a try, about 25 µs) until the member's
    number equalled the one of its own session with the real hub; with many idle sessions
    open to the hub, a handful of tries did. The nonces close that: see Pairing.
- API (each takes an optional `log?: (msg) => void` last):
  - `tlsClient(socket, identity, verifyPeer, timeoutMs): Promise<{ tls, peerId, peerSpki }>`
  - `tlsServer(socket, identity, verifyPeer, timeoutMs): Promise<{ tls, peerId, peerSpki }>`
    `timeoutMs` covers the handshake and `verifyPeer`; on timeout both sockets are destroyed.
  - `listenTls(host, port, identity, onSocket, { timeoutMs = 10 s, maxPending = 32, maxPendingPerIp = 8, log }) → Promise<net.Server>`
    (resolves once listening): the hub's listener. Any Ed25519 client certificate completes
    the handshake; `onSocket({ tls, peerId, peerSpki })` decides there: paired device, or
    pairing. One IP may hold at most `maxPendingPerIp` handshakes, so a single PC stalling
    them (10 s each) can't take every slot.
  - `tlsSide(tls) → 'client' | 'server'`: which end a socket from tlsClient/tlsServer is
    (the mux uses it for stream IDs).

## Link multiplexing (link/mux.ts)

- Frames on the TLS stream: `u8 type | u32 streamId | u32 length | payload`, with
  big-endian integers and a maximum payload of 64 KiB. Types:
  - 0: control (UTF-8 JSON, streamId 0)
  - 1: open (JSON `{kind, ...}`)
  - 2: data
  - 3: close. Empty payload: "no more data from me" (a half-close; the stream is gone once
    both sides have sent it). A UTF-8 reason as payload: abort, and the receiver destroys
    its stream without an `'error'` event.
  - 4: open-result (JSON `{ok, error?}`)
  - 5: window (u32 credit, see below)
- Control messages are `{ t: string, ... }`:
  - `hello {id, name, role, version, rustdeskId}`, sent by both sides first
  - `ping {n, at}` / `pong {n, at}`: every 5 s, the first one at once. RTT is measured on
    pong. The link is dead after 15 s without any frame. hbbr also cuts a pipe that has
    been idle for 30 s.
  - `bye {reason}`
  - ping, pong and bye are handled inside the mux and never reach `onControl`, so the
    first message `onControl` sees is the peer's `hello` (or `pair-request`).
- Streams: the opener picks odd IDs (client) or even IDs (server), and the receiver accepts
  or refuses through the handler it registered for `kind`. Each stream is a `Duplex`.
- **Backpressure is per stream (changed from pause/resume on the TLS socket):** each side
  may have at most `WINDOW` = 1 MiB of a stream sent but not yet read at the other end;
  a `window` frame hands credit back once the reader has consumed a quarter window. The
  TLS socket is always read, and a full TLS socket holds writers back. Pausing the whole
  socket deadlocked two parallel echo streams in the test (each side's paused echo held
  the socket its peer needed to make progress) and also stopped pings and bye during a
  stall. 1 MiB is about 3 MB/s per stream at a 300 ms Wi-Fi RTT.
- Protocol errors close the link: an unknown type, a payload over 64 KiB, bad JSON, an
  open with the wrong parity or a live ID, a peer sending past its window.
- API: `createMux(tls, { side?, onControl?, onOpen?, pingMs?, deadMs?, openTimeoutMs?, log? })`
  → `{ send(ctl), open(kind, meta): Promise<Duplex>, rtt(): number|null, lastSeen(), streams(), closed(): string|null, close(reason), on('close', reason => …) }`.
  - `onOpen` is `{ [kind]: (meta) => (stream) => void }` (sync or async): return what to do
    with the stream once it is open, or throw to refuse with that message.
  - `side` defaults to `tlsSide(tls)`. `openTimeoutMs` (30 s) caps the wait for open-result.
  - Close reasons: the local reason; `peer: <reason>` after a bye; `timeout: nothing heard
    for 15 s`; `protocol error: …`; `the connection closed`. Closing the link destroys all
    its streams and rejects pending opens.

## RustDesk wire (rendezvous/*)

None of these modules imports config.ts, net.ts or log.ts: they take parameters and an
optional `log?: (msg: string) => void`.

- `codec.ts`: port `design/features/F-004-probes/round2/wire.mjs` to TS: `frame`,
  `Deframer` (optional `maxLength`; set `raw` to pass bytes through), `mangle(ip, port)` /
  `unmangle(bytes) → {ip, port}` (v4 and v6; a v4-mapped IPv6 mangles as IPv4, as
  try_into_v4 does; a bad length throws), plus `parseHostPort('host:port' | '[v6]:port')`.
  Bring its 37 checks along as `codec.test.ts`.
- `messages.ts`: load `rendezvous.proto` with protobufjs once, field names kept snake_case
  as in the schema. Export `encode(msg: Outgoing): Buffer`, where `Outgoing` is typed as a
  RendezvousMessage with exactly one union field set, e.g.
  `encode({ local_addr: { socket_addr, local_addr, relay_server, id, version } })`, and
  `decode(buf): Decoded`, a union of `{ kind, body }` typed per kind (`Bodies`).
  - Encoding follows proto3: default values stay off the wire, while a set oneof member is
    always written. encode throws on a field name the schema lacks (`licenceKey`), an
    unknown enum name, or two members of one oneof.
  - Decoded bodies have every field, absent ones at their proto3 default. Enums are names
    (`'OFFLINE'`), or the number when unknown. Bytes are Buffers. `union` names the set
    oneof member (`is_local`, `pk`).
  - Unknown union fields (for example ConfigUpdate, which hbbs sends to a low `serial`)
    decode to `{kind: 'unknown', body: {field}}`. Bytes that are not protobuf decode to
    `{kind: 'invalid', body: {error}}`. decode never throws.
- Transport rules (hbbs 1.1.16, `rendezvous_server.rs`):
  - UDP datagrams carry a bare RendezvousMessage, with no length prefix.
  - TCP uses BytesCodec frames.
  - Replies from the controlled side (LocalAddr, RelayResponse, PunchHoleSent) each go on
    a **new** TCP connection to hbbs, one message per connection, and hbbs closes it
    (`handle_tcp` returns false, 507-532).
  - hbbs drops any TCP connection 30 s after the last frame it got (1182).
  - hbbs answers a PunchHoleRequest connection **once**: the answer takes the stored sink
    (814-819). A RequestRelay sent later on the same socket is still forwarded to the peer
    (493-506), but no RelayResponse comes back on it. So the controller joins hbbr with its
    own uuid and does not wait.
  - `punch_hole_response.failure` defaults to `ID_NOT_EXIST` (0). A response is a refusal
    only when `socket_addr` is empty, as RustDesk's client reads it (client.rs:995).
  - On its way to the controller, hbbs swaps RelayResponse's `id` for the signed `pk`
    (510-514). It also rewrites `relay_server` to `local-ip` when the controller is inside
    `--mask` (516-523).
- `hbbs.ts`:
  - `startRegistration({ hbbs: 'ip:port', bindAddress, id, uuid, pk, onPush, relayAllow?, everyMs?, log? })`:
    one UDP socket bound to `bindAddress:0`. It sends `RegisterPeer{id, serial: 0}` at once
    and every 12 s. On `RegisterPeerResponse{request_pk: true}` it sends
    `RegisterPk{id, uuid, pk}`, where pk is the 32-byte spkiSha256. On `RegisterPkResponse`
    it logs the result.
    - `onPush(kind, body)` receives `punch_hole`, `fetch_local_addr` and `request_relay`,
      and only from hbbs's own address and port. If it returns a promise, the push counts
      as pending until the promise settles.
    - It returns `{ stop(), lastOk(): Date|null }`. lastOk is the last
      RegisterPeerResponse without request_pk, or the last RegisterPkResponse OK.
    - A socket error closes the socket; the next tick opens a new one.
  - `sendOneShot(hbbs, msg, { timeoutMs?, localAddress? })`: TCP connect, write one frame,
    end, and resolve when hbbs closes the connection.
  - `punchHoleRequest(hbbs, { id, licenceKey, version, timeoutMs?, localAddress?, log? }) → Promise<PunchAnswer>`:
    sends `PunchHoleRequest{id, nat_type: SYMMETRIC, licence_key, conn_type: DEFAULT_CONN, version}`
    and keeps the socket open for the answer (30 s cap). `PunchAnswer` is
    `{ kind: 'punch_hole_response'|'relay_response', body, socket, send(msg): boolean, close() }`.
    `send` writes a RequestRelay on the punch socket and returns false once that socket has
    closed; then use `sendOneShot`.
  - `punchFailure(body) → string|null`: `'OFFLINE'`, `'ID_NOT_EXIST'`, `'LICENSE_MISMATCH'`,
    `'LICENSE_OVERUSE'` or `other_failure`; null when the response carries an address.
  - `relayAllowed(relayServer, allow) → boolean`: an exact host:port match. Use it on
    `relay_response.relay_server` too.
  - `connectTcp(addr, timeoutMs, localAddress?)`: the TCP dial that relay.ts shares.
- `relay.ts`: `joinRelay(hbbr: 'ip:port', { uuid, licenceKey, id?, role?, timeoutMs?, localAddress?, log? }) → Promise<net.Socket>`.
  It connects and writes the framed `RequestRelay{uuid, licence_key, id, conn_type}`. After
  that the socket is a raw pipe. The **controlled** side then writes the 4-byte marker
  `SAD1`, and the **controller** waits for exactly those 4 bytes before starting TLS: the
  marker proves hbbr paired the two streams. Give up after 30 s.
  - `role: 'controlled'` writes `SAD1` and resolves once it is flushed.
  - `role: 'controller'` resolves once `SAD1` has arrived. The socket comes back **paused**,
    with any later bytes put back: TLS takes it as it is, while a plain reader must call
    `resume()`.
  - Without a role, do the marker step yourself with `writeMarker(socket)` /
    `awaitMarker(socket, timeoutMs)`.
  - hbbr closes the stream without a word on a wrong licence_key, and parks a lone stream
    for 30 s (relay_server.rs:425-462). The controller sees either one as a close before
    the marker.
- Allowlist: every `relay_server` received from hbbs must be one of ours: the hub's
  `lan:hbbr` or `publicHost:hbbr`. Anything else is dropped and logged. Rate-limit pushes
  to at most 5 pending and 20 a minute.
  - startRegistration does both when `relayAllow` is given; all three push kinds are
    checked.
  - Drop notes in the log are throttled to one per 10 s.
  - **Per requester (review, 2026-10-29).** hbbs forwards a RequestRelay without any key
    check (493-506), our ID is handed out by discovery and our hbbr address is predictable,
    and each forged `request_relay` holds its slot about 30 s (hbbr parks the hub's lone
    stream). Five such frames used to keep every slot full and starve the members. So the
    budget is also kept per requester, by the IP hbbs writes into the push's `socket_addr`
    (the sender's own TCP peer, 500, which can't be forged): at most 2 pending from one IP,
    and untrusted requesters share 4 of the 5 slots. `startRegistration({ trusted?(ip) })`
    marks the rest: the hub passes "a paired member's last link came from this IP"
    (`HubLinks.knownIp`), and those may take the fifth slot and are not held back by the
    per-minute cap. Not done (an open issue): authenticating the uuid itself (a per-member
    relay secret from pairing, `uuid = <memberId>.<nonce>.<hmac>`), which would let the hub
    drop forged pushes before it joins hbbr.

## The flows (connect.ts)

The member is the controller; the hub is the controlled side. Every attempt ends the same
way: TLS with the hub's SPKI pinned, our `hello`, then the hub's `hello` within the step's
cap. The hub checks our certificate only after the handshake, so a close before its hello
is a **refusal**: it is the hub's own answer, no other path is tried, and the evidence says
"The hub refused this PC: <reason>". A hub answering with another key is not taken on any
path ("answered as device X, not the paired hub Y").

1. **Direct probe (same network first).** For each hub LAN endpoint (from pairing) that is
   in a local subnet, try TCP with a 3 s timeout, then `tlsClient` with the hub's pinned
   SPKI, then exchange `hello`. Total cap 5 s; the first success wins.
   - Result: path `lan-direct`, location `same-network`.
   - Runs when the route is `auto` or `rustdesk`; skipped with the test-only
     `SAD_TEST_SKIP_DIRECT=1`.
   - Also tried, all at once with the stored one: `ConnectOptions.lanPeers`, the addresses
     LAN discovery heard the pinned hub's ID answer from ("Direct: the hub answered on this
     network from …; trying it too"). Discovery is not authenticated, but the pin is: an
     impostor there fails TLS like any wrong key. This is how a member finds a hub whose LAN
     address changed (no fixed lease in phase 1), since everything it stored names the old
     address.
1b. **Tailscale.** Runs when the route is `auto` or `tailscale`. Needs the hub's
   `tailnet` endpoint (from pairing or its hello) and this PC's own Tailscale address
   (`tailnetAddress()`: an address in 100.64.0.0/10 on Tailscale's adapter); otherwise it is
   skipped with a line saying which end lacks it. TCP with a 5 s timeout, then pinned TLS and
   hellos, 10 s in all.
   - **When the hub moved to another tailnet (F-110, 5 Nov 2026)** its stored address is dead, and it
     cannot be refreshed because the refresh comes in the hello of a link that cannot come up.
     So, in `probeTailnet`: (1) all at once, the stored address and the hub's name (`tailnetName`
     in the bundle: its full name on the tailnet, then that name's first label, which a new
     tailnet keeps; an older record has neither, so the hub's own name as a label, "Server" →
     "server"); (2) if none answers, `tailscale status --json` (read-only, injected runner,
     `tailnet-peers.ts`) and the hub's port on every other online PC of THIS PC's tailnet, PCs
     named like the hub first, at most 12, 3 s TCP each. Who is the hub is decided by the pin
     (its ID and key hash), never by a name or address: any other PC fails TLS before this PC
     says anything. The hub's hello then refreshes `tailnet` and `tailnetName` in the record.
   - When nothing answers, the row's last evidence line says why in plain words: "This PC is on
     the tailnet X, but the Server was last on Y. Sign this PC in to …" when the names differ,
     else "None of the N other PCs on this PC's tailnet answered as the Server …". A hub that
     answers but has removed this PC gets "… does not know this PC … Pair it again …". This is the
     line the Hub page shows under the name, so it no longer sits at "Connecting…" or a bare
     "Every path failed".
   - The old way, the stored address only, is `"tailnetSearch": false` in config.json (missing =
     on). Nothing is stored in the build: a publish carries no address.
   - **Which tailnet each end is on** (shared/agent-api.ts › `TailnetCompare`, on a member's row for its hub as
     `tailnet`): this PC's tailnet name suffix (`tailscale status --json`, read in the background at most once
     a minute, `tailnet-peers.ts` `suffix()`) against the suffix of the name the hub last told. `different` only
     when both are known and differ, with one plain sentence (`message`) to show; `fresh` is whether the hub
     said it on the link that is up now. Unknown or equal: no message.
   - **When the hub does not know this PC any more (F-112)**: the hub answered and said "not paired". The state's
     `hubRefused` {hubId, hubName, address (ip:port it answered from, never a relay's), reason, since} tells the page to
     offer Join a hub with that address filled in; the saved record stays (the default) until the user forgets it:
     `POST /hub/forget` {hubId} on a member clears the saved hub only (this PC's identity, settings and saved passwords
     stay; the old devices.json is kept as devices.json.before-forget), after which `self.paired` is false and Join
     a hub is offered. A different hubId is 409; no hub saved is a no-op ({forgot: null}).
   - **An address typed by hand (F-113)**: `POST /hub/address` {hubId, address} on a member saves `manualAddress` in the
     hub record ('host:port'; an IPv4 address or a name; the port may be left out; "" clears it) and connects at once.
     It is step 0: tried first on every route but Relay only, then the steps above still run. The pin is checked as on
     every path, so another PC at that address is refused ("wrong-pc"), never taken for the hub. The state's `hubAddress`
     {address, result: checking|accepted|refused|wrong-pc|no-answer, detail, at} says how the last try went. The hub's
     hello never changes it; joining a hub again clears it.
   - Result: path `tailscale`, location `internet` (Tailscale says nothing about where the
     hub is).
   - On `tailscale` a failure here ends the attempt ("No link over Tailscale"); on `auto`
     it goes on to step 2.
   - It comes before hbbs because, away from the hub's network, hbbs at the public address
     may not answer at all until the hub's firewall forwards it.
2. **Through hbbs.** Try the hbbs endpoints in order: the hub's `lan:hbbs` if it is in a
   local subnet, then `publicHost:hbbs`. Send `punchHoleRequest({id: hubId, licenceKey, version})`
   and wait up to 10 s (the hub answers through hbbs).
   - `punch_hole_response` with `is_local` and `socket_addr`: unmangle it and try TLS there
     (5 s cap) → path `hub-lan`, location `same-network`. If the route is `relay`, or this
     fails, go to step 3. On `relay` the request is still sent and the LAN answer set aside
     ("Relay only: not using hbbs's LAN answer").
   - `relay_response {uuid, relay_server}`: check it against the allowlist, then
     `joinRelay`, wait for `SAD1`, then `tlsClient`. The path is `relay-lan` if the
     relay_server host is in a local subnet, otherwise `relay-internet`.
   - `punch_hole_response.failure` (`OFFLINE`, `ID_NOT_EXIST`, `LICENSE_MISMATCH`) →
     location `offline` (the first two) or `unreachable`, with the evidence line.
   - On one LAN hbbs 1.1.16 always sends FetchLocalAddr (both ends inside `--mask`:
     `same_intranet`, 728-760), so in phase 1 the relay is reached through step 3. The
     PunchHole → `relay_response` path is for a member outside the mask (phase 2); the unit
     tests prove it against a stand-in hbbs.
   - hbbs reached but silent (no answer in 10 s, the hub's push lost): step 3 still runs,
     as a one-shot.
3. **Ask for a relay.** Pick a random uuid and send
   `RequestRelay{id: hubId, uuid, relay_server: <hub lan or public hbbr>, licence_key}` to
   hbbs: on the punch socket if it is still open, else as a one-shot. Then `joinRelay`,
   `SAD1` (30 s cap), `tlsClient` (10 s, hello included) → `relay-lan` / `relay-internet`.

Hub, on hbbs pushes (`answerPush`; startRegistration has applied the allowlist and the rate
limit):
- `fetch_local_addr {socket_addr, relay_server}` → one-shot
  `LocalAddr{socket_addr (echoed byte for byte), local_addr: mangle(hubLan, peerPort), relay_server, id: hubId, version}`.
  `local_addr` is the hub's own TLS listener (RustDesk instead listens on the reused local
  port of its hbbs connection; we have a listener already).
- `punch_hole {socket_addr, relay_server}` → check the allowlist, generate a uuid, one-shot
  `RelayResponse{socket_addr (echoed), uuid, relay_server, id: hubId, version}`, then
  `joinRelay(relay_server, {uuid, licenceKey})`, write `SAD1`, then
  `tlsServer(… verifyPeer: in allowlist)`.
- `request_relay {uuid, relay_server}` → check the allowlist, then `joinRelay`, `SAD1`,
  `tlsServer`.
- The hub always joins **its own hbbr at its LAN address** (`lan:hbbr`), whichever of its two
  addresses the push names: both are the same hbbr, and this avoids a hairpin through the
  router. It joins from its LAN address and gives the member's TLS 40 s (hbbr's 30 s park
  plus 10 s), since the member may arrive last.
- Relayed members are pinned in the TLS step (`verifyPeer` = the allowlist), so a removed
  member sees the socket close before the hub's hello.

**hello**, sent first by both sides: `{t:'hello', id, name, role, version, rustdeskId, screen}`.
- The member adds `path` (how it came) and `evidence` (its last 8 lines). The hub shows them
  as "<name> says: …" and takes `path` from it (the member is authenticated); location is the
  hub's own judgement: the member's address (the TCP peer, or for a relay the address hbbs
  saw, from the push's socket_addr) inside one of its subnets → `same-network`, else
  `internet`.
- The hub adds `hub`: its current details, as in pair-result. The member refreshes its stored
  copy (name, LAN and public endpoints, licenceKey) but never the pin, so a new LAN address or
  hbbs key reaches members on their next link.
- `screen`: whether this side's RustDesk direct-access port answers (see RustDesk).
- Later control messages: `{t:'status', screen}` (either way, on change), `{t:'check'}` (hub to
  member: run the decision again, the hub's "Check again"), `{t:'hub', hub}` (hub to members,
  when its details change).

Location and path are recorded per device, with an `evidence` line for every step taken.
For example: "Direct: TLS to 192.168.1.118:21220 in 840 ms, pinned key matched", "hbbs
said: same LAN (FetchLocalAddr)", "Relay: hbbr 192.168.1.118:21217 paired in 120 ms".

**links.ts.** The member keeps exactly one link to the hub:
- reconnect backoff of 1, 2, 5, 10 and 30 s; after a refusal it waits the longest step at
  once;
- while the path is a relay or Tailscale and the route is `auto` or `rustdesk`, it retries
  step 1 every 30 s and swaps to `lan-direct` when
  that succeeds: open the new link first, then close the old one. The old relay closes once
  no stream runs on it, so a RustDesk session is never cut for a better path;
- "Check again" re-runs the whole decision now, closing the current link first; one asked
  for during an attempt runs when that attempt ends. Changing How to connect is a Check again;
- the evidence starts with why the decision ran: "Connecting", "Checking again",
  "Reconnecting: the last link closed (<reason>)", "Moved off the relay (…)" or "Moved off
  Tailscale (…)";
- when every path failed (not a refusal), it asks the LAN where its hub is
  (`seekHub(true)`: main.ts runs discovery while the member has lost its hub) and the next
  attempt probes those addresses too (`lanPeers`, see step 1); once linked it stops
  (`seekHub(false)`) and the hub's hello brings the stored `lan.*` up to date.

Bookkeeping never breaks a link (review, 2026-10-29): devices.json writes from link
callbacks (`lastSeen`, a member's name and RustDesk ID) are caught and logged, and each
side registers its link's close handler before any of them. A write that threw there (an
antivirus or indexer handle on Windows, a full disk) used to leave the member without a
reconnect until a restart, or the hub with a dead link as the member's current row. And
devices.json itself (written to a temp name, then renamed) tries a rename that Windows
calls busy (EPERM, EBUSY, EACCES) again for up to ~0.4 s, as graceful-fs does, and never
leaves the temp file behind when it gives up.

The hub tracks every member's incoming links and their `hello` (the newest link is current;
a member leaving a relay has two for a moment). A new TLS peer:
- on the allowlist: 10 s to send its `hello`; only then may it open streams;
- unknown, with a code open: its first message may be `pair-request` (direct connections only).
  Unknown peers may wait for that first message only 4 at a time in all and 1 per IP
  (`MAX_STRANGERS`, `MAX_STRANGERS_PER_IP`); one more is closed at once with "too many PCs are
  pairing at once; try again in a few seconds". Its later messages (the reveal, the confirm)
  go to pairing.ts;
- unknown otherwise: `bye {reason: 'this PC is not paired with the hub'}` at once.

## Pairing (pairing.ts)

- **Hub: "Add a PC".**
  - Code: 8 Crockford base32 characters (no I, L, O or U), shown `XXXX-XXXX`.
  - Valid 10 minutes, 5 attempts, one use.
  - One active code at a time; starting again replaces the old one.
- **Member: "Join".**
  - The hub address comes from discovery or is typed, e.g. `192.168.1.118:21220`. Picked
    from discovery, the hub's ID goes along (`JoinRequest.hubId`), and the member's TLS
    refuses any other key at that address before the code is sent ("The PC at … answered as
    X, not the hub you picked (Y). Nothing was sent to it.").
  - Otherwise the member opens TLS with `verifyPeer` accepting any hub, because it isn't
    pinned yet.
- **The exchange (changed after review, 2026-10-29).** The check number is
  `sas(tls, nm, nh)` (see Pinned mutual TLS): the TLS session's exporter value mixed with a
  32-byte nonce from each end, and the member commits to its nonce before it sees the hub's:
  1. member → hub `{t:'pair-request', code, name, rustdeskId, version, commit}`, the first
     control message, where `commit` is `sha256(nm)` in hex and `nm` 32 random bytes;
  2. hub → member `{t:'pair-nonce', nonce: nh}` once the code is right. The hub shows
     nothing yet;
  3. member → hub `{t:'pair-reveal', nonce: nm}`. The hub checks `sha256(nm)` against the
     commitment (a mismatch, or no reveal within 10 s, ends it with `bad-reveal`);
  4. hub → member `{t:'pair-wait', sas}`; now both screens show the number. The member shows
     the one it computed itself, and stops at once if the hub's differs.
  A machine in the middle runs two TLS sessions, so it must pick its nonce for one side
  before it learns the other side's, and the two numbers match only by chance: 1 in 10^6 per
  try. It gets at most 5 tries per code (below), since every request costs one.
- **Both people confirm.** The hub's person approves; the member's person answers "Does the
  hub show 123 456?" (`POST /join/confirm {match}`): yes sends `{t:'pair-confirm'}`, no ends
  the join and closes the link. Either may come first.
  - The member **never pins** a `pair-result ok` that comes before its own person said yes.
    A "hub" that approves by itself (anyone answering at that address, for example through a
    spoofed discovery answer) is refused: "The hub answered before you had checked the
    number, so nothing was paired."
  - The hub stores the device only once it has **both** Approve and the member's confirm.
- **When it has both (hub):**
  1. Store the device in `devices.json`.
  2. Reply `{t:'pair-result', ok:true, hub:{ id, name, spkiSha256 (hex), lan: { peer:'ip:port', hbbs:'ip:port', hbbr:'ip:port' }, public: { hbbs:'host:port', hbbr:'host:port' }, licenceKey }}`.
  3. Consume the code.
- The member pins the hub's spkiSha256, stores the bundle in its `devices.json`, closes,
  then connects normally.
- **Reject**, or 5 minutes without an answer, gives `ok:false`.
- A paired device presenting its certificate later sends `hello` instead. The hub checks
  its spkiSha256 against the allowlist and refuses an unknown or removed device at once.
- **"Remove"** on the hub deletes the device from the allowlist and closes its link.
- As built:
  - **Every request costs a try, right code or wrong** (each right one is also a chance at a
    matching number): `attemptsLeft--` on each `pair-request`, and at 0 the code is spent for
    new requests (a right request that spent it still goes on). A wrong code gets
    `pair-result {ok:false, reason:'bad-code', attemptsLeft}` and the connection closes. Codes
    are compared in constant time and read the Crockford way (`I`/`L` are 1, `O` is 0, dashes
    and spaces dropped).
  - **One PC per code at a time.** The same PC asking again replaces its request
    (`replaced`); a second PC with the right code while one is waiting cancels the code and
    turns both away (`conflict`, and a warning in the log): someone else knows the code.
  - A new code turns away the old code's waiting requests (`cancelled`); pairing one turns
    away the others (`code-used`). Other reasons: `no-code`, `rejected`, `timeout`,
    `bad-request` (no commitment), `bad-reveal`. The Join dialog gets a sentence for each.
  - A request appears in `state().requests` only after its reveal, with `approved` (on the
    hub) and `confirmed` (by the member's person). `approve(requestId)` answers
    `{deviceId, member}`: `member` is null while the member's confirm is still to come, and
    the PC is stored the moment it arrives. If storing then fails (no LAN address, a write
    error), the request goes back to waiting for Approve, which reports the error.
  - With no code open the hub turns unknown PCs away before they speak; the member's join
    then says "The hub has no code open. Choose Add a PC on the hub first."
  - Before pinning, the member checks the approved details against the certificate it saw
    (`id` and `spkiSha256`, and the picked hub's ID); it waits up to 6 minutes for an answer.

## hbbs/hbbr (hub/rustdesk-server.ts)

- **Fetch (also `npm run setup:hub`):**
  - URL: `https://github.com/rustdesk/rustdesk-server/releases/download/1.1.16/rustdesk-server-windows-x86_64-unsigned.zip`
  - size 11,909,626 bytes; sha256 `b865a3a62fc8755b45480c508f1c4871c3338590408dda8c58c7e9c373b7adb0`
  - Refuse on any mismatch.
  - Extract with `C:\Windows\System32\tar.exe -xf` (`%SystemRoot%\System32`) into a temp
    folder, then copy `hbbs.exe` and `hbbr.exe` (find them inside, sizes checked again) to
    the canonical `%LOCALAPPDATA%\shubham-agentic\rustdesk-server\`. Skip when both
    already exist with the right sizes (7,094,784 and 2,905,088 bytes).
  - `--zip <file>` uses a local copy of the zip instead of downloading; same checks.
- **Start:**
  - Write `hbbs.ini` with `local-ip=<lan>:<hbbr>`.
  - Spawn `hbbs.exe -p <hbbs> -r <publicHost>:<hbbr> --mask <lanCidr> -k _ -c hbbs.ini`,
    with `cwd` set to the working folder and `windowsHide`.
  - Give it a **minimal** env: `SystemRoot`, `TEMP`, `TMP`, `PATH`, `DB_URL=db_v2.sqlite3`
    and `RUST_LOG=info`, and nothing inherited, so no PORT/KEY leaks in.
    `PATH` is `%SystemRoot%\System32;%SystemRoot%`. On Windows libuv still copies its
    required basics into every child (HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE,
    USERDOMAIN, USERNAME, USERPROFILE, WINDIR; measured); none of them affects hbbs or hbbr.
  - Before each spawn, check the TCP ports are free (a `[::]` bind): Windows lets hbbs's
    SO_REUSEADDR fallback share a port another program holds, so a clash would go unseen.
  - Wait up to 10 s for `id_ed25519` and `id_ed25519.pub` plus a `Key:` line on stdout.
    Otherwise stop and report an error: without them hbbs silently runs keyless. The key
    printed must equal `id_ed25519.pub`. hbbs is `running` once it also logged
    `ALWAYS_USE_RELAY=`, which 1.1.16 prints after binding all its ports.
  - Then spawn `hbbr.exe -p <hbbr> -k _` from the same folder. It is `running` once it printed
    the same `Key:` and `Start` and is still alive 1 s later (a failed bind exits at once);
    a different key is refused. If hbbs comes back with a new key, hbbr is restarted.
  - No LAN address yet: hbbs stays `stopped`, with that as `lastError`, and starts when the
    LAN poll (every 10 s) finds one. Missing exes: `missing`, looked at again every 30 s.
- **Run:**
  - Children are **not** detached, so they die with the agent (tested on Windows).
  - Pipe stdout/stderr to `logs/hbbs-YYYYMMDD.log` and `logs/hbbr-YYYYMMDD.log`.
  - Restart with backoff of 1, 2, 5, 10 and 30 s (reset after 60 s running). `restarts`
    counts restarts after a crash; `lastError` keeps the reason until it runs again.
  - Rewrite the ini and restart hbbs when the LAN address changes (polled every 10 s; a
    LAN that disappears keeps what runs).
- The `licenceKey` is the trimmed content of `id_ed25519.pub`.
- Tests may use another `cwd` (their own keys and db) but **the same exe path**. Every new
  exe path triggers a new Windows Firewall prompt on the desktop.
- API: `ensureBinaries(opts?) → { dir, hbbs, hbbr, fetched }`,
  `startServers(cfg, opts?) → { status(): ServerStatus[], licenceKey(): string|null, ready(timeoutMs?): Promise<void>, checkLan(), stop(): Promise<void> }`.
  `cfg` is the agent's `Config` (ports, publicHost, lanAddress, paths); `opts` takes
  `workDir`, `exeDir`, `onChange`, `log` and test-only overrides.
- Measured on this PC (1.1.16, idle): hbbs about 22 MB, hbbr about 7 MB of RAM; the key,
  mask, local-ip and relay lines appear in the hbbs log within a second.
- The real-exe test is `agent/hub/rustdesk-server.real.test.ts`, opt-in because it takes
  21316/21317: `SAD_TEST_REAL_SERVERS=1 node --test agent/hub/rustdesk-server.real.test.ts`.

## LAN discovery (discovery.ts)

- UDP **21222**, bound to 0.0.0.0. node.exe already has inbound allow rules on this PC.
- A member that is not paired yet sends `{"t":"sad-who"}` to the directed broadcast of each
  local subnet every 5 s while the Devices page is open. Not paired means the UI asks for
  `discovered`.
- The hub answers by unicast `{"t":"sad-hub", id, name, peer:'ip:port'}`.
- This is a hint for the Join dialog only. Trust comes from pairing and the SAS.
- As built: the hub answers only queries from inside its own subnets. The member asks while a
  WebSocket client is connected and it has no hub, lists a hub at the address it answered
  from with the port from `peer`, and drops it after 15 s of silence. A directed broadcast
  reaches a listener on the same PC too (measured), so the e2e test covers discovery.
- Answers are not authenticated, so a second address answering for one ID is never taken
  over the first (the last answer used to win): the row keeps the first address and is
  marked `conflict` (`DiscoveredHub.conflict`), and the UI offers no one-click Join for it.
  `addresses(id)` lists every address answering for an ID.
- A **paired** member asks too, while it has lost its hub (every path failed; see
  links.ts), and probes the addresses its hub's ID answers from. The list stays hidden from
  `AgentState.discovered` then.

## RustDesk (rustdesk.ts)

- Find `C:\Program Files\RustDesk\RustDesk.exe`, or the same under `ProgramFiles(x86)`.
- `getRustdeskId()`: run `--get-id` (no admin needed) once at start; null when missing.
- **Mode 1, on the member:**
  1. Listen on `127.0.0.1:0`.
  2. On a connection, open mux stream `{kind:'rustdesk'}`.
  3. The hub dials `127.0.0.1:<SAD_RUSTDESK_DIRECT_PORT || 21118>`, falling back to its
     LAN address on the same port, and pipes both ways.
  4. Then run `RustDesk.exe --connect 127.0.0.1:<port>`, detached, `windowsHide: false`.
  Never pass `--password`.
- Close the listener 10 minutes after the last stream closes.
- As built:
  - Both ends serve `rustdesk` streams from their own direct-access port, and either end can
    open one (the hub can open a member's screen when the member's port answers). The handler
    dials before accepting, so a dead port refuses the stream with the reason.
  - Each end checks its own direct-access port at start and every 60 s (a TCP connect, closed
    at once) and says so in `hello.screen` and `status`. `canOpenScreen` = a link is up and
    the far end's `screen` is true.
  - `POST /devices/:id/screen` answers `{ok, port, launched}`. The test-only
    `SAD_TEST_NO_RUSTDESK=1` never runs RustDesk.exe (no `--get-id`, no `--connect`); Open
    screen still opens the tunnel and answers its port.
  - Tunnel sockets are `allowHalfOpen`, so half-closes pass through; a connection made while
    there is no link is closed at once.
  - Two `open()` calls for one device at once (a double-click on Open screen) share one
    listener: the one still binding is kept as a promise, so the second never binds its own
    (which nothing would have closed). A listener that finishes binding after `closeAll()`
    is closed at once.
  - Christopher's remote gate shares node's loopback listeners with the tailnet, the tunnel's
    included. RustDesk's own password still guards the far screen.

## Local API (api.ts)

- `http.createServer` on **127.0.0.1:<api>** only, with the paths and types in
  `shared/agent-api.ts`:
  - `GET  /agent-api/health` → `{ok:true}` (no token)
  - `GET  /agent-api/state` → `AgentState`
  - `WS   /agent-api/ws` → sends `{type:'state', state}` on connect and on every change,
    debounced to 100 ms. Use the minimal WebSocket server below; no `ws` dependency.
  - `POST /agent-api/pairing/start` → `PairingCode` (hub)
  - `POST /agent-api/pairing/cancel` (hub)
  - `POST /agent-api/pairing/requests/:requestId/approve` and `/reject` (hub)
  - `POST /agent-api/join` with `JoinRequest` → `JoinState` (member)
  - `POST /agent-api/join/confirm` with `JoinConfirm {match}` → `JoinState` (member, while
    `join.status` is `confirm`: its person compared the check numbers)
  - `POST /agent-api/join/cancel` (member)
  - `POST /agent-api/devices/:id/check`, `/screen` and `/remove` (remove: hub)
  - `WS   /agent-api/devices/:id/remote` → that device's RustDesk as a byte pipe, for the
    in-app viewer (F-005, below); `?via=app` → that device's own screen instead (F-006, below)
  - `WS   /agent-api/keys` → while open, this PC's keys for the Control page that opened it
    (F-013, below): text frames, `{t: 'grabbing'}` then `{t: 'key', code, down, repeat, alt,
    ctrl, shift, meta}` (`KeysMessage`); closing it gives them back; 404 where it can't
  - `POST /agent-api/settings` with `SettingsPatch` (`route`, `stayReachable`, or both) →
    `AgentSettings`
  - `POST /agent-api/screen/password` with `{password}` (null removes it) and
    `POST /agent-api/screen/setup` (F-006, below)
  - `POST /agent-api/claude/sign-in` with `{login, password}`, `POST /agent-api/claude/check`
    with `{replace?}` and `POST /agent-api/claude/sign-out`, each → `ClaudeInfo` (F-007, below)
  - `POST /agent-api/claude/switch/refresh` with `{readings?}` and `/switch/auto` with `{on}` →
    `ClaudeInfo`; `/switch/preview` with `{to}` → `SwitchPreview`; `/switch` with `{to, restart:
    [chat ids]}` → `{ok, message, restarted, failed}` (Claude subscription failover, below)
  - `POST /agent-api/devices/:id/password/login` with `{via, salt, challenge}` →
    `{digest | null}`, `/password/save` with `{via, salt, h1}` and `/password/forget` with
    `{via?}` (F-008, below)
- **Auth:** every request except health must carry `x-sad-token: <api-token>`. Vite's proxy
  adds the header (see below). On a mismatch, return 401 `{error}`. Christopher's remote
  gate on this PC auto-shares node loopback ports to the owner's tailnet, so the token is
  what really protects 21221.
- **Minimal WebSocket server (RFC 6455):**
  - handshake: `Sec-WebSocket-Accept` = base64(sha1(key + GUID))
  - send unmasked text frames, with 7/16/64-bit lengths
  - read masked client frames: ping → pong; close → close
  - no extensions
  - test it with Node's global `WebSocket` client
- **As built (agent side):**
  - Every answer is a JSON object; an action with nothing to say answers `{ok: true}`.
    `approve` answers `{ok, deviceId, paired}` (`paired` false while the member's person has
    yet to confirm the number; it is stored when they do), the hub's `check` `{ok, linked}`,
    `screen` `{ok, port, launched}`.
  - A request whose `Origin` is not this PC (localhost, `*.localhost`, 127.0.0.0/8 or `::1`;
    `agent/local-host.ts`) is refused with 403 before the token is looked at, on HTTP (all
    but health) and on the WebSocket handshake. No Origin is fine (not a browser, or a
    same-origin GET). Defence in depth behind the proxy's own check (below): the proxy keeps
    the browser's Origin, `changeOrigin` rewrites only Host. The remote gate is believed to
    rewrite Origin to `127.0.0.1:<port>` as it does for Christopher; if the phone's Devices
    page ever gets 403s through it, this is why.
  - Errors: 400 (bad JSON or body, malformed path), 401 (token), 404 (path or device), 405,
    409 (wrong role, no link, RustDesk missing, no LAN for pairing), 413 (over 64 KiB), 415
    (a POST that is not `application/json`), 500 (logged with its stack).
  - The WebSocket handshake needs the token too (401 before the upgrade). A client's close
    is answered with the same code; RSV bits, an unmasked frame or a long or fragmented
    control frame close with 1002, a frame over 64 KiB with 1009; a client that stops reading
    (4 MiB queued) is dropped. Text from clients is ignored.
  - F-057, the live link (`agent/ws-live.ts`; the page's half is `shared/live-socket.ts`): on every
    text WebSocket (the state, and each mount's: events, a chat's terminal, a chat's feed) a client
    message that starts `{"t":"ping"` is answered with `{"t":"pong","n":<the same n, digits only>}`
    by the API itself and never reaches the mount; the page uses it to tell a link that is alive
    from one that died without a FIN or RST (a phone that locked, a VPN that dropped). The agent
    also sends a ping frame every 20 s and drops a client that has sent nothing at all (no frame,
    no pong) for 65 s; browsers answer a ping frame by themselves, also while the page is frozen.
    The remote screen's pipe and the `/keys` socket have no such sweep.
  - While a client is connected the state is also pushed every 5 s (round trips, last seen),
    and an unpaired member looks for hubs on the LAN.
- **Vite side**, in `vite.config.ts`: proxy `/agent-api` to `http://127.0.0.1:21221` with
  `ws: true`. On `proxyReq` and `proxyReqWs`, set `x-sad-token` from the token file,
  re-read on each request so an agent restart is picked up. Also (built that way, tested
  against a stand-in agent):
  - The port is `SAD_API_PORT`, else `ports.api` from `<state>/agent/config.json`, else
    21221. It is read once, when the dev server starts.
  - **Only the app's own pages get the token** (`fromApp` in `agent/local-host.ts`). First
    the `Host` must be one Vite itself accepts with no `allowedHosts`: an IP literal,
    `localhost` or a name under `.localhost` (its isHostAllowed). Then a request whose
    `Sec-Fetch-Site` is not `same-origin` or `none`, or (with no fetch metadata) whose
    `Origin` host differs from `Host`, goes on without it, and any `x-sad-token` it carried
    is stripped. Without this, any website open in the browser could drive the agent through
    localhost:5173 (for example, approve a pairing request). The agent should still answer
    401 when the token is missing, and it may also require `Content-Type: application/json`
    on POSTs (the UI always sends it).
  - **The Host check (review, 2026-10-29).** Vite validates Host only in its HTTP
    middleware; its proxy's `upgrade` handler passes WebSockets on unchecked. A page from
    `attacker.example:5173` whose name was rebound to this PC is same-origin with itself, so
    it used to get the token on `/agent-api/ws` and the whole state with it (the live
    pairing code, device IDs, LAN addresses). Read-only, but no longer: its Host fails the
    check, and the agent refuses its Origin too.
  - `changeOrigin: true`: the agent sees `Host: 127.0.0.1:<api>`. A WebSocket keeps the
    browser's own `Origin` (for example `http://localhost:5173`).
  - When nothing listens on the port (a TCP check before each request), the proxy answers
    `502 {"error":"Nothing answers on 127.0.0.1:<port>"}` itself, and refuses a WebSocket
    handshake. This keeps Vite from logging a stack trace on each of the page's retries.
    The UI tells "agent not running" (502) from "token refused" (401) with one
    `GET /agent-api/state` after a failed WebSocket.

## The agent process (main.ts)

- `npm run agent [-- --role hub|member]`. `startAgent(config)` does the work; the entry code
  runs only when main.ts is the program (`import.meta.main`).
- Start: identity, api-token, devices.json, RustDesk's ID, then by role:
  - hub: hbbs/hbbr; a TLS listener on the **LAN address** and another on the **Tailscale
    address** when Tailscale is up (never 0.0.0.0, which Christopher's remote gate would
    share), each rebound when its address changes (checked every 10 s). Links from the
    Tailscale listener are path `tailscale`, whatever the member says. The hub's bundle
    carries `tailnet` ('ip:port' or null), and pairing codes list both addresses; registration with hbbs from the LAN address, started again whenever hbbs (re)starts
    so hbbs knows the hub at once rather than within 12 s; the discovery answer;
  - member: the link to its hub when paired, and discovery on demand: while the Devices page
    is open and it has no hub, or while it has lost its hub.

  Then the API. A failed start (a broken identity, a taken API port) is logged and exits 1.
- Stop: Ctrl+C (SIGINT), SIGTERM, Ctrl+Break, or `{t:'stop'}` from a parent Node process over
  an IPC channel (on Windows a signal sent by another process is always a hard kill). It
  closes the API, says bye on every link, and stops hbbs/hbbr and waits for them. A second
  Ctrl+C exits at once; the parent's IPC going away stops the agent too. With an IPC channel
  the agent sends `{t:'ready', apiPort}` once its API listens.
- An uncaught exception is logged and stops the agent (exit 1); an unhandled rejection is
  logged.
- Test-only env, each logged as a warning: `SAD_TEST_SKIP_DIRECT=1`, `SAD_TEST_NO_RUSTDESK=1`.
- `VERSION` is `0.1.0`: in hellos, and to hbbs, which signs the peer's key into its answers
  only when a version is given.

## UI: the Devices page (src/)

- Nav: add `{ to: '/devices', label: 'Devices', icon: MonitorSmartphoneIcon }` after Themes,
  and a route in `main.tsx`.
- **Data:** `src/agent-api/store.ts` uses `useSyncExternalStore` over one WebSocket to
  `/agent-api/ws`:
  - reconnect with backoff;
  - expose `{ status: 'connecting'|'up'|'down', state: AgentState|null }`;
  - POST helpers for each action, in the style of `src/features/store.ts`.
- **Page,** following DESIGN.md (`list-row`, `status-dot` shapes with labels, empty,
  loading and error states, one primary per view, Motion patterns):
  - **Header:** title "Devices", plus one line "This PC and the computers paired with it,
    and how each one is connected right now."
    - Hub: primary "Add a PC".
    - Unpaired member: primary "Join a hub".
  - **This PC** card: name, role ("Hub" / "Member"), device ID in mono, LAN address and
    RustDesk ID.
    - Hub: an hbbs/hbbr health line with each server's state and ports.
  - **Device rows:**
    - a status shape, and its label from `Location`:
      - Same network: done shape
      - Over the internet: done shape, with a "Relay" or "Tailscale" badge
      - Connecting…: running shape
      - Offline: idle shape
      - Can't reach: error shape
    - the name, plus a caption: path in words, address, RTT. For example "Direct on this
      Wi-Fi · 192.168.1.118:21220 · 180 ms" or "Through the hub's relay ·
      192.168.1.118:21217".
    - row actions: "Check again", "Control" (when `canOpenScreen`), and "Remove" (hub;
      a secondary button with an error label and a confirm dialog). Control replaced "Open
      screen" (F-005, 2026-10-30): it opens the PC's screen in the app; RustDesk's own window
      is only "Open in RustDesk" in the viewer's ⋯ menu.
  - Expanding a row (the disclosure pattern) shows its `evidence` lines.
  - **Add a PC** dialog (hub):
    - the code in large mono, `XXXX-XXXX`, with a countdown and the hub address;
    - below it, the pending requests, each with its name and the 6-digit check number in
      large tabular numerals, plus Approve (primary) and Reject. Approved before the PC's
      person confirmed: "Approved here. Waiting for … to confirm the number on its own
      screen", without Approve; it pairs (toast, dialog closes) when they do.
  - **Join a hub** dialog (member):
    - discovered hubs as choices (a hub in `conflict` is not offered: a warning says to type
      the address from the hub's screen), or the address typed;
    - the code field, then Join;
    - then "Does SERVER show this number? **123 456**", with "No, it's different"
      (secondary) and "Yes, it matches" (primary);
    - after yes, a wait for approval;
    - then success, or the error.
  - **How to connect** (at the bottom): on a member, a four-way segmented control
    (`settings.route`: Auto, Tailscale, RustDesk, Relay) with one line saying what the choice
    does. On the hub, "How PCs reach this hub": this network, Tailscale and the RustDesk
    servers, each with its state.
  - **Agent down:** the DESIGN.md error state "The device agent isn't running" with a
    code-block `npm run agent` and "Try again".
- **DESIGN.md:** add a "### Devices" section under Components, as F-002 did for Features.
- **README:** a short "Devices" section covering how to run the agent, the hub vs member
  setup, and the firewall script.

## F-005: Control, the other PC's screen in the app

Phase 1 (2026-10-30). The page itself speaks RustDesk's peer protocol to the RustDesk on the
other PC, as RustDesk's own client does on a direct connection; the agent only carries the
bytes. The protocol rules, each with its place in RustDesk 1.5.0's source, are in
`design/features/F-005-protocol.md`; this section is the build contract around them.

- **The pipe (api.ts, main.ts).** `WS /agent-api/devices/:id/remote` opens the link's
  `rustdesk` stream to that device (the same one Mode 1 uses, so the far agent dials its own
  127.0.0.1:21118, then its LAN address) and carries the raw TCP stream as binary frames both
  ways, with flow control both ways (a full side pauses the other). It answers before the
  upgrade: 404 for an unknown device, 409 with no link, 502 when the far end can't open its
  screen. A text frame closes it with 1003; a frame may be up to 8 MiB. When either side ends,
  the WebSocket closes with 1000 and a reason ("the other PC closed the screen", "the link
  closed", "the agent is stopping"). The token and Origin rules are the state socket's.
- **Who connects.** The page holds the RustDesk connection, so RustDesk on the other PC sees
  a direct-access login from 127.0.0.1 (or the hub's LAN address) with `my_id` = this PC's
  RustDesk ID (else its device ID) and `my_name` = this PC's name. The password is typed (unless
  this PC remembers it, F-008), hashed with that connection's salt and challenge in the page,
  and never stored or logged; the agent never sees it, only RustDesk's own bytes and, with
  Remember me, SHA256(password ‖ salt).
- **Layout.**

  ```
  shared/rustdesk/
    message.proto         RustDesk 1.5.0's peer schema (AGPL-3.0, vendored with its hashes)
    bytes-codec.ts        BytesCodec over Uint8Array (browser and Node)
    schema.ts             loadSchema(text): encode/decode hbb.Message; the types the viewer reads
    client.ts             the controlling side: login, video chunks, input, displays, cursor,
                          clipboard, keepalive; transport-agnostic (receive / send / end)
    keys.ts               KeyboardEvent.code → Windows scan code (rdev's tables), lock-key sets
    fzstd.js, fzstd.d.ts  zstd decoder (fzstd 0.1.1, MIT, vendored): clipboard and cursor shapes
  src/remote/
    session.ts            one connection: the WebSocket (or the mock), the client, screen,
                          cursor and clipboard, as a store the page reads; Remember me (F-008)
    live.ts               the connections the app holds across pages (F-009), the Devices
                          link's way back
    open.ts               makes a session for the page and hands it to live.ts (loads with it)
    video.ts              WebCodecs VideoDecoder → canvas; keyframe gating, codec changes
    input.ts              pointer, wheel, touch and keyboard → client
    schema.ts             message.proto through Vite (?raw), parsed on first use
    mock.ts               dev only: a pretend RustDesk in the page (VideoEncoder test pattern)
  src/pages/Remote.tsx    the page; RemoteRoute.tsx loads it on first use
  ```

  `shared/rustdesk/` uses neither DOM nor Node APIs (WebCrypto and TextEncoder are in both),
  so the same client runs in the page and under `node:test`. The schema text is passed in:
  the page imports it as `?raw`, Node reads the file.
- **Not in phase 1:** audio, file transfer and file clipboard, images on the clipboard, the
  remote's own cursor position, keyboard layouts on macOS and Linux peers (they get legacy
  mode), relative mouse, switching sides, privacy mode, recording, multiple displays at once.
- **Tests:** `shared/rustdesk/*.test.ts` (run by `npm run test:agent`): the codec against
  the agent's own; the client against a stand-in controlled side written from the protocol
  notes with its own tools (protobufjs reflection, the agent's Buffer codec, node:crypto,
  node:zlib's zstd): the Hash first and nothing sent before it, the password hash, a wrong
  password asked again on the same connection with the same session, No Password Access,
  ask-to-accept, 2FA, too many tries, refusals, Windows sessions, the TestDelay echo byte for
  byte, video chunks per display and codec, mouse in display pixels with clamping, map-mode
  keys and lock keys, Pause and Ctrl+Alt+Del, letting go of held keys and buttons, display
  switching, display changes, clipboard both ways with zstd, cursor shapes and their checks,
  the keyboard permission, refresh, legacy keys for other peers, closing either way, the
  open and silence timeouts, and the round trip. Read-only against the real RustDesk:
  `design/features/F-005-probes/direct-hello.mjs` (the raw opening) and `client-hello.ts`
  (the same bytes through this client, its writes dropped).

## F-006: the app's own screen (no RustDesk on either side)

Built 2026-10-30. The agent itself is the controlled side of RustDesk's peer protocol, so the
viewer (F-005) controls a PC with no RustDesk installed on either PC; only the agent's link
(same network, Tailscale, hbbs, hbbr) carries it. Each rule, with its place in RustDesk 1.5.0's
source, is in `design/features/F-006-host.md`. **The RustDesk way stays**: both are offered,
and the viewer picks per device.

- **Streams.** Either end serves a second stream kind, `screen`, beside `rustdesk`
  (`agent/screen/index.ts` › `handler`). The links put `from: {id, name}` into the open request's
  meta, from the paired record (hub side) or the pinned hub (member side), overwriting anything
  the far end sent; the host trusts only that. At most 3 at once.
- **Readiness.** `hello.appScreen` and `status.appScreen` (beside `screen`) say whether this
  end's own screen is ready: 64-bit Windows, koffi loaded, and ffmpeg.exe set up. The far end's
  row shows it as `DeviceInfo.canOpenAppScreen`. Re-checked with the RustDesk port every 60 s and
  whenever it changes (setup finished), announced only when either value changes.
- **API.** `WS /agent-api/devices/:id/remote?via=app` opens the far end's `screen` stream;
  `?via=rustdesk`, or no `via`, its `rustdesk` stream as before. `POST /agent-api/screen/password`
  with `{password}` (6 to 128 characters) sets this PC's control password, `{password: null}`
  removes it (400 with the reason for a bad one). `POST /agent-api/screen/setup` fetches FFmpeg
  in the background. `AgentState.appScreen` is `AppScreenInfo`: `ready`, `reason`, `ffmpeg`,
  `passwordSet`, `setup` (downloading with progress, or the failure) and `sessions` (who is
  controlling this PC now, from their login).
- **The control password** (`screen/password.ts`): `<state>/agent/screen-password.json` holds
  `{salt, h1, setAt}` with `h1 = SHA256(password ‖ salt)` (as RustDesk keeps its permanent
  password), written atomically with mode 0600; never the password itself, never logged.
- **FFmpeg** (`screen/ffmpeg.ts`): `npm run setup:screen` (or the page's Set up) downloads Gyan's
  `ffmpeg-9.0.2-essentials_build.zip` from GitHub, refuses it unless its size and sha256 match,
  extracts only `ffmpeg.exe` (size-checked) and its LICENSE with Windows' `tar.exe`, and puts
  them in `%LOCALAPPDATA%\shubham-agentic\ffmpeg` (also under `SAD_HOME`, so test agents share
  it). `SAD_FFMPEG=<exe>` uses another.
- **Windows calls** (`screen/win32.ts`): koffi 2.16.3 (prebuilt binaries in the package; npm's
  install-script policy doesn't apply). The process is made per-monitor DPI aware once, when the
  module loads.
- **Someone at the PC is told**: a Windows notification when a session logs in ("<PC> is
  controlling this PC"), and the Devices page lists the sessions.
- **Awake while controlled** (2026-10-30, after a session stopped when the hub went into Modern
  Standby on its 5-minute display timeout): while any session is logged in, the agent holds
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)`, as
  RustDesk's WakeLock does for an incoming session (windows.rs:3188-3224, connection.rs:
  6580-6625), and lets go when the last one ends. Before each capture starts it wakes the
  display (`SC_MONITORPOWER` on, as RustDesk's blank_screen(false), windows.cc:528-538, and a
  pointer nudged one pixel and straight back, which is mouse input and ends Modern Standby).
- **No picture is not the end** (2026-10-30, "if we were using RustDesk then it woke up, so the
  same should be this app"): as RustDesk does, a capture that stops never ends the connection.
  It is tried again after 1, 2, 3, 4, then every 5 s (counted over the last 60 s), the display
  woken before each try, and the viewer gets one notice (`LOCKED_NOTICE`): "No picture from
  <PC> right now ... It is being woken and tried again, and the picture comes back by itself".
  The first frame clears it. (Until then a capture that died 3 times in 30 s ended it.)
- **Reachable** (`screen/power.ts`, 2026-10-30): a PC in Modern Standby can't be reached:
  Windows pauses desktop programs (the agent) within seconds and may turn the network off. So,
  on mains power, the agent holds `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (no
  `ES_DISPLAY_REQUIRED`: the display still turns off as usual, and Control wakes it), which on
  AC keeps the PC from falling asleep by itself. A sleep someone chooses (power button, lid,
  Start › Sleep) ends every power request (PowerSetRequest, Remarks), so such a PC can't be
  reached until it is woken (design/features/F-006-host.md › Reachable while asleep). So the
  power button and the lid don't do that while plugged in: with `stayReachable` on, the active
  power plan's AC values are set (powrprof's `PowerWriteACValueIndex`, then
  `PowerSetActiveScheme`) to do nothing for both (`PBUTTONACTION` 0, `LIDACTION` 0); battery
  (DC) values are left alone, and Start › Sleep still sleeps. (The first version set the button
  to turn the display off, 4: on a Modern Standby PC that is still a sleep, "Reason: Power
  Button"; a plan still at 4 and 0 from it is set to 0 and 0 at the next start.) What the plan had is kept first, per plan GUID, in
  `<state>/agent/power-buttons.json` (`{"<plan>": {power, lid}}`), and put back when
  `stayReachable` is turned off (also at a start with it off), but only where a value is still one
  the app sets (power 0 or 4, lid 0); a start with it on doesn't set a plan again that it set before (someone
  changed it back since), turning it on does. Re-read every 30 s. Windows
  keeps one execution state per thread, so the two reasons meet in one hold: controlled →
  system and display; else reachable and not on battery → system only; else nothing. The power
  source is `GetSystemPowerStatus` (`ACLineStatus` 1 mains, 0 battery, 255 unknown, taken as
  mains), read again every 30 s. On battery the PC sleeps as Windows likes and can't be reached
  until someone wakes it. The setting is `stayReachable` (config.json, on unless turned off;
  `POST /agent-api/settings`), and `AppScreenInfo.power` is `{onMains, awake, buttons}` (the
  plugged-in `{power, lid}` actions in Windows' numbers, null when unknown). The first hold
  is told to nobody: the agent is still being made then (telling it crashed the agent once).
  Not in the test pattern's mode.
- **Screen off** (F-011, 2026-10-30): with the power button doing nothing, a desktop button turns
  the screen off instead (`agent/scripts/screen-off.ps1`, put on the desktop by
  `install-screen-off.ps1`, run windowless by `screen-off.vbs`). It goes the way of Windows'
  display timeout, which the hold keeps short of sleep: the AC and DC `VIDEOIDLE` are cut to 3 s
  and put back once nobody has touched the PC and nobody has controlled it through the app (its
  agent's `appScreen.sessions`) for 5 s, at most 10 minutes; the old values are kept first in
  `<state>/agent/display-timeout.json`. Not `SC_MONITORPOWER` 2: Windows logs that as the sleep
  button ("Reason SleepButton"), a sleep on Modern Standby. `-Check` only says what it sees.
- **Test env:** `SAD_SCREEN_PATTERN=1` shows FFmpeg's test pattern (1280×720), logs input
  instead of sending it, and has no clipboard or pointer, so tests neither show nor touch this
  PC; `SAD_SCREEN_DRY_INPUT=1` shows the real screen but only logs input, and only reads the
  power plan.
- **Layout.**

  ```
  agent/screen/
    index.ts      the service: readiness, the 'screen' handler, password, setup, sessions, notice
    host.ts       one connection: login, video, input, clipboard, pointer, lock screen (pure, ported)
    ffmpeg.ts     the pinned FFmpeg, the encoder choice and command lines, one capture
    frames.ts     FLV and IVF cut into frames; H.264 as Annex B with SPS/PPS on keyframes
    win32.ts      SendInput, DXGI displays, pointer, clipboard, input desktop, Yes/No box (koffi)
    cursor.ts     a Windows pointer shape as RGBA (RustDesk's get_cursor_data)
    password.ts   the control password and the failure counts
    power.ts      the awake hold: while controlled, and reachable on mains power
  agent/scripts/fetch-ffmpeg.ts   npm run setup:screen
  agent/scripts/screen-off.ps1    the Screen off button (F-011); install-screen-off.ps1, screen-off.vbs
  ```
- **Not yet (phase 2):** the lock screen, sign-in and UAC prompts, Ctrl+Alt+Del, administrator
  windows, and before anyone signs in after a restart: RustDesk does those from a system
  service. Until then the RustDesk way covers them. Also not: audio, files, several displays at
  once, adapting the bitrate to the link.

## F-007: Claude on this PC, on the CRM's subscription

Built 2026-10-30. The CRM keeps the office's Claude subscriptions (sam-crm-be: its super admin
adds each with the token `claude setup-token` printed, and puts each person, or the office
default, on one, Code › Usage). Christopher fetches the signed-in person's token and starts each
claude with it in `CLAUDE_CODE_OAUTH_TOKEN`. This app has no Claude sessions of its own, so the
agent puts the token in **this Windows account's** `CLAUDE_CODE_OAUTH_TOKEN` (HKCU\Environment)
instead, and every Claude Code started on this PC afterwards runs on it. Sources and decisions:
`design/features/F-007-claude-subscription.md`.

- **The CRM** (`claude/crm.ts`): `https://crmbe.bhole.co`, or `SAD_CRM_URL`. Sign-in is
  `POST /v1/auth/login {username | email, password, portal: "crm"}`; the CRM answers with its
  session as the `crm_token` cookie (a 7-day JWT), then `GET /v1/auth/me` says who it is. The
  token is `GET /v1/org/claude-subscriptions/mine/credential` with that cookie and
  `x-christopher-build: sad-<device id>` (the CRM records it as which copy fetched the token).
  200 `{subscription: {id, name}, token}`; 404, 403 and 409 mean none for this person now (none
  assigned, Claude off for them, their weekly share used up, theirs turned off), each with the
  CRM's sentence; 401 means the session is no longer good. No `x-christopher-release` header:
  the CRM checks only Christopher's own builds for being the latest.
- **When it's asked** (`claude/index.ts`): at sign-in, at start, every hour, and on Check now.
  A subscription: its token goes in (a new one replaces the old). None: the token the app put in
  comes out. A session that ends (7 days, or a 401): it is forgotten and the page asks to sign
  in again, but the token stays; the CRM's no takes it out, time alone does not. A network
  failure changes nothing. Sign out takes the token out and forgets the session. Someone else
  signing in on this PC: the last person's token comes out first.
- **Only its own.** `<state>/agent/claude-subscription.json` keeps the SHA-256 and last four
  characters of the token the app put in (never the token). A `CLAUDE_CODE_OAUTH_TOKEN` that
  doesn't match was set by something else: it is left alone (`ClaudeInfo.token` 'taken') until
  `POST /claude/check {replace: true}`.
- **Secrets.** The password goes to the CRM once and is kept and logged nowhere. The session
  cookie is kept in `<state>/agent/crm-session.json` (mode 0600). The token is in the registry
  and in memory only; neither it nor the cookie is logged or sent to the page, which sees the
  subscription's name and the token's last four characters.
- **Windows** (`claude/userenv.ts`): koffi's `RegGetValueW`, `RegSetKeyValueW` and
  `RegDeleteKeyValueW` on HKCU\Environment (`REG_SZ`), then `WM_SETTINGCHANGE "Environment"` to
  every window from a worker thread, so programs started afterwards get it (already open ones
  keep what they started with). Never `setx` or `reg.exe`, which would put the token on a
  command line. Off Windows `ClaudeInfo.token` is 'unsupported'.
- **API.** `POST /agent-api/claude/sign-in {login, password}` (the CRM's no is a 400 with its
  sentence, no answer a 502), `POST /agent-api/claude/check {replace?}`, `POST
  /agent-api/claude/sign-out`, each answering `ClaudeInfo`, which is also `AgentState.claude`:
  `token` (set, taken, empty, unsupported), `subscription` (id, name, hint, setAt), `url`, `crm`
  (name, username, url, signedInAt, expiresAt), `check` (at, ok/none/error, the message) and
  `busy`.
- **Not yet:** the hub signing a member in; reporting this PC's Claude usage to the CRM's Usage
  page, as Christopher's builds do (so the CRM's weekly caps don't count it). Moving the person
  to the office's other subscription is "Claude subscription failover and switch", below.

## F-008 and F-009: Remember me on Control, and sessions that outlive the page

Built 2026-10-30.

- **Remember me** (`saved-passwords.ts`), as RustDesk's own client does "Remember password"
  (src/client.rs: handle_login_from_ui 4818-4848, handle_peer_info 3681-3715, handle_hash
  4632-4760, handle_login_error 4500-4512): with the box ticked, once the login works the page
  sends H1 = SHA256(password ‖ salt) to this PC's agent. The next connection's Hash is answered
  before anyone is asked: the page sends `{via, salt, challenge}` and the agent answers
  SHA256(H1 ‖ challenge) for that connection only; H1 itself never leaves the agent. A
  different salt (the app's own screen draws a new one when its password changes) forgets it
  without a try; a "Wrong Password" makes the page forget it and ask. One per PC and way in, in
  `<state>/agent/saved-passwords.json` (mode 0600, never logged), shown as
  `DeviceInfo.savedPassword`; removing a PC on the hub forgets its saved passwords.
- **Sessions that outlive the page** (`src/remote/live.ts`, page side only): the app holds each
  connection, one per PC, so going to another page keeps a connected one running (its frames
  wait from the last keyframe; the next canvas starts with the last picture). One that isn't
  connected ends when its page goes. The Devices page shows a strip per open one, and the side
  nav's Devices link goes back to it.

## F-012: Screen off while controlled (privacy mode)

Built 2026-10-30, as RustDesk's privacy mode, over the same messages, so the viewer uses it on
both ways in (the app's own screen and an installed RustDesk).

- **Protocol.** The controlled side offers it in `PeerInfo.features.privacy_mode` and lists its
  ways in `platform_additions.supported_privacy_mode_impl` (`[[key, tip]]`, connection.rs:
  1975-1983, 2075). The viewer sends `Misc.toggle_privacy_mode {impl_key, on}` with the first
  key listed (io_loop.rs:1340-1364); the answer is `Misc.back_notification` with a
  `privacy_mode_state` (OnSucceeded, OffSucceeded, OnFailed with `details`, OffFailed,
  NotSupported, OnFailedDenied, OffByPeer, OffUnknown, OnByOther), read as RustDesk's
  handle_back_msg_privacy_mode reads it (io_loop.rs:2483-2560). OnByOther, or the login error
  "Someone turns on privacy mode, exit", ends the connection.
- **The app's own screen** (`agent/screen/host.ts`, `win32.ts` › `cover`): RustDesk's
  privacy_mode_impl_exclude_from_capture (privacy_mode.rs; win_topmost_window.rs), done
  in-process: one black `WS_POPUP` window over the whole virtual desktop, topmost,
  click-through and never focused (`WS_EX_TOPMOST | TRANSPARENT | TOOLWINDOW | LAYERED |
  NOACTIVATE`, alpha 255), with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, so the
  people at the PC see black and Desktop Duplication (the picture) sees under it. Windows 10
  2004 (build 19041) and later (win_exclude_from_capture.rs:7-11). Its messages are pumped
  every 50 ms on the agent's main thread while it shows; it is raised again every 2 s, and goes
  with the agent. One cover per PC (`PrivacyPort.owner`, privacy_mode.rs:60-87): on for one
  connection at a time, off when that connection ends (connection.rs:1216-1219), and no other
  login meanwhile (1400-1404). Not with `SAD_SCREEN_PATTERN` or `SAD_SCREEN_DRY_INPUT`.
  Its pointer is hidden with it (`privacy.ts`, `win32.ts` › `showPointer`: MagShowSystemCursor;
  RustDesk leaves it showing). Windows keeps it hidden after the process ends, so it is shown
  again when the screen comes back (moved a pixel and back, so it is drawn at once), at every
  start of the agent, and, should the agent end meanwhile, by a watcher: a hidden PowerShell
  (`-EncodedCommand`) that waits for the agent's process and then shows it. GetCursorInfo still
  says showing, so the viewer keeps getting its shape.
  Unlike RustDesk, the local mouse and keyboard aren't blocked (that needs its system service).
- **The viewer** (`shared/rustdesk/client.ts` › `setPrivacy`, `privacySupported`; the
  `privacy` event): `src/remote/session.ts` asks for it with the first picture of each
  connection unless it was turned on for that PC, as RustDesk keeps its toggle per peer;
  `src/remote/privacy.ts` remembers the choice per PC (localStorage), on unless turned off.
  The toolbar's **Screen** switch, before Disconnect, shows and changes it.
- **Checked:** with the cover up on this PC, a frame from FFmpeg's ddagrab showed the desktop,
  not black; the cover came up in 9 ms.

## F-013: Alt+Tab and the other shortcuts, taken by the controlling PC's agent

Built 2026-10-30. A browser never gets Alt+Tab, the Windows key, Ctrl+Esc, Alt+Esc, or the
browser's own Ctrl+W, Ctrl+T, Ctrl+Tab and the like; Full screen's Keyboard Lock gets most of
them, a normal window none. RustDesk's viewer takes every key with a low-level keyboard hook
while its session window has the focus (src/keyboard.rs:148-300, 612-701); here the
controlling PC's own agent does, for its Control page.

- **The hook** (`agent/screen/grab-worker.ts`): `WH_KEYBOARD_LL` on its own worker thread,
  blocked in GetMessageW, so it answers within Windows' timeout however busy the agent is (a
  hook that is late is dropped without a word). Thread messages steer it (`grab.ts`): GRAB hooks
  and takes the window in front as the one that asked, LET_GO unhooks, WM_QUIT ends it.
- **What it takes** (`grab-keys.ts`, apart from Windows): while that window stays in front,
  every key going down, and its going up, as KeyboardEvent.code from the scan code
  (WIN_SCANCODE turned round; Pause and Num Lock by their keys; AltGr's made-up Left Ctrl, 0x21D,
  as Control). Caps Lock and Num Lock stay with this PC (keyboard.rs:617-619), and so does
  injected input (this agent's own, when this PC is controlled too). A key down before the grab
  goes up here; another window in front ends the grab ("another window came in front").
- **The page** (`src/remote/input.ts`): opens `/agent-api/keys` while its screen has the focus
  and the browser window too, for a Windows PC (map mode); the keys go the same way as the
  browser's (Esc held 1.5 s still gives the keyboard back, which closes it). Not in the dev
  fixtures. The toolbar says "every key goes to NAME, Alt+Tab and Win too" meanwhile.
- **Not taken:** Ctrl+Alt+Del and Win+L (Windows keeps them; Ctrl+Alt+Del has its button).

## F-014: Control of this PC from its own page, opened on the phone

Built 2026-10-30. The phone has no agent, so it can't link to anything: it opens the hub's
page over Tailscale (Christopher's remote gate shares the dev server, `https://<tailnet
name>:5173`), and that page's Control goes through the hub's own agent to the hub's own screen.
No APK and nothing on the phone but a browser.

- **The agent** (`main.ts`): `/devices/<id>/remote` with this PC's own ID opens its own screen,
  with no link: the page's pipe gets one end of an in-process `stream.duplexPair()`, and the
  other end goes to the same handler a link's stream of that kind reaches (`'screen'`, the app's
  own screen; `'rustdesk'`, the RustDesk direct-access port). So the login, the control
  password, privacy mode and the rest are those of F-005/F-006; either end closing takes the
  other along. Who is controlling reads "Another device on this PC's page" (meta `from`, with
  this PC's ID). Remember me (F-008) takes this PC's own ID too: kept by its own agent.
- **The state** (`SelfInfo`, all optional, absent from an agent before this): `canOpenScreen`
  (RustDesk's direct port answers here), `canOpenAppScreen` (the app's own screen is ready),
  `savedPassword` (the ways it remembers for itself).
- **The page** (`src/remote/own.ts`): the Control page takes this PC as one more device
  (`ownDevice`: no link needed, so it never says the link is down). The Devices page offers
  **Control** on This PC only on a page opened from elsewhere: `onThisPc()` is false (the page's
  host is not localhost, 127.0.0.0/8, ::1 or a .localhost name). On the PC itself it says the
  phone can do it instead. `/keys` (F-013) is opened only where the browser runs on this PC and
  never for this PC's own screen: a page opened elsewhere would take a keyboard nobody there uses.
- **The phone's keyboard** (`src/remote/soft-keys.ts`, `client.ts text()`): a hidden field takes
  the phone's own keyboard; each change goes across as Backspaces and text, the text as one
  KeyEvent with `seq`, as RustDesk's soft keyboard sends it (ui_session_interface.rs
  input_string), and a new line as Enter. A key row under the screen on touch screens: Keyboard,
  Esc, Tab, Ctrl, Alt, Shift and Win, Del and the arrows. A touch on the picture leaves
  the phone's keyboard open (`input.ts` `keyboardField`).
- **Held modifiers** (2026-10-31): Ctrl, Alt, Shift and Win go down on the other PC at one tap
  and up at the next (Alt, Tab, Tab, Alt works the switcher). Meanwhile keyboard letters, digits
  and spaces go as keys, and a touch's clicks carry them (the host lets go of a modifier a mouse
  event doesn't name, fix_modifiers). The focus moving from the screen to the keyboard field
  keeps them held; anything else that lets go of everything there (the window losing the focus)
  shows on the row too, and the row going away lets them go.
- **A phone that goes away:** a page closed mid-session may not close the pipe at once; the
  app's own screen ends the session after 10 s without a word from the viewer (`silenceMs`),
  and RustDesk on its own timeout, so this PC's screen comes back on by itself.

## F-016 and F-017: the phone's mouse modes, and its keyboard opening by itself

Built 2026-10-30, both for the phone's Control screen (F-014).

- **F-016, touch or cursor mode** (`src/remote/touch-mode.ts`, `src/remote/input.ts`): a
  **Touch | Cursor** switch on the phone's key row, remembered in the browser. Touch mode is the
  phase-1 touch (a finger acts where it lands). Cursor mode is a touchpad: one finger moves the
  pointer by as much as it slides (on the picture's scale), a tap clicks where the pointer is, a
  two-finger tap or a long press right-clicks there, and the page draws the pointer on the picture
  (the other PC's own shape from its CursorData, or a plain arrow), since a phone has none.
  Both: double-tap and slide drags with the left button held; two fingers scroll. One tracked
  pointer serves the mouse too, so switching modes never makes it jump.
- **F-017, the keyboard by itself** (`agent/screen/text-focus.ts`, `text-focus-process.ts`, `text-focus-uia.ts`, `text-focus-worker.ts`): ours,
  not RustDesk's. The viewer sends `Misc.plugin_request` with id `sad.text-focus` and JSON
  `{"watch": true}` (`false` to stop); the app's own screen then answers `{"editable": bool}` at
  each change of "a text box has the keyboard focus here". RustDesk carries plugin messages this
  way and leaves one it has no plugin for alone, so a viewer on RustDesk just never hears back.
  The phone's page asks only while its key row shows, and only through the app's own screen.
  The answer comes from Windows UI Automation (what Windows' own touch keyboard asks):
  `GetFocusedElement`, then its control type and Value pattern; an Edit that isn't read-only, or
  a Document or ComboBox whose value can change (`editableOf`). It runs in a **child process** of
  its own (F-058: `text-focus-process.ts`, started with `fork` and spoken to over IPC; the asking
  itself is `text-focus-uia.ts`), polled every 300 ms while any session watches and looked at
  again 120 ms and 400 ms after each mouse button comes up; the process is ended, by its handle,
  with the last watcher (UI Automation makes Chrome turn its accessibility support on, so never
  longer than needed). If it ends any other way (koffi can end the process it runs in with
  `FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw`, which no try/catch sees) the agent
  goes on, logs it, and asks again after 0.5, 1.5, 5, 15, 30 s; more than 5 endings in 2 minutes
  are given up on until the app starts again. It used to be a worker thread of the agent, and
  stopping that thread while it was in a koffi call ended the whole agent (exit code 134; 3 of 3
  runs of a loop of start, click and stop died within 6 rounds, 40 of 40 are fine as a process);
  `SAD_TEXT_FOCUS=worker` brings the thread back. The page focuses its hidden
  keyboard field when told `true`, within the few seconds the tap that caused it lets a page open
  the phone's keyboard, and blurs it on `false` only if it opened by itself.

## F-018: the Agentic Workflow section (agentic/)

agentic-claude-manager's default mode, ported (sources: its `server/lib/floors.js`,
`terminal.js`, `toolCatalog.js`, `orchestrator-mcp.mjs`, `memory.js` and `index.js`
composeAgentBrief). Phase 1, built 2026-10-31: floors and agents, each agent's Claude Code chat,
and the tools those chats share. Workflows and Project Workflows, the prompt board, autopilot,
CRM goals, hooks, Skills and MCP are the later phases (features.html › F-018).

- **Floors** (`floors.ts`, `<state>/agent/agentic/floors.json`): a floor is a team working in one
  folder (`codeDir`; null is `Documents\shubham-agentic`, made on first use) with a preamble
  (`globalPrompt`, at most 8000 characters, given to every chat on it before the agent's brief). A
  new floor has its boss seated: **Lead**, the Orchestrator, with the original's brief. Agents
  (at most 24, names unique ignoring case) have a name, role, `reportsTo`, brief (`md`, at most
  20,000), `model` (`''` lets the CLI choose, or opus/sonnet/haiku), skills and MCP servers (named
  in the brief only, as in the original) and a desk position. The page saves the whole agent list;
  the store keeps each agent's `sessionId` from what it had (only `bindSession` sets it), refuses a
  list with two agents of one name, and repairs the chart on every read and write: one boss (the
  agent marked so, else the first), no dangling or looping `reportsTo` (a loop is cut at the agent
  walked first). The boss can be removed (the page marks its first direct report, else the first
  agent, as the new boss); the last agent leaves an empty floor, and the next added is its boss,
  "Agent 1" at the boss's desk.
  A corrupt file is set aside as `floors.json.corrupt-<ms>`, never overwritten.
- **Chats** (`chats.ts`): each agent's chat is the interactive claude TUI in a pseudo-terminal
  (node-pty 1.2.0-beta.12, ConPTY; N-API prebuilds, no compiler), as the original runs them: no
  `claude -p`, no SDK. Started as `claude --session-id <uuid> | --resume <id>
  --append-system-prompt-file <briefs/<id>.md> --mcp-config <mcp.json> [--model m]` in the floor's
  folder (claude.exe from PATH or `~/.local/bin`; a `claude.cmd` goes through `cmd.exe /d /c`).
  `--resume` when its transcript exists (`~/.claude/projects/<cwd with every non [A-Za-z0-9-] made
  ->/<id>.jsonl`); a transcript found under another folder (the floor's folder changed) resumes
  there, with the cwd read from its lines. Environment: this agent's, without `CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`, `CLAUDE_CONFIG_DIR`, `COS_*`, `MDV2_PORT` (an agent
  started from a Claude chat must not make child sessions), plus `TERM`, `COLORTERM`,
  `FORCE_COLOR`, the chat's key `SAD_AGENTIC_KEY` (`sad_` + 48 hex) and `SAD_AGENTIC_URL`, and
  `CLAUDE_CODE_OAUTH_TOKEN` read fresh from HKCU at each start (F-007 keeps it there). The brief
  is written at each start, so a changed preamble or brief reaches the next start.
- **Bringing in a conversation** (`transcripts.ts`, 2026-10-31): `GET /agentic/sessions` lists
  this account's conversations, every `<uuid>.jsonl` under `~/.claude/projects`, the 60 most
  recently written, each with its cwd (the first line that has one), title (the newest
  `custom-title`, else `ai-title`, else `summary`, from the first 128 KB and last 256 KB; else its
  first typed prompt), size, time, and the agent here it already is. `POST
  /agentic/floors/:id/import {sessionId, agentId? | name?, role?}` copies it under a new UUID
  beside the original (same project folder), streaming, with every line's `"sessionId":"<old>"`
  made the new id and nothing else touched (an escaped mention inside a message stays); a last
  line that doesn't parse (the original is being written) is left out, and the copy ends with a
  newline. Written as `<id>.jsonl.copying`, then renamed. Then a new agent (`name`, `role`; under
  the boss) gets it, or `agentId`'s chat stops and the agent takes it; if that fails the copy is
  deleted. Always a copy: the original may be open elsewhere (Christopher), and two claudes
  appending to one file fork it. The copy then opens like any agent's chat: its transcript is
  found under the folder it was held in, which becomes its cwd (409 when that folder is gone).
- **claude's own questions** (`claude-config.ts`): before a chat starts, `~/.claude.json` gets
  `hasCompletedOnboarding: true` and `theme: "dark"` when absent (this account's config may never
  have been set up: Claude usually runs through Christopher here), and
  `projects["<folder, / for \\>"].hasTrustDialogAccepted: true` for the floor's folder, which is
  what claude itself writes on "Yes, I trust this folder". Only absent keys are filled; an
  unreadable file is left alone. Fallback in the terminal: never a blind Enter (claude 2.1's trust
  menu starts on "No, exit"): it waits for the menu's cursor, steps it onto Yes, then presses
  Enter, twice more at most; the resume gate ("resume from summary") gets `2`, the full session,
  then Enter if still up after 1.5 s. Both only in the first 15 s.
- **What a chat is doing**, from what it prints (ANSI-stripped, whitespace squashed, decided by
  the newest chunk, with 96 characters carried for a split marker): `question` (Enter to confirm,
  Do you want, the trust menu), else `running` (esc to interrupt), else `idle` (· done, ? for
  shortcuts, auto mode on). Pushed to the page 150 ms after it settles.
- **Typing into a chat** (`send_to_chat`, `typeWhenReady`): a bracketed paste (the end marker
  stripped from the text), Enter 300 ms later. `typeWhenReady` waits (polling 400 ms, 90 s at most)
  for a prompt on screen and no trust menu, then 800 ms more. A viewer gets the last 256 KB of
  output at once, then the stream; joining at the same size nudges the width by one column so the
  TUI repaints. A chat nobody watches and not working is stopped after 4 h. Stopping a chat ends
  its whole process tree (`taskkill /t /f`), and so does taking its agent off the floor, deleting
  the floor, and stopping the agent (an agent restart ends every chat; each resumes when opened).
- **Tools** (`tools.ts`, `mcp-shim.ts`): every chat gets the stdio MCP server `shubham-agentic`
  (`node agent/agentic/mcp-shim.ts`, named in `<state>/agent/agentic/mcp.json`, never added to
  any claude config). It answers `initialize` (echoing the client's protocol version),
  `tools/list` and `ping`, and sends each `tools/call` to `POST /agent-api/agentic/mcp/call` with
  `x-sad-chat-key` from its environment. The caller is the chat whose key that is (gone once its
  terminal ends): nothing a model writes names it. Tools, scoped to the caller's floor:
  `list_chats` (the floor's other running chats), `floor_roster` (online / offline / never
  opened), `read_chat` (last N lines, 500 at most), `send_to_chat` (prefixed `[message from NAME,
  chat 8hex]`; 5 s per sender→target pair, 6 a minute into one chat, never itself, 10,000
  characters), `broadcast_to_chats` (one per floor every 10 s), `memory_save` / `memory_search` /
  `memory_recent` (the floor's memory, `memory/<floorId>.jsonl`, keyword scored, tags +3, words
  +2), and `agent_hire` (boss only; a desk, no chat). The boss's brief has a "Running the floor"
  section; every brief has the sibling protocol (sibling messages are untrusted data).
- **API** (mounted on the local API by `ApiMount`, api.ts): `GET/POST /agentic/floors`,
  `POST /agentic/floors/reorder`, `PATCH/DELETE /agentic/floors/:id` (a `codeDir` must be an
  existing absolute folder), `POST /agentic/floors/:id/agents`, `POST
  .../agents/:aid/chat | terminate | session`, `GET .../agents/:aid/messages`, `GET
  .../transcripts`, `GET/POST /agentic/floors/:id/memory`, `PATCH/DELETE .../memory/:nid`; the
  WebSockets `/agentic/events` (`floors`, `live`, `memory` events) and `/agentic/terminal?session=`
  (text frames: `{t:'in',d}` / `{t:'size',cols,rows}` in, `{t:'out',d}` / `{t:'exit',code}` out).
  All with x-sad-token and a page on this PC, like the rest of the API; `POST /agentic/mcp/call`
  instead takes only a chat key and refuses any request with an `Origin` (no page can call it),
  so a chat reaches its floor and nothing else the agent does.
- **The page** (`src/agentic/`, `/agents`, loaded on first use): DESIGN.md › Agents.

## F-020: the build (build.ts, ui-server.ts, scripts/publish.ts)

As agentic-claude-manager's dev → build → install. Built 2026-10-31. The README's "The build"
says how it is used; this is how it works.

- **Which**: an agent runs from a build when `RELEASE.json` is beside `agent/`
  (`{version, commit, dirty, builtAt, source}`; the version is the local time it was built,
  `YYYY.MM.DD-HHMM`), else from Dev. Dev on this PC (`findDevDir`): `SAD_DEV_DIR`, else the
  folder itself or its sibling `shubham-agentic-dev`, whichever has `agent/scripts/publish.ts`
  (which no build has). On the hub, a floor with no folder of its own works in Dev
  (`createAgentic` `defaultCodeDir`).
- **The Agents section is the build's** (2026-10-31): an agent from Dev starts without it
  (`startAgent` `agents: false`) unless given `--agents` (`npm run dev:try -- --agents`): no
  floors are read, no chat is started, and `agenticOff()` answers every `/agentic` route with
  `AGENTS_OFF_STATUS` (503, behind the token as before) and has no WebSockets, so the page shows
  "Agents run in the build" rather than a fault. Dev's floors (with `--agents`) are in its own
  state folder; Claude's conversation files are the account's, shared by both.
- **The page's name**: Publish builds the page with `VITE_SAD_KIND=build`, so it calls itself
  shubham-agentic-build (`src/app/app-name.ts`; `index.html`'s title through a Vite plugin);
  Dev's page is shubham-agentic-dev.
- **The page** (`--app <dir>`, `SAD_UI_PORT`, 5173 by default): `startUiServer` listens on
  127.0.0.1 and ::1 (never the network) and refuses a Host that isn't an IP, localhost or
  *.localhost (403, Vite's rule). `/agent-api` and below go to the agent's API on 127.0.0.1 with
  Host rewritten and `x-sad-token` dropped, then added again only when `local-host.ts fromApp` says
  the request is the app's own page; the API answering nothing is a 502 in its own error shape.
  WebSocket upgrades are written on to the agent the same way, then piped byte for byte (no frame
  limit; either side closing closes the other). Anything else is a file under `<dir>` (never
  outside it), `index.html` for an extension-less path (the router's), `assets/*` cached for a
  year as immutable, the rest `no-cache`; GET and HEAD only. A taken port is logged and tried
  again every 30 s; the agent runs on without its page meanwhile.
- **Updates** (a build that is a clone, `.git` beside it): `git fetch origin main` 30 s after the
  start, every 15 minutes and on `POST /build/check`; HEAD against `origin/main`, the newer
  build's version from `git show origin/main:RELEASE.json`. `POST /build/update` needs
  `SAD_SUPERVISED=1` (set by `Start.cmd`) and answers before the agent exits with
  `UPDATE_EXIT_CODE` (75); `Start.cmd` then runs `Update.cmd` (`git pull --ff-only`; `npm ci
  --omit=dev` when `package-lock.json` changed) and starts it again. Any other exit: started again
  after 5 s. (F-058: the guard does the same, within a second, and keeps 5173 open meanwhile.)
- **A stop always ends** (`exit-watchdog.ts`, `shutdown` in `main.ts`). On 2026-10-31 at 23:37 an
  Update now with five chats open logged `stopped` and never exited, so `Start.cmd` waited on it
  and neither updated nor restarted; why is not known. Each step of a stop has a time limit (the
  page 3 s, the tailnet page 3 s, `agent.stop()` 10 s, the log 2 s; a late one is logged and passed)
  and then `process.exit(code)`. Under `SAD_SUPERVISED=1` a stop first starts a watchdog for the
  case where `process.exit` itself hangs (it waits for worker threads and the thread pool): a
  hidden PowerShell, an ordinary child (started detached it exits without running), which opens a
  handle to this PID only if its start time is within 2 s of the agent's, and after 20 s calls
  `TerminateProcess(handle, code)` with the stop's code (75 stays 75), first appending a line to
  `<state>/agent/logs/exit-watchdog.log`. Node's job for its children ends it when the agent exits
  by itself. Tests: `exit-watchdog.test.ts`.
- **Publish** (`POST /build/publish {skipChecks?}`, the hub only, one at a time): runs Dev's
  `node agent/scripts/publish.ts [--skip-checks]` in Dev, keeps 400 lines (colour codes
  stripped) for `GET /build/info`, and reads the published version from its `PUBLISHED <json>`
  line; then checks for itself. Over the 400, the oldest plain line goes first (`trimLog`); a line
  starting `==` (the step headings and the checks' summary), `Done` or `Publish stopped` is kept, so the
  test run's dots, a line for every few tests, can't push "Checking: types" out of the log. `publish.ts`:
  Dev's commit and changes; `tsc -b`, `oxlint --deny-warnings` and the agent's tests (the dot reporter
  on the screen, the spec reporter's summary in `<state>/publish/tests-summary.txt` for the count,
  `testCountOf`), then one line `== Checks passed in 29 s: types, lint, 913 tests`; `vite build`; the build in `<state>/publish/stage`
  (tests, fakes, `agent/test`, `agent/system`, `publish.ts`, `dev-try.ts`, `build-system.ps1` and
  `build-files/` left out; `build-files/*` at its root; `.gitattributes` `* -text`); `npm install
  --omit=dev`; tried as a member on ports 21370–21378 with `SAD_HOME=<state>/publish/try-home`,
  started over IPC and stopped the same way (the page, `/agent-api/agentic/floors` through the
  page as the app, `/agent-api/build/info` naming this version, `require('node-pty')` and koffi);
  pushed from `<state>/publish/repo`, reset to `origin/main` first, every file but `.git` replaced,
  committed as Dev's git author (`user.name`, `user.email` from Dev), unless only `RELEASE.json`
  changed. The repo is made (private, with `gh`) when it doesn't exist.
- **Install** (`Install.ps1` in a build): `npm ci --omit=dev` when there are no packages; stops
  Dev's `start-hub.cmd` loop, then the node processes holding 21221 and 5173 (not started with
  `--app`), a previous run of this build, and agent chats left running (`claude.exe` with the app's
  `agentic\mcp.json`); replaces the Startup launcher `shubham-agentic-hub.vbs` (Dev) with
  `shubham-agentic.vbs` (this build's `Start hidden.vbs`); starts it through WMI (so it belongs to
  no window or session); opens http://localhost:5173 when it answers. `-Remove` undoes it.
- **Tests:** `ui-server.test.ts` (the page, the router's paths, caching, nothing outside the
  folder, both loopbacks, the Host rule; the API with and without the token, a forged one dropped,
  the agent down; a WebSocket both ways with a 2 MB message, and refused without the token) and
  `build.test.ts` (Dev and build, the three update answers, Update's exit code and when it is
  refused; Publish's lines, result, failure, one at a time, member or no Dev; `findDevDir`). The
  whole loop was run on the hub: Publish from the Build page (2026.10.31-1312), Update now, the
  agent back on it in 7 s.

## F-021: one session used from the hub's PCs in turn (agentic/index.ts, roam.ts, mirror.ts)

Built 2026-10-31, as Shubham chose: the session moves between PCs (not one PC running it and the
others watching). A Claude session is one JSONL that claude appends to; two PCs running it at once
would fork it, so one PC runs it at a time, and every PC keeps a copy.

- **Who keeps what.** The hub keeps the floors, the memory and `sessions.json`: per session, the
  PC holding it (running it, or granted it and starting) and where it ran last. A member shows the
  hub's floors (its last copy in `replica.json`) and sends every change to the hub, which runs it
  as its own page's change; with no link to the hub, the floors are read-only (503 "Server (the
  hub) can't be reached…"), no chat starts, and chats running there go on. A member with no hub,
  and an agent given no team, work alone as before. Its own floors (from before it joined) stay in
  its `floors.json`, not shown.
- **A folder per PC.** `Floor.folders` (device id → folder) holds the members'; `codeDir` stays
  the hub's. A member's page gets its own as `codeDir`, and its folder change is checked on that
  PC and sent as `folderFor` (a member may set only its own; the hub's `codeDir` only on the hub).
- **The link.** Streams of kind `agentic` on the mux, newline-delimited JSON; `meta.from` (added
  by links.ts from the paired record) says which PC opened it. A request is one line each way
  (`{ok, value}` or `{ok: false, status, error}`). Member → hub: `subscribe` (a standing stream:
  the hub sends `state` {floors, where, last, marks} 150 ms after any change and every 30 s, `jsonl`
  and `memory`; the member sends `hello`/`live` (its running chats), `marks` (every 30 s) and
  `jsonl`), `http` (a page change), `lease`, `release`, `tool`, `pull`. Hub → member: `stop`,
  `read`, `type`, `pull`. The member opens its standing stream when its link comes up, and again
  on a new link (a path change), checking every second.
- **Running a chat.** The hub's page opens it on the hub after `lease`; a member's asks the hub for
  `lease` {sessionId, takeOver}. Running elsewhere (or granted to a member within the last 60 s,
  or held by one that can't be reached): 409 "Lead's chat is running on Laptop. Take it over…"
  unless `takeOver`, which stops it there first (a member's `stop`: its claude ended, its last
  write waited for (no growth for 600 ms, 5 s at most) and sent, its mark answered; the hub then
  brings its own copy up to that mark). Granted, a member brings its copy up to the hub's mark
  (unless it already has all of it), then starts claude. Where on the PC: the floor's folder
  when the conversation is in its project folder; else the folder it was held in, when that exists
  here; else (it came from another PC) the file is moved under this PC's folder for the floor, and
  it resumes there. A chat that ends lets its session go (`release`, with its mark: the hub catches
  up first); a member's live list without a session it held (after 60 s) lets that go too.
- **The JSONL as it grows.** The PC running a chat looks at its file every second and sends what it
  grew by (`jsonl` {sid, from, base64}, at most 256 KiB a piece, 16 a tick); the hub writes it into
  its copy and passes it to the other members. Bytes are placed at `from`: appended at the end;
  where the copy already has them, checked; past its end ('gap') or differing ('diverged'), left
  to catch-up. A copy is only written by the PC running the session, or brought up to the others.
- **Catch-up.** A mark is a copy's size and the sha1 of its last 4 KiB. A member brings up every
  copy that is shorter than the hub's, or as long but different; the hub brings up its copy from a
  member that has more of one it holds (or nobody holds). `pull` sends the asker's mark; agreeing,
  only the rest comes; not, all of it, written beside and swapped in; a PC without one leaves the
  asker's alone. One pull at a time.
- **Tools.** A member's chat's tool calls go to the hub as `tool` (only for a chat that PC holds).
  `list_chats`, `floor_roster` (with `pc`), `read_chat`, `send_to_chat` and `broadcast_to_chats`
  reach chats on any of the hub's PCs (`read`/`type` to the member running one); memory and
  `agent_hire` are the hub's.
- **The page.** `FloorsAnswer` and the `where` event add `elsewhere` (chats on other PCs: pc and
  state), `last` (where idle ones ran last) and `team` (this PC, its role, the hub, reachable). An
  agent's status says "Working on Laptop", "Open on Laptop", "Not running · last on Laptop"; its
  window says it runs there and offers Take over on this PC (confirmed first); its ⋯ menu has Take
  over on this PC…; a 409 on opening offers Take over anyway, with the warning that it splits if
  the other PC is still running it out of reach. A member without its hub shows a strip saying so.
- **Tests:** `mirror.test.ts` (placing bytes, marks, following a file, catching up over a stream:
  the rest, all of it, or nothing), `team.test.ts` (two Agents backends, a hub and a member, each
  with its own API, folders and Claude projects, on an in-memory link: the floors through the hub
  and a folder per PC; a chat moved both ways with its JSONL, refused without take-over; a member
  chat's tools, list and message across PCs; the member without its hub; catch-up of a
  conversation into the member's own folder) and e2e step 11 (two real agents on a real link, a
  pretend claude: followed, taken over, the JSONL both ways, where it ran last).

## F-022: another PC's Claude conversations (agentic/index.ts, transcripts.ts)

- `GET /agentic/sessions?pc=&q=&limit=&offset=` → {sessions, total, pcs}: this PC's (or, with
  `pc`, another's, over the link: op `sessions`) conversations, newest first. `listSessions`
  stats every file and reads a page's (or, with `q`, every one's) first 128 KB and last 256 KB,
  remembered per file until its size or time changes. Each has `pc`: where it was held, or the PC
  it was copied from (`origins.json`); another PC's are marked `here` when this PC has a copy.
- `POST /floors/:id/import {sessionId, pc}` brings the file over first (op `session-files` for
  its project folder name, then `pull` into the same name here), then copies it as before; held
  in a folder this PC hasn't got, the copy goes under the floor's folder here.
- `POST /agentic/sessions/copy-all {pc}` (one at a time; `GET` for how far): every file on that PC
  this one hasn't got or has less of is pulled into the same project folder name, skipping chats
  running here. Tests: `team.test.ts` (listed with its PC, brought onto a floor, all copied).

## F-023: Use here (agentic/index.ts)

- The page's `/agentic/terminal?session=` for a chat running on another of the hub's PCs opens an
  `agentic` stream `terminal` to it: first line {sessionId}, then the page's messages one JSON line
  each, and the far end's (the replayed screen, output, exit) back. The far end attaches it as one
  more viewer of the chat (its size messages resize it, as a local viewer's do). Messages sent
  before the stream opens are kept and sent once it does. Test: `team.test.ts` (screen to the
  laptop, keys to the Server, still running there).

## F-025: Run on (agentic/index.ts)

- `POST /floors/:id/agents/:agentId/run-on {pc}`: this PC: `openChat` with take-over; another:
  an `agentic` request `open` {floorId, agentId}, which runs the same there. `team.pcs` lists the PCs
  reachable now. Test: `team.test.ts` (from the Server to the Laptop and back).

## F-026: Publish only when Dev has something new (build.ts, scripts/publish.ts)

- `devFingerprint(dir)`: sha256 (20 hex) of `git rev-parse HEAD`, `git diff HEAD --binary` and every
  file of `git ls-files --others --exclude-standard` (name and content). Publish writes it to
  RELEASE.json as `devHash`, taken before anything is built. The hub reads Dev every 20 s and on
  check; `publish.pending` is false when it equals the newest build's (the last published here, the
  newer one on GitHub, or the current), null when that build has none. Test: `build.test.ts`.

## F-028: open to the tailnet (build-files/Open-To-Tailnet.ps1, ui-server.ts)

- The script (elevating itself) writes `<state>\agent\open-to-tailnet` and adds the firewall rule
  "Shubham Agentic: all ports from the tailnet" (TCP and UDP, every port, RemoteAddress
  100.64.0.0/10, every profile); `-Remove` deletes both. The agent looks for the marker every
  30 s: present, a second page server on the Tailscale address (`SAD_UI_TAILNET_PORT`, 5190) with
  `allowRemote` taking only tailnet and loopback addresses (403, or the socket closed, for
  others); gone, it is closed. Its API token rule is the page's (fromApp: an IP Host, same origin).

## F-051: the memory layer (agentic/memory-layer.ts and the files it names)

Kept on the hub (or a PC on its own); a member's chats reach it through the hub, their tool
calls as before (`tool`), their recall as the internal tool `memory_recall`, the page's routes
as any non-local route.

- **Raw, never changed:** the floors' notes (memory.ts, as before), and the floor chats' turns
  (memory-turns.ts): read from each floor session's JSONL as it grows (a cursor per session,
  whole lines only), a turn is something said (Shubham's, or another chat's `[message from ...]`)
  with the chat's last text before the next one as its answer, closed by the next message or 3
  minutes of quiet; kept in `memory-layer/turns.jsonl`, once per message uuid (a copied
  conversation, F-022, is not kept twice). Tool results, slash commands, claude's notices and
  `<system-reminder>`s are not turns. No model is run for any of this.
- **The wiki** (wiki.ts), Karpathy's LLM wiki in `<state>/agent/agentic/wiki`: `SCHEMA.md` (the
  librarian's rules; written only when missing), `core.md` (the always page), `index.md` and
  `log.md` (written by the app), `inbox/` (each run's material, never changed), pages in
  folders (`people/`, `projects/`, `howto/`, `decisions/`, `setup/`, `topics/`); front matter
  `title`, `summary`, `tags`, `updated`. A git repository when git is on PATH, a commit after each
  run (the identity given with `-c`, no global config touched).
- **Search** (memory-search.ts, embedder.ts): every wiki section, note and turn, by words (BM25,
  code-like names whole and in parts) and by meaning (bge-base-en-v1.5, 8-bit, through
  onnxruntime-node, 2 threads; a passage cut at 320 tokens, a turn embedded by its first 1,000
  characters). Fused: min-max over each list's top 50, meaning weighted `0.8 - 0.6 × c²` where `c`
  is the best words hit's share of the query's words by rarity. The model is fetched at first use
  from Hugging Face into `<state>/agent/models` (sha256 checked against `X-Linked-Etag`); until
  it is ready, and if it can't be had, search goes by words. Vectors are kept in
  `memory-layer/vectors-<model>.jsonl` by the sha1 of what was embedded, compacted once mostly dead.
- **Recall:** each floor chat starts with `--settings hooks.json` (one `UserPromptSubmit` command,
  `"<node>" "<memory-hook.ts>"`, forward slashes, both quoted; claude adds it to the user's own
  settings: checked, a project's hook and this one both run). The hook posts the prompt to
  `POST /agentic/mcp/recall` with the chat's key (ownAuth, as `/mcp/call`: no token, refused with
  an Origin) and prints the answer as `additionalContext`; on any error it prints nothing and
  exits 0. Nothing is searched for a slash command, another chat's message, or under 3 words of
  3+ letters. Up to 4 hits, each with meaning ≥ 0.62 or a share of the words ≥ 0.75, never the
  chat's own turns, one section per page, none shown to that chat within its last 8 prompts.
- **The brief:** `## What you remember` last in every chat's brief: what the memory is, core.md
  (4,000 characters at most) and the wiki's pages (3,000 characters, newest first). A member
  takes it from the hub (`GET /memory/brief`), fetched every 5 minutes and as a chat starts.
- **The librarian** (librarian.ts): `claude -p --model <sonnet|haiku|opus> --restricted
  --strict-mcp-config --tools Read,Write,Edit,Glob,Grep --permission-mode acceptEdits
  --no-session-persistence --output-format json --append-system-prompt-file SCHEMA.md`, in the
  wiki's folder, the prompt on stdin, `CLAUDE_CODE_OAUTH_TOKEN` as the chats have it, the child
  session markers and `SAD_*` dropped, 20 minutes at most. One run takes up to 100,000 characters
  of material (notes, then Claude Code's memory files from `~/.claude/projects/*/memory/`, then
  turns oldest first, an answer as its first 700 characters). After it: the pages changed (by
  size and time), the index written, the log appended, a commit, the run kept (20) with its cost
  and tokens from claude's JSON. A failed run removes its inbox file and compiles nothing.
  Turns from before the layer first started (its baseline) are the past: compiled only with
  `pastChats` on, in order, behind their own cursor. **Compile by itself** is off by default; on,
  every 15 minutes it runs once `everyHours` (24) have passed and 1,500 characters are waiting.
- **Switched on** by main.ts (`memory: { meaning: true, start: true }`): the layer starts with the
  agent, chats get the hook and the brief's section. Without it (the build until Shubham says, and
  the tests): the layer starts at first use, by words only, and chats get neither.
- **Tools:** `memory_search` answers `entries` (the floor's notes by keyword, as before) and `hits`
  (all of the memory; `mode: "keyword"` for the old answer alone); `memory_read` opens a page by
  path or a hit by id. **Routes** (the page's, a member's to the hub): `GET /memory/status`,
  `/memory/search?q=&kinds=&limit=`, `/memory/wiki`, `/memory/page?path=`, `/memory/read?ref=`,
  `/memory/brief`, `POST /memory/compile {mode}`, `PATCH /memory/settings`.

## F-050: the chat view (agentic/chatview.ts, screen.ts)

The Chats page (DESIGN.md › Chats) reads a chat's conversation and what is on its screen, and types
into it. Types: `shared/chat.ts`. Nothing here reads a whole conversation file: they reach hundreds of
MB (`GET .../messages` was bounded to its last 8 MB for the same reason).

- **Rows to items** (`Converter`, `parseRow`). Claude's JSONL rows, in file order, become `ChatItem`s:
  the person's messages (a `[message from NAME on FLOOR, chat 8hex]` prefix makes it a sibling chat's,
  with `from`), the agent's text blocks (markdown), tool calls (`label`, a one-line `summary`, `detail`,
  `status` running until their answer, `output` cut at 1500 characters, `ask` for AskUserQuestion) and
  notices (an interrupt, a compaction, a command's output, claude's own error lines). A message typed
  while claude was working arrives as an `attachment` of type `queued_command` (commandMode `prompt`),
  not as a user row. Left out: rows that start `{"type":"` (api-request, mode, ai-title... never
  parsed, some are megabytes), sidechains, meta rows, task notifications, system reminders.
- **The end of a file** (`readTail(file, {end?, messages?})`): lines are cut on the newline byte, a window
  of 512 KiB at the end is widened (×4, to 48 MiB) until it holds the last 40 messages (not counting tool
  calls), and the result has `before`, a byte offset to ask the page before with (null: the start). A
  tool call with no answer in an older page is shown done. Checked on 5 real conversations (290 MB: 66 ms).
- **Following** (`createChatFeeds`): one follower per watched session, stat every 350 ms while a page has
  it (a new file appearing, a swapped-in copy (a different file id) = a new `hello`), what the file grew by
  as `add` (`patch` for a tool call's answer); a line still being written waits for its newline.
- **API** (`/agentic`, token as the rest): WebSocket `/chat?session=<id>` sends `hello {items, before, size}`
  then `add {items}`, `patch {id, patch}`, `menu {menu|null}`, `status {status|null}`; `GET /floors/:f/agents/:a/chat?before=&limit=`
  (an older page, `local`), `GET /previews` (`ChatPreview` per agent: the last thing said, cached by file size
  and time, `local`), `GET /runs` (F-062, `RunsAnswer`: per agent what its chat really runs on, from the end of
  its conversation file (`runinfo.ts`): the model of its newest answer, its newest `/effort` and when, and the effort
  this PC started the running chat with; plus the default model: `ANTHROPIC_MODEL`, else `model` in claude's
  settings.json, else what the newest chat that pinned none ran on; `local`), `POST /floors/:f/agents/:a/say {text}` (at most 20,000 characters: typed as a paste and
  Enter, as `send_to_chat`; a chat started less than 20 s ago waits for its prompt, one not running is started
  or resumed first and the text follows once it is ready; `local`).
- **The screen** (`screen.ts`, a terminal model: cursor, print, wrap, scroll, erase/insert/delete; colours
  and modes skipped; no package). `chats.ts` keeps one per chat, fed as it prints and resized with the pty;
  `screen(sessionId)` returns its lines. `readMenu(lines)`: the footer ("Enter to select|confirm" or
  "Esc to cancel"), the numbered options above it (with their notes and which one the cursor is on), the
  question and the chip (`☐ Color`); `multi` for boxes to tick. `readStatus(lines)`: the spinner line
  ("✽ Pollinating… (5s · ↓ 167 tokens)"), only while the footer says "esc to interrupt". The feed polls them
  with the file and says a change once. A chat on another PC has no screen here (no menu, no status).
- **Found in claude 2.1.316** (recordings in `screen.fixture.ts`): in its plain screen it writes an answer in
  one piece when the turn ends (no words stream), the question menu says "Enter to select" (the state
  detection takes `entertoselect`), and a number alone (no Enter) answers it.
- **Tests:** `chatview.test.ts` (items, tails, paging, a 120 MB file, the follower), `chatroutes.test.ts`
  (the socket, history, previews, say, the menu over the socket), `screen.test.ts` (the model, and the
  recorded menu and spinner), and in `shared/`: `chat-markdown.test.ts`, `chat-rows.test.ts`.

## F-056: the task list (agentic/tasks.ts)

The Tasks page (DESIGN.md › Tasks) and every chat share one list of tasks, kept by the hub. Types:
`shared/tasks.ts` (`Task`: id, text, done, createdAt, updatedAt, doneAt, deletedAt, `by` {kind
`you`|`agent`, name, floor}).

- **The store** is `TaskStore` (`tasks.ts`): `list({status, query, limit})` (newest first, never the
  deleted), `counts()`, `get(id)` (a deleted one too), `add({text, by, id?})`, `update(id, {text?, done?,
  deleted?})` (404 `No such task`; `deleted: false` brings one back) and `onChange(listener)`. Nothing
  outside `tasks.ts` knows where tasks are kept, so a hosted store (a Supabase table with id uuid, text,
  done, created_at, updated_at, done_at, deleted_at, by_kind, by_name, by_floor) can implement the same
  interface and be chosen in `createAgentic`; `onChange` is there so that one can tell about changes
  other devices made.
- **The file store** (`createFileTaskStore`): `<state>/agent/agentic/tasks.json` as `{tasks}`, written
  whole with `writeAtomic` after every change; a corrupt file is renamed `.corrupt-<ms>` and the list
  starts again; rows are checked as they are read (odd ones left out, missing parts filled in). Text is
  trimmed, 1 to 2000 characters (400); at most 5000 tasks (409). `createdAt` is strictly increasing
  (`max(now, newest + 1)`), so two adds in one millisecond keep their order. A deleted task is kept 30
  days (dropped the next time the file is written after that), so Undo works. An `add` with an `id` already
  used (8 to 64 of `A-Za-z0-9_-`, else 400) answers with that task and changes nothing: the page's retry
  after a lost answer can't add twice.
- **Routes** (`/agentic`, not `local`: a member passes them on to the hub, 503 when it can't): `GET /tasks?status=open|done|all&q=&limit=`
  → `{tasks, counts}` (counts of the whole list, whatever the filter), `POST /tasks {text, id?}` → `{task}`,
  `PATCH /tasks/:id {text?, done?, deleted?}` → `{task}` (400 for nothing to change), `DELETE /tasks/:id`
  (a soft delete) → `{task}`.
- **Events:** every change is one `{t:'tasks'}` to every page's events socket and every member's
  subscription (a member re-emits it to its own pages). It carries nothing: a page asks for the list.
  Reading, and a change that is refused, ping nothing.
- **Tools** (`tools.ts`, run on the hub like the memory's): `task_add {text}` (added as that chat's agent:
  `by` has its name and floor; the same open task added within 10 minutes answers `{id, note}` instead of a
  second one), `task_list {status?, query?, limit?}` (open by default, 30, at most 100; each with its id,
  text, done, when and who added it, plus the counts), `task_update {id, done?, text?, delete?}`. A chat's
  brief (`briefs.ts`) says when to use them.
- **CRM goals as tools** (`crm-goals.ts`; `crm_whoami`, `crm_members {query?, limit?}`, `crm_goals {status?, assignee?, query?, limit?}`, `crm_goal_add {title, description?, priority?, dueDate?, assignees?, status?, parentGoalId?}`, `crm_goal_update {id, title?, description?, status?, priority?, dueDate?, assignees?}`): the CRM Goals page's own routes (GET/POST `/v1/org/goals`, PATCH `/v1/org/goals/:id`, `/v1/org/members`, `/v1/auth/me`) through the CRM proxy, so a goal is by whoever is signed in to the CRM on this PC (the owner): `ADMIN_TOOLS` + `NEEDS_SERVER` like the task tools, never the fast stand-in's. Organisation (General) goals only, assigned to him unless named; vocabulary is the CRM's (todo | done | abandoned; low | medium | high | urgent; `dueDate` a day, `today` or `tomorrow`); the same goal added within 10 minutes is added once; no delete (abandoned takes a goal off the board); the CRM's refusal comes back in its own words, a missing sign-in is a plain 409 and nothing is sent. Replaces the scyramp-ai-ship `crm_goal_*` for the Goals page (the old tools' retired statuses in-progress/review, boards by scope and a hard delete are not carried over).
- **CRM reads as tools, slice 1** (`crm-reads.ts`, `crm-catalog.ts`, `crm-scopes.ts`, `crm-call.ts`, generated `crm-routes.ts`; `crm_scopes {query?, type?, limit?}`, `crm_board {targetType?, targetId? | name?, limit?}`, `crm_catalog {query?, paths?}`, `crm_query {path, params?, fields?, limit?}`): read only (GET), by the CRM sign-in of this PC, `ADMIN_TOOLS` + `NEEDS_SERVER`. `crm-routes.ts` is the CRM's own `/v1/org` route list read from `sam-crm-be/routes/orgRoutes.js` by `agent/scripts/gen-crm-routes.ts` (it records the CRM commit; run it again when the CRM adds a route); a path that is not in it is refused before anything is sent. `crm_query` never returns what holds passwords, keys or AI costs (email and Vercel accounts, AI, upload token, usage, subscriptions, model settings): refused by path, and any field named like a password/token/key/cookie is `[hidden]` in a row. Money (ledger, transactions, bank, invoices, payments, quotes) is readable. Boards: `mine` (assigned to the signed-in person), General, a service (`target_type` service + `target_id`) or a project (`project_id`), by id or by a name that is exactly one board's (unknown or ambiguous is refused).
- **CRM writes as tools, slice 2** (`crm-write.ts`; `crm_write {method: POST|PATCH|PUT, path, body?}`, and `targetType`/`targetId`/`targetName` on `crm_goal_add` and `crm_goal_update`): `crm_write` is a production write to any route in `crm-routes.ts` that `crm-catalog.ts` allows, as the CRM sign-in of this PC (`ADMIN_TOOLS` + `NEEDS_SERVER`); it never deletes, never touches money (ledger, transactions, recurring transactions, bank statements and accounts, invoices, invoice builders and templates, payments, pillar pay, scopes of work: wherever they sit in a path), people's access or attendance, or passwords and keys; those are listed for Shubham's decision (crm_catalog marks each route "not offered"). A path the CRM does not have, a path part or a body key ending `_id`/`Id`/`_ids`/`Ids` that is not an id (a name), and a body over 50,000 characters are refused before anything is sent. The same POST (path and body) within 10 minutes is sent once; the answer is shortened and any password/token/key-named field in it is `[hidden]`; the log says only "wrote to the CRM". Goals on a board: a service is `target_type` service + `target_id`, a project is `project_id` (General is `target_type` organization), found by id or by an exactly-one name from the CRM's own lists; the duplicate guard also keys on the board.
- **Goals on mobile: use the API** (`shared/goals-on-phone.ts`, `assistant-settings.ts`, `ui-bridge.ts`, `src/overlay/ui-link.ts`, `GET|PUT /agentic/assistant-settings`; Settings › Assistant): the overlay Assistant on a PHONE adds, changes and lists CRM goals with `crm_goal_add`, `crm_goal_update` and `crm_goals`, and does not drive the CRM's Goals page. A page says whether it is a phone (the overlay's own rule, narrower than 640 px) in the state it reports; the bridge keeps it per page and `onPhone()` says it for the page a call would drive. With the setting `goalsOnMobile` on (the default; one small file `assistant-settings.json` on the hub, changed by the Settings row), `ui_control` `crm_goto` to `goals`, `goals/<id>`, `tasks` or `goals-2` and `ui_invoke` of a module or handler with `goal` in its name are refused with 409 BEFORE anything reaches the screen, the answer naming `crm_goal_add`, `crm_goal_update` and `crm_goals`; every `ui_*` call to a phone also carries `goalsApi: true`, and the page then refuses `click`, `type`, `key` and `invoke` while the CRM is on its Goals page (CrmApp writes `data-crm-route` on its box; the driver reads it). `ui_screen`, `ui_modules`, `goto` and every other page stay open. A PC is never refused, and with the setting off neither is a phone. The Assistant's brief says so (`BRIEF_VERSION` 8 to 9, so an Assistant with the old brief is given the new one when the overlay opens).
- **The Assistant's tool list at an Update** (`tools-seen.ts`, `mcp-shim.ts`, `GET /agentic/mcp/tools`): a chat's MCP process (`mcp-shim.ts`, started by claude with the chat) read `TOOLS` once when it started, claude listed the tools once, and the chat host keeps the chat through the agent's restart, so a tool added by an Update (the `crm_` tools of build 1108) never reached a chat started before it. Now the shim of a full toolset asks the agent for the current list (`GET /mcp/tools?given=1`, with the chat's key, never from a page) at `tools/list`, keeps it for its own `tools/call` check, declares `tools.listChanged`, and every 30 s asks for the list's stamp (`?stamp=1`; a short hash of `TOOLS`) and sends `notifications/tools/list_changed` once per change. The agent writes down which stamp each chat's shim was last given (`chat-tools.json`, kept 200). A shim from before this (never asks), or one claude does not re-ask, is seen as behind: after the agent has been up 120 s (`toolsRefreshGraceMs`), every 60 s, the Assistant's chat only (the Orchestrator duty) is restarted by `restartChat` (told `/exit` while idle, nothing killed, no unsent text in its box, its conversation resumed with the new process), once per list. `SAD_ASSISTANT_TOOLS_REFRESH=0` or an `assistant-tools-refresh.off` file in the agentic folder switches that off. An agent from before this has no route: the shim keeps its built-in list and says nothing. The fast Assistant's process (`SAD_TOOLSET=fast`) is unchanged.
- **The page** (`src/tasks/`): `store.ts` keeps the hub's list as last seen (the newest 300 are kept in
  `localStorage` `sad-tasks-cache`, so the tab opens with a list on screen) and an outbox (`sad-tasks-outbox`) of
  what the page asked for and the hub hasn't confirmed: `add` (with the id the page made) and `patch`
  ops. What is shown is `deriveTasks(server, outbox, ghosts)` (`shared/tasks-model.ts`): nothing is rolled
  back by hand, a confirmed or refused op leaves the outbox and the view is worked out again. The outbox is
  sent in order; a failure that `retryable(status)` (no answer, 5xx, 408, 425, 429, 401, 403) keeps it and
  tries again after 2, 5, 10, then every 30 s (and on `online`, and when the tab is shown again); one the hub
  refused (400, 404, 409...) is dropped (a toast, except a 404 on a change). The list is asked for again
  after the events socket's `tasks` (`useTasksSignal` in the Agents store, which also changes when the socket
  reconnects), when the tab becomes visible, and every 45 s as a safety net; an answer that a confirmed
  change overtook is not believed. A draft in the capture field is kept in `sad-tasks-draft`.
- **Tests:** `tasks.test.ts` (the file store), `taskroutes.test.ts` (the routes, the ping, the chats' tools
  and their key), `team.test.ts` (the laptop through the hub, and the hub out of reach), `index.test.ts`
  (the tool list), and in `shared/`: `tasks-model.test.ts`.

## F-054: the CRM as a page, built into the app (crm-host/, agentic/crm.ts, agentic/crmproxy.ts, src/crm/)

The CRM (sam-crm-fe, a Next 15 app) is compiled into the page and shown at `/crm` and on Alt+B; its backend is
reached through this PC's agent, with this PC's CRM session. The CRM's own website in a frame is the second
mode, a setting the hub keeps. Types: `shared/crm.ts`. Shubham's words: the CRM inside the build, not an iframe;
"it has to load fast"; it was already done in agentic-claude-manager (its `vite.config.ts`, `crm-shim/`).

- **The compile** (`crm-host/vite-plugin.ts`, first in `plugins`). The source is `SAD_CRM_SRC` or `../../sam-crm-fe/src`
  from Dev (read in place; both repos stay read-only). `SAD_CRM=off` leaves it out (`virtual:crm-app` is then a stub
  and the page says so); `SAD_CRM=required` (Publish) fails the build when the source is missing; otherwise it is in
  when found. In the CRM's files only (importers under the source): `@/` is rewritten to `@crm/` in memory (Vite's own
  alias plugin would take `@/` for this app's `src`; `@crm` is an alias of the CRM's source); `next/navigation`,
  `next/link`, `next/dynamic` and `next-themes` resolve to `crm-host/shims/*.tsx` (forward-slash ids, so there is one
  module instance); `lucide-react` is a generated shim with an explicit export list (the names the CRM uses, and
  `Github`, drawn locally: lucide 1.x dropped brand icons); `framer-motion` is `motion/react`; a bare import is resolved
  from this project (the CRM has no `node_modules`). `config()` defines `process.env.NEXT_PUBLIC_API_URL` as
  `/agent-api/agentic/crm-proxy` (the CRM adds `/v1`) and the other `NEXT_PUBLIC_*` it reads, adds the source to
  `server.fs.allow`, and raises `chunkSizeWarningLimit`. `virtual:crm-app` exports `CrmApp` (or null) and `bundled`.
  `crm-host/` is outside `src/`: it is not type-checked or linted (`tsconfig.node.json` includes only the plugin,
  `.oxlintrc.json` ignores `crm-host/**`).
- **`CrmApp`** (`crm-host/CrmApp.tsx`, a chunk of its own with `crm.css`): the CRM's root providers (react-query,
  tooltip, toaster, org, permissions), its router, and its own `app/(crm)/layout` (sidebar, header, auth guard) around
  a `Screen`. `crm-host/routes.tsx` lists the CRM's screens as lazy chunks (`matchCrmRoute`). `bridgeSession` sets the
  CRM's `crm_logged_in` hint (its `getToken()` answers null without it) while rendering. The CRM's portals go to a host
  div in `.crm-app` (`window.__CRM_PORTAL__`). `ThemeBridge` keeps the app's `data-mode` and the CRM's `dark` class and
  `localStorage.theme` one. A page that throws takes only itself down (`PageBoundary`). The box `.crm-app` is `overflow-hidden` and the CRM scrolls in `[data-crm-scroll]` inside it, with the portal host beside that element, not in it: a fixed element inside a scrolled, transformed box is placed against the content, so with the box as the scroller the sidebar and any dialog opened after scrolling landed off screen (F-061 found it on the Usage page; `aside.fixed` and the `.min-h-screen` rule are sized to the box, not the window). `crm.css` is a Tailwind v4
  sheet (`@reference` to the app's, `@source` over the CRM's files); `.crm-app` re-points this app's tokens to the CRM's
  palette and has `transform: translate(0)`, so the CRM's fixed sidebar and overlays are placed in its box.
- **The router** (`shims/navigation.tsx`): the CRM's address is a path and a query in state, not the browser's (the app
  owns `/crm`): `useRouter` (push, replace, back, no-ops for the rest), `usePathname`, `useSearchParams`, `useParams`,
  `redirect`. Where it was left is kept in `localStorage` (`sad-crm-last-route`), never a sign-in path. A CRM route
  asked for with `window.open` or `<a target=_blank>` is taken while the CRM is on screen. The CRM's guard sends a
  visitor it can't use to `/login` without rendering the page, so the router itself calls `onNeedSignIn` for `login`,
  `signup` and `forgot-*`.
- **The proxy** (`agent/agentic/crmproxy.ts`, `createCrmProxy({file})`; the file is `<state>/agent/crm-session.json`).
  `session()` is `{signedIn, name, username, expiresAt}` from the session file (7 days from `signedInAt`, `SESSION_MS`);
  never its cookie. `handle(req, res, sub, search)` forwards to the CRM's own origin only (a path that leaves it is a
  400): 401 with no session; OPTIONS answered 204; GET, HEAD, POST, PUT, PATCH and DELETE (405 for the rest). Not passed
  on: hop-by-hop headers, `host`, `origin`, `referer`, `content-length`, `accept-encoding`, `cookie`, `x-csrf-token`,
  `x-sad-token`, `x-sad-chat-key`, `sec-*`. The body is held whole (at most 25 MB, else 413: a CSRF retry sends it
  again). For a mutating method the CRM's CSRF pair is made: `GET /v1/auth/csrf-token` with the session (kept in memory
  per cookie), then `x-csrf-token` and the `crm_csrf` cookie; a 403 that mentions csrf is mended once. Not passed back:
  hop-by-hop headers, `set-cookie`, `strict-transport-security`, `content-security-policy`, `x-frame-options`, the
  cross-origin policies, `access-control-*`; `Cache-Control: no-store`; the body is streamed; an unreachable CRM is a
  502 naming the host and the cause. The cookie, the CSRF token and the session are never logged and never in an answer.
  It is an `ApiMount` `raw` route (`agent/api.ts`: an optional `raw?(rest, url)` hook before the JSON handling),
  `/agentic/crm-proxy/*`, local to this PC (not passed to the hub: each PC has its own session).
- **Routes** (`/agentic`): `GET /crm?origin=<the page's origin>&fresh=1` -> `{mode, url, check}` (`mode` is `bundled`, the
  default, or `frame`; `url` and `check` are for the frame way: the check of the address, kept 30 s per address and
  origin unless `fresh`; both null while there is no address); `PATCH /crm {url?, mode?}` (400 for a bad address or a
  mode that isn't one of the two); `GET /crm/session` (local) -> the session's `{signedIn, ...}`. Settings are kept
  whole in `<state>/agent/agentic/crm.json` as `{url, mode}` (`createCrmStore`: `get()`, `set(patch)`).
- **The address** (`crmAddress`, for the frame): `new URL(..).toString()` without `#...`: https only (http for
  localhost, 127.0.0.1 and [::1]), no user name or password, at most 300 characters; a bare host is taken as https; empty
  or null clears it. **The check** (`checkCrm(url, {app, fetch, timeoutMs})`): one GET (redirects followed, the body
  cancelled, 8 s) and a `CrmCheck` {ok, reason, status, message, header, ms}; reasons `dns`, `cert`, `refused`,
  `timeout`, `network`, by status 402 or `x-vercel-error: DEPLOYMENT_DISABLED` is `disabled`, 404 `notfound`, other
  4xx/5xx `status`, and `framing` when `X-Frame-Options` is DENY or SAMEORIGIN or a CSP `frame-ancestors` list leaves
  the app out. Run against the real sites on 2026-10-31: scrm/sam/sam-crm-fe `disabled`, crm `dns`, bcrm `cert`, crmbe
  `framing`.
- **The page** (`src/crm/`): `CrmHost` (eager: Alt+B in the capture phase so the terminal can't stop it, and the
  keep-alive; two sizes of one overlay: on `/crm` the rectangle of `<main>` kept by a ResizeObserver, on `/crm?full=1`
  the window), `CrmFrame` (lazy: the modes, `SignInCard`, `AddressCard`, `Frame`, the corner `Pill`), `Bundled.tsx`
  (`BundledCrm`: the `virtual:crm-app` import is a lazy chunk, loaded on the first open; `NotBuiltIn` when the build
  was made without the source), `data.ts` (`useCrm`, `useCrmSession`). Alt+B (`isCrmShortcut`: the physical B key with
  Alt alone) from anywhere else remembers the address in `sessionStorage` and goes to `/crm?full=1`; from the full window
  it goes back to what was remembered (`leaveTarget`); on the CRM page it goes full window and back. The CRM is let go 10
  minutes after the page was left. `SignInCard` posts the Devices sign-in (`claudeSignIn`: the password goes to the
  agent, which keeps only the session); `onNeedSignIn` swaps the CRM for it, and signing in remounts the CRM.
- **Publish and the build** (`agent/scripts/publish.ts`, `agent/build.ts`): the page is compiled on the hub PC from the
  checkout beside Dev; the build repo gets only `app/`, so a build needs neither `sam-crm-fe` nor the CRM's packages and
  its `package.json` has only the runtime ones. Publish stops before the checks, with a sentence, when `crmSourceDirs(DEV)`
  is empty, builds with `SAD_CRM=required` and prints the CRM's commit; `devFingerprint(dir, git, also)` hashes the CRM
  source's commit and changes too (a folder git can't read adds nothing), so a change there is something new.
- **Measured** (the published build, run from its stage folder through its own page server on this PC, headless Chrome,
  a stand-in CRM backend): the build output 51 files and 2.41 MB without the CRM, 486 files and 16.38 MB with it; what the
  page loads at start 1030 KB raw / 311 KB gzip before, 1046 KB / 322 KB after; the CRM's stylesheet 275 KB (37.5 KB gzip);
  first open to the CRM's first screen 792 ms, after a reload 723 ms with no JavaScript downloaded, back after leaving
  about 84 ms, with the CPU slowed 4x 1.38 s; a crawl of the 87 CRM screens that need no id in their address: all open.
- **Not checked:** the real CRM backend with a real session; a real phone over Tailscale; a hardware keyboard on Android.
- **Tests:** `crm.test.ts` (the address, the file and the mode, the headers matrix, the check against stand-in sites, the
  routes through the API), `crmproxy.test.ts` (the session file as the Devices page writes it, who is signed in and
  signing out seen at once, a call with the session and the page's own credentials and origin left behind, the CSRF
  pair fetched once and mended once, the CRM's answer as it is including a file byte for byte, a path that can't name
  another host and 401 with no session, the app's token and origin rules and a 502 that names only the host),
  `shared/crm-nav.test.ts` (the key, the addresses, where leaving goes), and in `build.test.ts` the fingerprint with
  the CRM and `crmSourceDirs`.

## Claude subscription failover and switch (claude/failover.ts, the switch in claude/index.ts)

Built 2026-10-31. A task Shubham set, not a numbered feature. The CRM keeps two Claude
subscriptions for the office, "Office 2(Jagtap)" and "Office 1", and puts each person on one
(F-007). Shubham's choice: stay on Office 2 until its weekly limit is used up, then carry on on
Office 1 by itself and tell him; and a switch he can make himself on the page (This PC › Which
Claude subscription). Everything below is reads, except one write.

- **The one write** (`claude/crm.ts` `moveMeTo`): `PUT /v1/org/model-settings/<the signed-in
  person's own user id>` with `{"subscription_id": "<uuid>"}` (sam-crm-be
  `userModelSettingsController.js` `setModelSetting`, `routes/orgRoutes.js:352`). Only that field
  changes (their model and effort stay); a disabled subscription, or one that is not the office's,
  is a 400 with the CRM's sentence. It is for the CRM super admin only (`lib/superAdmin.js`: the
  user ids in the CRM server's `CRM_SUPER_ADMIN_USER_IDS`); anyone else gets 403 "Only the super
  admin can assign models" and the page says so. Every state-changing `/v1/org` request needs the
  CRM's double-submit CSRF pair (`middleware/csrf.js`): `GET /v1/auth/csrf-token` → `{csrfToken}`,
  sent back as the `crm_csrf` cookie and the `x-csrf-token` header. The function takes no user id
  (the path is always the session's own), sends nothing but the subscription (no cap, no model, no
  office default), and refuses anything that is not a UUID before a request leaves.
- **The reads.** `GET /v1/org/claude-subscriptions` (super admin: id, name, the token's last four
  characters, disabled, the default weekly cap), `GET /v1/org/model-settings/me` (which one the
  person is on, and their cap and share there) and `GET /v1/org/christopher-usage?days=1` (super
  admin; only the subscriptions' own weekly readings are used, and it is asked for at most every
  5 minutes: it is heavy for the CRM). The CRM tells a person's weekly cap only on the
  subscription they are ON (their cap on the other lives in a table nothing reads back), so for
  the other one the page shows what the app last saw there (`seen` in `claude-switch.json`), else
  the subscription's default, and says which. Before a switch it warns when the cap there is lower
  than on the subscription being left.
- **What counts as a week used up** (`claude/limits.ts`). Claude's own refusal row in a chat's
  transcript: an assistant row with `isApiErrorMessage: true`, `error: "rate_limit"` and
  `quotaLimits.status: "rejected"`, whose `quotaLimits.rateLimitType` names the window:
  `five_hour` (the "session" limit: back in hours, so it NEVER switches by itself; the page
  offers "Switch now"), `seven_day` and the per-model `seven_day_opus` / `_sonnet` /
  `_overage_included` (a week: counts), `overage` and anything else (credits, a spend cap:
  ignored). The sentence is read only for a claude without `quotaLimits`, and only when it starts
  the row's text: the same words quoted in a tool result, a user message or an assistant's
  explanation (this repo has several) never count. A row older than the token in use, or than the
  chat's own start, or whose window is over, is ignored. `claude/rowwatch.ts` follows every
  running chat's transcript every 2 s for these (agent/agentic keeps no always-on observer): from
  a little before the end of the file when a chat is first seen, byte-exact lines, never throwing.
- **One sign is a suspicion** (`claude/failover.ts`). A weekly refusal from one chat makes the app
  ask the CRM at once. It switches when the CRM agrees (the credential answers 403
  `WEEKLY_CAP_REACHED` or 409 `SUBSCRIPTION_DISABLED`), or a second chat says the same, or the same
  chat is refused again a minute later. The CRM alone (the hourly check) needs the same codes
  twice, 40 s apart. While it confirms, the token stays (it is not taken out as in F-007). Other
  CRM answers (Claude turned off by the admin, none assigned) are not its business: the token
  comes out as before. The CRM's own share cap counts only usage that Christopher builds report,
  and this app reports none, so for work done in these chats the chats' own rows are the main sign.
- **Safeguards in `switchTo`** (so no caller can get around them): not when switching by itself is
  turned off (the page's toggle, kept in `claude-switch.json`); not within 24 hours of the last
  switch it made by itself; never back onto the subscription it left before that one's week is
  back (claude's reset time, else the CRM's reading, else a week); never onto one whose week reads
  100% with its end ahead, nor where the person's share is seen used up. A switch by hand is
  allowed past the last two, with a warning. If the CRM already has the person on the target
  (another PC moved them) no write is made, only the token is fetched.
- **After the move**: `GET .../mine/credential` for the new token, which goes into
  `CLAUDE_CODE_OAUTH_TOKEN` as in F-007 (a token set by something else is left alone, and said).
  If the CRM gives no token for the new one either, the move stands, the token comes out, and the
  app stops (below). Then ONLY the chats that hit the limit (rows in force) are restarted, one after
  the other, 2 s apart: an idle chat is told `/exit` and ends itself, so nothing is killed; one that
  does not end in 15 s, or is at a menu or mid-turn, is stopped the app's usual way (`restartChat`,
  `agentic/index.ts`: `stopAt`, then `openChat`, resuming its conversation on the token read
  afresh). Each is then typed "[message from the app] Your Claude subscription was switched from X
  to Y because ... Your conversation is kept. Please carry on where you left off.", once it is idle
  and 5 s after its start, and checked to have reached its transcript (typed once more if not).
  Chats that were still working keep the old token; one that hits the limit later holds an older
  token than the one in place, so it is restarted the same way and never causes a second switch.
  Hub only: a member PC's chats are restarted by its own agent.
- **Telling Lead.** Every switch, by itself or by hand, is typed into Lead's chat on floor Final as
  "[message from the app]": from, to (names and last four characters), why, which chats were
  restarted or could not be, which still run on the old token, the cap warning, and "No reply
  needed." A stop is told once, not again every hour.
- **When it stops.** The other subscription is also used up, or its token is refused, or the
  account may not switch, or there is no single other subscription: nothing more is switched, the
  page shows the plain reason (`ClaudeSwitchInfo.watch` 'stopped'), Lead is told once, and the app
  stays stopped until the week it is waiting for is back (at most 6 hours per stop). The CRM's own
  no then applies as it always did. A CRM that cannot be reached is not a stop: it tries again in
  5 minutes, up to three times. A switch by hand lifts a stop.
- **State** `<state>/agent/claude-switch.json` (mode 0600; the person's, forgotten at sign-out and
  when someone else signs in): `auto`, the log (the newest 100: when, by itself or by hand, from,
  to, why, the chats restarted, the warnings), since when the person is on their subscription, the
  last switch made by itself (for the safeguards), the caps seen. No token, cookie or password:
  names and the last four characters only, in it, in the log (`agent/logs`) and in what Lead is
  told. Anything token-shaped in a sentence is replaced by `[token]` before it is written.
- **Safe to run.** It all runs from events and timers inside the agent, where an uncaught error
  would end every chat: all of it is caught and logged. Without a CRM session, or with a token the
  app did not put in, it does nothing. `status()` never asks the CRM (the page reads it every few
  seconds); opening the panel and its Refresh do.
- **API.** `POST /agent-api/claude/switch/refresh {readings?}` and `/switch/auto {on}` →
  `ClaudeInfo`; `/switch/preview {to}` → `SwitchPreview` (the warnings, and the running chats that
  would restart, ticked by default when they hit the limit or are idle); `/switch {to, restart:
  [chat ids]}` → `{ok, message, restarted, failed}` (`ok: false` is not an HTTP error: the message
  says why). `ClaudeInfo.switch` (`shared/claude-switch.ts`): `allowed`, `note`, `choices` (name,
  last four characters, active, disabled, the week, the cap and where it comes from), `current`
  with `since` and who switched, `log`, `auto`, `watch`, `readAt`. Beside them, in the Agents
  API (same token as every agentic route): `POST /agent-api/agentic/floors/:floorId/agents/:agentId/restart`
  → `{sessionId, restarted}`, which restarts that agent's chat the way a switch does (`restartChat`:
  `/exit` first, resumed on the token in place now); `restarted: false` when its chat is not
  running on the hub. A member's call goes to the hub.
- **Not yet / not done:** writing a cap (it is not the person's own assignment: Shubham raises his
  cap on Office 1 on the CRM's Code › Usage); a member PC restarting its chats from the hub's
  switch; reading his cap on a subscription he is not on (the CRM does not give it).

## F-057: the live link (shared/live-socket.ts, link-state.ts, version-watch.ts, guard-note.ts, chat-resume.ts, src/lib/live/, agent/ws-live.ts, public/sw.js)

Built 2026-10-31 and 2026-11-01. Shubham: "we need a persistent connection between the server and my
phone so that I don't have to reload my page again and again."

- **What was broken.** Every socket of the page (the device state, the floors and live chats, a chat's
  conversation, a chat's terminal) was brought back only when its socket *closed*. A phone that locks,
  a VPN that drops or a path that goes quiet leaves the socket OPEN, without a FIN or RST, for minutes:
  the page showed old data and never came back. The wake-ups (tab shown, network back) only acted on a
  store already marked down; nothing sent a heartbeat, and the agent never dropped a client that had
  gone silent; a terminal took any drop for "the chat ended"; what changed while away (memory, tasks)
  was not asked for again; nothing told the person; after Update now the old page ran on; the service
  worker's offline page needed a tap.
- **One helper** (`shared/live-socket.ts` `openLive`, pure: the socket, timers and clock are passed
  in, so it is tested with fake ones; `src/lib/live/index.ts` binds it to the browser as
  `openChannel(label, options)`). A channel reconnects with a back-off of 250, 500, 1000, 2000, 3000
  and 5000 ms (±20 %), forever. A dead-but-open socket is found by a ping, `{"t":"ping","n":N}`, after
  20 s of silence (only while the page is shown; any message counts as life, so a busy socket is never
  pinged), 8 s to answer; the agent answers `{"t":"pong","n":N}` on every text WebSocket
  (`agent/ws-live.ts`, also a ping frame every 20 s and a drop of a client silent for 65 s). A
  handshake that hangs is given up after 10 s. When the page wakes (`visibilitychange` to visible,
  `pageshow`, `focus`, `resume`, `online`) every channel waiting reconnects at once, and every open one
  is checked with a ping that has 3.5 s to be answered; a timer that fires late says the page itself was
  paused, so it asks once more before giving up. `onOpen({again, awayMs})` is where a channel catches up;
  `retry(drop)` lets a channel end for good (a chat that ended).
- **The sign** (`shared/link-state.ts`, `src/lib/live/LinkBanner.tsx`, mounted once in `main.tsx`):
  nothing while the link is fine, and nothing for the first 2 s of trouble (1.2 s of the browser saying
  offline); then one small pill: "Connecting…" before any channel has been up, "Reconnecting…" while
  one that was up is down, "Offline" when the browser has no network. While the link is down the page asks
  the guard (`GET /guard/status`, every 2 s; absent without a guard) and says "The app is
  restarting|updating. Back in about N s." with Control and Backup page links (F-058); when the guard says
  the app is up and a channel is still waiting out its back-off, that channel tries at once.
- **A newer build** (`shared/version-watch.ts`, `src/lib/live/version.ts`): the page compares the entry
  script it was loaded with against the one in a fresh no-store `GET /` (every minute while shown, when it
  wakes, when the link is back, when a lazy chunk is gone). A different one: it reloads, but not while
  the person is typing in a field with text (it waits and asks again every 2 s), not while the page is
  hidden, and never twice in 30 s. A dev server or an error page names no entry: nothing happens. A
  text box that keeps its own draft writes it on the `sad:before-reload` event.
- **Catch-up**, per channel: the floors and chats socket gets the floors, the live chats and where they
  run from the agent on every connect, and after a reconnect every floor's memory counter is bumped (the
  Tasks tab looks again when the socket is up again); a conversation's feed gets `hello` (the end of the
  conversation) on every connect and `shared/chat-resume.ts applyHello` merges it with what is on
  screen (the older pages scrolled to stay, nothing shows twice, a replaced or cut file replaces it); a
  terminal is cleared and takes the agent's replay of the recent screen again, and only the agent's `exit`
  ends it; the Build page looks at once when the phone wakes. What was typed into a chat's box and not
  sent is also kept in the browser (`src/lib/live/drafts.ts`, 7 days, 20 000 characters), so a reload
  does not take it.
- **The old way** stays: `?live=old` (remembered in the browser as `sad-live`; `?live=new` returns) makes
  every channel run the code it had before, and shows no sign and no version watch.
- **Checked** in headless Chrome as a phone (412 × 915, touch, Android user agent) through a proxy that
  resets, stalls, goes mute or cuts, on build 2026.11.01-0116 and -0143's page against the current
  agent: a connection reset: the sockets are back in 0.4 s; a path mute for 45 s: the sign after 28.7 s,
  everything back 3.5 s after the path returned, every message of the conversation there once; a tab
  frozen for 40 s while the server gave up on its connections: back 1.2 s after thaw; a tab hidden for
  40 s: back 3.3 s after it was shown; offline: the sign after 1.3 s, gone as the network returned; a
  server restart: the sign after 4 s, back 4.6 s after the server answered (with `?live=old`: 25.7 s, no sign); a
  terminal on the Agents page: back by itself in 0.8-3.1 s and its size sent again (with `?live=old` it
  never came back); a newer build after a restart: the page took it by itself 2.7 s after the server
  answered, no reload loop, and the half-typed message was in the box afterwards. Not checked: a real phone, Tailscale and the gate.

## F-058: the guard (guard.ts, guard/supervisor.ts, hub/keeper.ts, hub/external-servers.ts, proc-tree.ts, agentic/recover.ts)

Built 2026-10-31. The app was gone from 22:02 to 22:15 that night: the phone showed a dead page, and
Control by RustDesk was out of reach too, because hbbs and hbbr were children of the agent and went with
it. Shubham: "There has to be an auto-restart for the port and the app has to not just connect to the
port. It has to connect to the device so that I can do remote control even when there is a crash."
The old way (`Start.cmd`, its restart loop) is still there and still works; the guard is the new one.

- **What it is**: `node agent/guard.ts [--role hub]`, the one process that runs apart from the app. Four
  jobs: it keeps the agent running; it serves the page on 5173 itself, so 5173 never closes; it keeps
  the hub's hbbs and hbbr running in a process of their own; it is the only one of itself.
  `Guard.cmd` runs it in a loop (started again 2 s after it dies; exit 3 "a guard runs already" and 4
  "asked to stop" end the loop, exit 5 "I updated myself" starts it again at once). Output goes to
  `<state>/guard-console.log`, the agent's to `<state>/agent-console.log`.
- **Started** by the Scheduled Task `ShubhamAgenticGuard` (`Install-Guard.cmd`, no admin): at logon
  (10 s delay) and every minute, "ignore a new start while one runs", so a guard that is killed is back
  within a minute and there is never more than one. The Startup launcher `shubham-agentic.vbs` runs
  `Guard hidden.vbs` too, and so can anyone by hand (Christopher on 4740 ran the launcher at 22:15):
  a second guard finds the lock taken and exits with code 3, harmlessly. `Install-Guard.cmd -Remove`
  takes it all out and goes back to `Start.cmd`.
- **One only**: the lock is the listening port 21228 (`SAD_GUARD_PORT`) on 127.0.0.1, exclusive. The
  port goes with the process however it dies, so there is no lock file to go stale. The same port is the
  control API: `GET /status`; `POST /stop` and `POST /restart-agent` need `x-sad-token`;
  `node agent/guard.ts status | stop | restart`.
- **The agent** (supervisor.ts): started as `node agent/main.ts --app app` with `SAD_SUPERVISED=1` (so
  Update now works), `SAD_PAGE_SERVER=guard` (it doesn't open 5173), `SAD_RUSTDESK_EXTERNAL=1` (when a
  keeper runs) and `SAD_RESUME_CHATS=1`. The policy, tested with a fake clock and fake processes:
  start when nothing runs; *take over* an agent that answers although this guard didn't start it (the
  old loop's, or one that outlived the guard before this one): it is left alone and watched, and
  found once (one PowerShell call: the process that listens on 127.0.0.1:<API port> and is node running
  main.ts) so that its PID and start time are known, it is seen to go within half a second, and it can
  be ended by that PID; start again the moment it exits (the exit wakes the loop, no waiting for the
  next look); *hung* = it runs but its `GET /agent-api/health` (2.5 s limit) fails 8 looks in a row
  after its 90 s boot grace: ended and started again; a backoff for one that dies again and again (0,
  2, 5, 10, 20, 30 s; the count starts over after a minute up); exit code 75 (Update now) runs
  `Update.cmd` (10 minute limit; git runs with no prompt for a password, no credential window and a
  stall limit of 30 s, so it gives up rather than keep the app down), then starts at once; how long
  the update took is in `guard-console.log`. If the update changed the guard's own files it exits
  with 5 and `Guard.cmd` starts the new code, leaving the agent and the keeper running (the new
  guard takes them over).
- **Update now when the exit code is not seen** (`guard/intent.ts`): an agent the guard did not start
  leaves no exit code to read, and one that hangs on its way out has to be ended. For both the
  agent's own log says what it meant: `stopping: updating to the newer build` after the process
  started (today's `agent-YYYYMMDD.log`, and yesterday's across midnight). The update step then runs
  as for code 75, and an agent that has said so and stops answering is ended after 5 looks, not 8.
  An agent that went without saying it is only started again.
- **Outliving the guard**: the agent and the keeper are started *detached*. Node ties every plain child
  to a job object that ends it when Node exits, however Node exits (measured on 1 Nov 2026: a plain
  child is gone with its parent, a detached one is not), so without this the agent and RustDesk would
  go with the guard whenever it is killed, crashes or updates itself, and "the next guard takes them
  over" would never have anything to take over. `guard.test.ts › a guard that really dies` runs the
  guard in a process of its own and ends it: the agent goes on answering, the next guard takes it over
  by its PID and starts nothing; the test fails without `detached`.
- **The page, always**: `ui-server.ts` (the same code the agent used for 5173, with a `handle` hook) runs
  in the guard: the built page, `/agent-api` and its WebSockets forwarded to the agent under the same
  rules as before (the token only for the app's own page), plus `GET /guard/status`, which the guard
  answers by itself, JSON (`GuardStatus`: the agent's and keeper's state, restarts, `etaSeconds`, and
  `control`: the RustDesk link and the backup page's port). While the agent is down `/agent-api` is
  502 in its error shape and WebSockets fail, but the page loads and its sign (`src/lib/live/
  LinkBanner.tsx`, `shared/guard-note.ts`) says "The app is restarting. Back in about N s." with Control
  (`rustdesk://connection/new/<id>`) and Backup page (Christopher, port 4740) links. A port held by an
  agent started the old way is tried again every second; the guard takes it when that agent ends.
- **The agent exits at once** (`agent/hard-exit.ts`, used at the end of `shutdown` in `main.ts`):
  `process.exit()` first waits for the worker threads, and a worker sitting in a call into Windows
  that does not return (UI Automation asking an app that hangs, the key grab) holds the exit for as
  long as the call lasts, and then the process dies with 0xC0000409 instead of the exit code. Measured
  on 1 Nov 2026: a worker in `kernel32!Sleep(10 s)` and `process.exit(75)` at 0.3 s: the process ended
  after 10.5 s with code 3221226505; `TerminateProcess` on itself: after 0.4 s with code 75. That is
  what held Update now on 31 Oct at 23:37: the agent logged "stopped" and never exited, so `Start.cmd`,
  waiting for code 75, never ran `Update.cmd` and nothing started the app again until somebody did at
  23:53 (15 minutes; `Update.cmd` itself takes about 2 s). `agent/exit-watchdog.ts` stays behind it as
  a backstop: a hidden PowerShell that ends the agent with the same code 20 s after a stop began.
- **RustDesk apart from the agent** (`hub/keeper.ts`, the hub only): `startServers` (untouched) runs in
  the keeper, a detached child of the guard. It writes `<state>/rustdesk-server/keeper-state.json` every 2 s and
  at each change; the agent (`hub/external-servers.ts`, `SAD_RUSTDESK_EXTERNAL=1`) reads it once a
  second, so Devices and pairing still know the servers' state and key, and starts and stops nothing.
  A file older than 8 s, or whose process is gone, is a keeper that isn't there; the guard starts it
  again. An agent the guard only adopted runs its own servers, so the keeper starts once the agent is
  the guard's own. Agent killed, crashed, hung or updated: hbbs and hbbr go on.
- **Nothing is ended by port, name or `taskkill /t`** (`proc-tree.ts`): Windows keeps the parent PID a
  process was started with, never clears it, and reuses PIDs, so `taskkill /t` can walk into processes
  that merely got an old parent's PID. A tree is found from the process table with start times: a child
  counts only if it started at or after its parent; the leaves are ended first, each by its exact PID,
  and only if its start time still matches. The guard, `agentic/chats.ts` (a chat's tree, on Update now
  too) and `agentic/librarian.ts` do it this way.
- **Chats come back** (`agentic/recover.ts`, `resumeChat` in `agentic/index.ts`): the agent writes
  `<state>/agentic/open-chats.json` (v 1: sessionId, floorId, agentId, state) 400 ms after the open
  chats change, atomically; it stays off until the previous list has been used, and is frozen when the
  app stops, so closing the chats on the way out doesn't forget them. 4 s after the guard started the
  agent (`SAD_RESUME_CHATS=1`; members and Dev never), each chat on the list is opened again with its
  conversation resumed, 2 s apart, and one that was working or asking is typed
  "The app restarted and reopened this chat. Carry on from where you were." when it is ready. A chat
  that was stopped on purpose left the list before the app did and stays closed.
- **Tests**: `guard/supervisor.test.ts` (policy, with processes it did not start), `guard/intent.test.ts`
  (what the log says), `guard/guard.test.ts` (the real guard with fake children: restart on exit, hung,
  taking over, the page up while the agent is down, a second guard, update and self-update, stop; and
  a guard in a process of its own that dies), `hard-exit.test.ts` (ends at once with its code while a
  worker is stuck in a native call), `hub/keeper.test.ts`, `proc-tree.test.ts` (including a reused
  parent PID), `agentic/recovery.test.ts`, `shared/guard-note.test.ts` (the page's reading of
  `/guard/status`). The tests ask the OS for free ports; fixed ones clashed when two runs overlapped.
- **Run for real, on a copy** (a copy of the build in a scratch folder on ports 5391 for the page, 21579
  guard, 21580-21582 agent, 21586/21587 hbbs/hbbr, its own state folder, a fake `claude`; started by a
  Scheduled Task of its own, the real chain task, wscript, `Guard.cmd`, guard, agent, keeper):
  the agent killed outright: its API answered again through the page port in 0.46 s, the page port was
  never closed, hbbs and hbbr never went down and kept their PIDs, both chats were back in 6.6 s and
  the one that had been working was told to carry on. The other kills and the live app: see F-058 in
  features.html.

## F-075: the chat host (chathost/, agentic/chats.ts, build.ts)

Built 2026-11-01, **off by default**. Shubham: "when I press the update button there has to be an intermediate
layer where all the chats shift and continue to work while the application is updating, so my chats never stop
and I can update any time."

- **Why a process of its own.** A ConPTY child dies with the process that created its pseudo-console
  (measured on 1 Nov 2026: killed within a second of its creator being killed, detached or not), so while the
  chats' terminals lived in the agent, every update, crash or kill took every chat with it, and nothing could
  be done about it from inside the agent. The terminals (node-pty), the claude processes in them and a 256 KB
  ring of each one's output now live in the **chat host**, which the agent talks to. The agent can stop, update
  and start again; the chats go on.
- **The host** (`chathost/host.ts`, run by `main.ts`; the wire protocol is `protocol.ts`): one per PC, started
  detached (measured: a detached child outlives its Scheduled Task, its parent being killed and
  `Stop-ScheduledTask`), from a copy of its own files in `<state>/chathost/host-p<protocol>-v<version>-<hash>/`
  (`install.ts`: the host's five files and the win32-x64 node-pty, ~15 MB), because a process that has loaded
  node-pty's native files makes `npm ci` after an update fail (EPERM on node_modules, measured) and a
  `git pull` could swap its files under it. It listens on 127.0.0.1:21229 (`SAD_CHAT_HOST_PORT`), takes the
  agent's own API token, has ONE controller (a new one takes over; the old one is told and dropped), and writes
  `<state>/chathost/host.json` (pid, port, version, protocol, folder). It knows nothing of claude, floors or keys: what
  the agent wants kept with a chat (`meta`: its key, floor, agent, folder, start time) is stored and returned
  whole. It never parses output. Messages (JSON lines): `hello`, `spawn`, `write`, `resize`, `kill` (the
  terminal and its processes by exact PID and start time, `proc-tree.ts`), `list`, `attach` (the replay of the ring,
  then the stream: nothing is missed or doubled), `forget`, `ping`, `shutdown`. An ended chat is remembered
  10 minutes for an agent that was away. The first answer (`hello-ok`: protocol, version, pid) never changes shape.
- **The agent's side** (`client.ts`, `link.ts`, `ensure.ts`): at its start the agent (`ensureChatHost`) uses the host that
  runs, or starts one, and `link.adopt(pool)` lists the chats and takes each over (`ChatPool.adopt`: its terminal,
  the host's replay to read what it is doing, the key it was started with, its start time). The pool's terminals
  are the host's (`spawn` of the link); `keepOnClose`: stopping the agent lets go and ends nothing (every other
  way of stopping a chat still ends it, in the host). The chats that were open are also in the open-chats list
  (F-058), which brings back any that did not survive. If the host cannot be had (no node-pty, not answering,
  another protocol, another token) the agent logs it and the chats run in its own process, as before. If the host
  is lost while the agent runs (it died), the open chats are noted, a host is started again, and they are reopened
  resumed, the working ones told to carry on.
- **Update now**: the agent exits (code 75) without ending its chats; the guard (or `Start.cmd`) runs `Update.cmd`; the new
  agent finds the host and takes the chats over: same claude processes, same keys, their screens, and what they printed
  meanwhile. The MCP shim waits up to 90 s for an agent that is away (only a refused connection is tried again, never
  one that may have arrived: `mcp-retry.ts`); the memory hook already gives up quietly.
- **When the host itself changes** (the newer build's `RELEASE.json` has `chatHost: {protocol, version}`, written
  by Publish; none at all counts as a change): Update waits for the chats to be idle (running or asking = busy) for 10
  minutes, looking every 5 s, and goes by itself the moment none is; after 10 minutes the Build info says `ask`
  and the page offers to restart the chats and update (`POST /build/update {force:true}`; `POST /build/update-cancel`
  forgets it). Going: the open chats are written down, the host ends them and stops, the update runs, the new agent
  starts a new host from the new files and reopens the chats resumed (today's restart + resume, which stays as the fallback).
  The same version of the host in the newer build: the host and its chats are not touched.
- **The switch**: `SAD_CHAT_HOST=on|off` in the environment (off wins), else the file `<state>/agent/chat-host.on` (create
  it, restart: on; delete it: off). Off is the default; the first update with it on restarts and resumes the chats once
  (the ones running today cannot be moved: nothing can take over a pseudo-console).
- **Not covered**: a crash of the host itself ends every chat (they are reopened resumed); a reboot or logoff ends them;
  typing during the few seconds the agent is away; a paste in progress when the agent goes is lost, never half sent.
- **Tests**: `chathost/chathost.test.ts` (host and client over real loopback with a fake terminal), `update.test.ts` (two
  agents over one host: same process, key, screen, output while away, typing; the list; a lost host replaced),
  `ensure.test.ts` (the self-copy, finding or starting, the switch), `agentic/chats.test.ts` (adopt, keepOnClose),
  `agentic/mcp-retry.test.ts`, `build.test.ts` (the host-change rule). **Run for real**, on the spare-port copy (page 5391,
  host 21584, own state folder, real node-pty, a fake claude printing a tick every 500 ms while it works, started by a
  Scheduled Task of its own, through the guard): Update now with a chat mid-answer: the API was back in 1.0 to 1.4 s,
  both chats in the new agent in 1.0 to 1.4 s, the same host and the same claude processes (no new start), the working
  chat still running, not told anything, the longest hole in its output 509 to 514 ms (one tick); the agent killed: back in
  1.5 s, same host, same claude, longest hole 524 ms; the host killed: a new host after 4.1 s, both chats reopened resumed
  after 10.3 s, the working one told to carry on, the idle one not; a newer build with another host: Update waited
  with the chats busy (agent and host untouched for the 8 s looked at), went when they were idle, host replaced, chats
  reopened resumed.

## F-083: the hub watchdog and the idle reaper (agentic/watchdog.ts, agentic/chats.ts, agentic/chat-log.ts, agentic/heartbeat.ts)

What went wrong on the night of 2 Nov 2026 (agent-console.log): the idle reaper ended each chat 4 h after anyone last had it open, even chats working through messages (it asked only "is anyone looking, is it 'running' this second"); it ended Mobile's chat in the middle of its tests (the chat sat idle at its prompt while the tests ran in a background shell); the Assistant's in-chat heartbeat died with its chat; three chats reopened at 03:08 sat at "Teach auto mode about your environment?" until 07:06; and nobody knew Mobile was down.

**The reaper (chats.ts).** A chat is idle only when ALL of these hold for `IDLE_REAP_MS` (4 h): nobody has it open, it is not running, no question is up, no message was typed or pasted (`lastActive`), no turn started or ended and nothing was printed while it worked, no background work shows on its status line (`backgroundWork(screen)`: "1 shell", "2 local agents", a workflow bar `▱▱▱▱`, "Waiting for 1 dynamic workflow to finish"; read off the rows under the input box's bottom rule, so the same words in the conversation do not count; the real footer, read 2 Nov: `⏵⏵ auto mode on · 1 shell · esc to interrupt · ↓ to manage`), and `keep(sessionId)` is false: an open order from the Assistant, or unfinished work by heartbeat.ts's rule (`workOf` in index.ts). When `keep` throws, the chat is kept. `idleReapMs` / `reapEveryMs` are options for tests. `activity(sid)` gives `{state, startedAt, lastOutputAt, lastActiveAt, background}`; `press(sid, keys)` writes keys without counting as a person looking.

**The watchdog (watchdog.ts).** Not a timer of its own and not a chat: each beat of the heartbeat (every 5 min, the first 2 min after start) calls `watch()`, so it runs in the agent whether or not the Assistant's chat is alive, and the overlay's heart card (last beat, next beat, what it found) shows it. `GET /agent-api/agentic/watchdog` and the tool `watchdog_status` give the same with `downNow` and a one-line `summary`. When it is on, the heartbeat no longer starts stopped chats itself (it still nudges idle chats with unfinished work and reports questions).
- *Down and should not be.* Every agent on every floor with a session, not running anywhere, not stopped by Shubham (heartbeat `isStopped`, or a last stop with cause `stopped`), whose last stop cause is one of crashed / exited / ended / agent-stop / idle-reaper or none logged, AND that has an open order or unfinished work. A chat the reaper ended for true idleness stays ended (otherwise reaper and watchdog would take turns for ever); the reaper itself now keeps chats with work. Not while F-058 recovery is still reopening (`recoveryBusy`: until `mine.arm()`, at most 10 min). Not when its home PC is offline (F-064: `openChat` answers 424; reported, never started elsewhere). Restart = `openChat` (its home PC, resumed from the conversation), then the nudge: *"Your chat was stopped at 04:44 (idle-reaper). It had work unfinished (...). The app started it again. Any background job you had running (a shell, a workflow) was lost: check its state, then carry on..."* (starts with `[heartbeat `, so the heartbeat never counts it as an unanswered message). Limits: ≤3 restarts per chat per hour, waits 5 / 15 / 30 min after the 1st / 2nd / 3rd, ≤3 chats per beat, and only while free commit (Win32_OperatingSystem.FreeVirtualMemory, read ≤ once a minute) ≥ 3.5 GB, else "held: memory" (unreadable counts as low). Kept in `watchdog.json`, so they survive an app restart.
- *Menus.* A chat with a menu on its live screen (`chats.asking`) is never answered, with ONE exception, matched exactly by `classifyMenu`: the title "Teach auto mode about your environment?" AND "1. Yes" / "2. Not now" / "3. Don't show again" AND a footer "Enter to confirm|select … Esc to cancel", from the last such title down, no input box below it. After it has stood 2 min and nobody has the chat open: the single key `3` (confirms at once; never Enter, never Yes), 2 s later `asking` is read again, and if the menu is still up the chat is ended and opened again from its conversation, pressing nothing. The setup screen "Yes" opens (same title, "Enter to continue" / "How you use Claude here") is never sent any key: the chat is restarted the same way. Any other prompt: the heartbeat reports every chat's after 10 min; the watchdog reports the Assistant's own (which the heartbeat skips).
- *Silent.* "Running" with no output for 30 min and no background work: reported ("printed nothing for N min"), never touched.
- *Telling Shubham.* A chat down or held more than 10 min is a `down` finding; the heartbeat wakes the Assistant for it, which gives him one line in the overlay. The phone push (`voice.beat`) for menu / down / silent findings is skipped 23:00–07:00; they are in chat-events.jsonl and so in the morning summary.
- *The log.* chat-events.jsonl: `start` causes now include `watchdog`; a new event `watch` has `cause` (watchdog-restart, memory, limit, home-offline, restart-failed, menu, silent), `what` and `did`; the morning summary prints one line per `watch` event.
- *Switches.* `SAD_WATCHDOG=0` turns the watchdog off (the heartbeat then starts stopped chats itself, as before); `SAD_HEARTBEAT=0` still turns the whole beat off.

Tests: `agentic/idle-reaper.test.ts`, `agentic/watchdog.test.ts` (every rule, and the night of 2 Nov replayed), `agentic/heartbeat-api.test.ts` (through the API), `agentic/chat-log.test.ts`.

## F-079: WhatsApp, his own, linked by his QR scan (whatsapp/, shared/whatsapp.ts, src/whatsapp/)

Shubham's own WhatsApp, linked once to the hub as a device (WhatsApp › Linked devices › Link a device, the WhatsApp Web way), then read and written from the WhatsApp page, and read and drafted by the overlay Assistant. The route is unofficial: whatsapp-web.js drives WhatsApp Web in Chrome, as techserverbz/whatsapp-backend does (its engine is ported here). That is against WhatsApp's terms; bans mostly hit bulk or automated sending, so here every send is his own signed tap. The official Business Cloud API was not taken: it needs a separate number and can't read his chats.

- **Where it runs.** On the hub only, and only with the Agents section (its approval devices sign the sends): `main.ts` makes it with `createWhatsApp({dir: <state>\whatsapp, human: agentic.humanProof})`, mounts it at `/agent-api/whatsapp/`, and closes it on stop. A separate process, `whatsapp/worker.ts`, is forked **detached** (so it is not in the agent's kill-on-exit job: if the agent ends first, the worker still closes Chrome itself on IPC `disconnect`), with `execArgv: []` and only Windows' own variables plus `SAD_WA_*` (no token of the app's). It speaks JSON over Node's IPC channel only (`protocol.ts`); no port. Chrome is the PC's own (`chrome.ts`: Chrome, else Edge), headless, its sandbox on, `--disable-gpu --mute-audio`, launched by puppeteer inside the worker (so in the worker's job: it can't outlive it).
- **The program.** whatsapp-web.js pinned to commit 064a3d5 (2026-09-28: main's head on 2 Nov, 8 fixes past npm's 1.34.7, and the commit whatsapp-backend runs), with qrcode 1.5.4. Not one of the app's packages: `agent/whatsapp/lib/package.json` and its lockfile (derived from whatsapp-backend's, 141 packages) are installed by `setup.ts` into `<state>\whatsapp\lib` with `npm ci --omit=dev --omit=optional --ignore-scripts` (no install scripts run; puppeteer downloads no Chrome), started from the page's Set up. A `.installed` mark holds the lockfile's hash; a new lockfile asks for the setup again. `PUPPETEER_SKIP_DOWNLOAD` is set as well.
- **The engine (`engine.ts`)**, from whatsapp-backend's webjs engine: `LocalAuth` in `<state>\whatsapp\auth\session-main`; the WhatsApp Web build never pinned (`webVersionCache: {type: 'none'}`: WhatsApp unlinks old builds, and nothing is cached on disk); only the profile's `Service Worker` folder cleared before a launch; up to 4 launches when WhatsApp Web fails to load; after `authenticated`, `getState()` polled every 3 s (today's WhatsApp often never fires `ready`), reopened twice at most after 90 s without CONNECTED; `destroy()` always (a killed Chrome can corrupt the LevelDB login); ids by `_serialized` or `$1` (whatsapp-web.js #201832). New: a generation number, so a closed client's late events change nothing. The linked device is named "Shubham Agentic" (`deviceName`). Reading never marks a chat read; status updates and channels are left out of the chats; WhatsApp's own notices out of the messages.
- **On demand (`index.ts`).** It opens when used (the page, the Assistant's tools, a send) and closes `WA_IDLE_MS` (10 min) after the last use while no WhatsApp page is open (the page's live socket counts as use); `PATCH /settings {alwaysOn}` keeps it open (and opens it at the agent's start when linked). The Assistant's reads never open it for a QR: not linked = refused at once.
- **Linked or not.** `settings.json` holds `linked` (true once connected; false when WhatsApp shows a QR, lets the device go (`LOGOUT`) or he unlinks), `alwaysOn` and his WhatsApp name. Chrome makes the profile folder at once, so the folder alone can't say.
- **Sending is his.** `POST /send {chatId, text, draft?, sig}`: first his approval device's signature (`humanProof('wa-send', [chatId, sha256(text), draft ?? ''], sig)`, F-076's store, one-time nonce, 60 s window), then the rest. The page's Send buttons are `data-human-only` and act only on `isTrusted` events. His own sends: at most 10 a minute (a stuck button).
- **The Assistant (`tools.ts`, agentic/index.ts).** `wa_status`, `wa_chats` (`query`, ≤30), `wa_read` (≤20 messages) and `wa_prepare_send`, for the overlay Assistant only (403 for any other agent; served to every chat like `prepare_send`). A draft (`drafts.ts`): one person (a new draft for the same chat replaces the old), never a group, only a chat he already has, ≤5 waiting, each 15 min, and ≤20 of the Assistant's drafts sent in any hour (counted at send). He can change the words before he taps Send.
- **The login is his.** `<state>\whatsapp\auth` is locked to his Windows account (`icacls /inheritance:r /grant:r DOMAIN\USER:(OI)(CI)F`) before Chrome writes into it. Unlink (`POST /unlink`): WhatsApp is told (from an open, linked session) and the profile deleted (retried while Chrome lets go), else it says to log "Shubham Agentic" out on the phone. Nothing about a chat, a number or a message is logged: the worker's lines go through `clean()` twice (ids, numbers, data URLs removed), and the hub logs states and counts only.
- **Exact PIDs only.** `host.ts` notes the worker's and Chrome's PIDs with their start times in `running.json`. Ending is gentle first (the worker closes Chrome and exits), then, past 25 s, `killTree(pid, {since})` (proc-tree.ts: by start time, never `/t`, never by name). A worker that dies leaves its Chrome: that one PID tree is ended. At start, `sweep()` ends what the file names if each is still the same program (name and start time), and nothing else.

Tests: `whatsapp/engine.test.ts` (24: the mapping, linking with and without `ready`, retries, recycling, stop, late events, logout, LOGOUT, paging, pairing codes), `host.test.ts` (9: the real worker on `client.fake.ts`: open, link, read, send, quit; one worker however many ask; an early question; a dying worker's Chrome ended by its PID; the crash sweep; the environment), `drafts.test.ts` (7), `index.test.ts` (18: through the API mount with the real worker: setup, linking, the pairing code, the Assistant refused before linking, reads, drafts, signatures, the burst limit, idle close, a page keeping it open, stay open, unlink, a log that names nobody), `setup.test.ts` (3), and agentic `index.test.ts` (the tool list).

## F-085: the PC's side of Chris's Update button

(mobile/docs/HUB-PROTOCOL.md §12, §12.1 H1.) Files: `agent/agentic/app-update.ts` (+ test), routes and the event in `voice.ts`, the tool in
`tools.ts` / `index.ts`, one allow-list in `agent/api.ts`.

- **Offer.** `C:\sac\out\offer.json` (`SAD_APP_OFFER` overrides; written by `mobile/scripts/offer.mjs`): `{apk, sha256, versionCode, versionName, bytes, notes?, offeredAt}`.
  `apk` must be a plain `.apk` file name in the same folder. It is offered only while the file exists, has the size in `bytes` and its sha256
  equals `sha256` (hashed once, cached by size and mtime). Otherwise `GET /voice/app` answers `{offered:null}` and the APK route 404s.
- **Routes** (device key only; any `Origin` is refused): `GET /agent-api/voice/app` → `{offered:{versionCode, versionName, sha256, bytes, notes?, offeredAt}|null}`
  (the file name is not given out); `GET|HEAD /agent-api/voice/app/apk` → the file, `application/vnd.android.package-archive`, `Content-Length`,
  `Accept-Ranges: bytes`, one `Range` (206, or 416 with `Content-Range: bytes */size`). The log has the version and the bytes only.
- **Streamed route on a device key.** `agent/api.ts` has `KEY_STREAM_PATHS`, an allow-list with exactly one path (`/agent-api/voice/app/apk`). A mount's
  `keyStream` is honoured only there; the handler checks the key (missing, wrong or revoked → 401). Every other `raw` route keeps the app token.
- **Event and tool.** `{t:'update', versionCode}` on `GET /voice/events`. Tool `phone_update {}` (the overlay assistant and the Mobile chat): checks the offer,
  pushes the event, answers what it did (version, size, phones asked) or why nothing was offered. The hub does not know which version a phone runs,
  so it does not compare; the phone acts only when its setting is on, the build is newer than its own, and it is unlocked.

## Firewall script (scripts/firewall-hub.ps1)

- Admin required: it checks and says so if it is not elevated.
- Mode `-Scope LocalSubnet` (phase 1, the default) or `-Scope Any` (phase 2).
- Inbound allow rules named `SAD hbbs TCP`, `SAD hbbs UDP` and `SAD hbbr TCP`, each
  program-scoped to the exe in the canonical `%LOCALAPPDATA%\shubham-agentic\rustdesk-server\`
  (`-BinDir` to change), on ports 21216 TCP and UDP and 21217 TCP (`-HbbsPort`,
  `-HbbrPort`), profiles Private and Public, remote address per the mode, group
  `shubham-agentic`. Re-running it replaces the rules; `-Remove` deletes them.
- Never touch other rules.
- **Block rules from the prompt.** The first listen of hbbs.exe/hbbr.exe makes Windows
  create inbound **Block** rules named `hbbs.exe` and `hbbr.exe` (TCP and UDP, Private and
  Public) while its prompt waits for an admin; seen on this PC on 2026-10-29. Block beats
  allow, so the script warns about every enabled inbound block rule for our two exes and
  prints the `Remove-NetFirewallRule -Name` command; it does not delete them itself. Traffic
  from this PC to itself is not filtered, so the e2e test on one PC passes regardless.
- **Wider allow rules from the prompt (review, 2026-10-29).** Once someone allows the
  program at that prompt, the same rules are enabled **Allow** rules: any remote address,
  all local ports, TCP and UDP, Private and Public. That is the state on this PC now (read
  on 2026-10-29: `hbbs.exe` and `hbbr.exe`, TCP and UDP, Allow, Any, all ports), so hbbs's
  21215/21216/21218 and hbbr's 21217/21219 are open to every network this PC joins, and
  the SAD rules' LocalSubnet scope would not be what applies. The script reports every
  enabled inbound allow rule for the two exes that is not its own (group `shubham-agentic`,
  names `SAD …`) and is wider than asked (another remote address than LocalSubnet when that
  is the scope, more ports, or more protocols), with its `Remove-NetFirewallRule -Name`
  command, and ends with "Done, but not in effect yet: N wider allow rule(s) …" instead of
  "Done". It deletes none of them. node.exe has the same kind of rules here ("Node.js
  JavaScript Runtime", Allow, Any, all ports, TCP and UDP), which also expose the hub's TLS
  listener (21220) and discovery (UDP 21222) beyond the LAN; the README says so.

## Tests that must pass

- **Unit:** codec (37 checks), messages round trip including an unknown union field,
  der/identity (X509Certificate parses and verifies; id format), tls (handshake on
  `net.createServer`, pin accept and reject, equal SAS on both ends), mux (control
  messages, two streams in parallel, close, ping RTT), pairing (good code, bad code with
  attempts, expiry, SAS shown on both sides, approve stores the device, reject), API
  (token required, WS handshake, state push).
  Also: devices (the allowlist needs id and key, a damaged file is an error), connect (every
  path against stand-in hbbs/hbbr that route like 1.1.16: direct, refusal, a wrong hub key,
  hub-lan, relay only, PunchHole, OFFLINE, LICENSE_MISMATCH, refusal over the relay, nothing
  answering), links (reconnect, Check again, back from a relay to direct with the idle relay
  closed, refusal backoff, the hub's check, the hello refreshing the hub's details, status),
  discovery, and rustdesk (tunnels, splice, the stream handler).
  After the review (2026-10-29), also: pairing (the number shown only after the reveal and
  mixing in the hub's nonce, a nonce that doesn't match its commitment, a request without
  one, a rogue hub that approves on its own is not pinned, a picked hub's ID refuses another
  key before the code is sent, approve-then-confirm and confirm-then-approve, the member
  saying the numbers differ, one PC per code, every request costing a try, unknown sessions
  one per IP), tls (the number depends on both nonces; handshakes per IP), links (a
  devices.json that can't be written, on both sides; a member whose hub moved finds it
  through discovery), connect (an impostor heard on the LAN is refused by the pin),
  discovery (a second address for one ID is a conflict), rustdesk (two opens at once share
  one listener), devices (the rename retry; no temp file left), hbbs (the per-requester push
  budget and the trusted slot), api (`/join/confirm`, `hubId`, a foreign Origin refused on
  HTTP and WebSocket) and local-host (a DNS-rebound page never gets the token).
  With Tailscale (2026-10-29), also: net (this PC's Tailscale address from Tailscale's own
  adapter only; 100.64.0.0/10), devices (the hub's `tailnet` checked, and absent in older
  bundles), config (`route`, and an old `forceRelay` read as `relay`), api (`route`
  validated), connect (Tailscale only, seen as Tailscale at both ends with hbbs untouched;
  Auto takes the same network first and Tailscale before hbbs; either end without Tailscale;
  the RustDesk way never tries it; a removed member refused over it), links (off Tailscale
  back to direct on Auto, and not on Tailscale only).
  With the app's own screen (F-006, 2026-10-30), also: `agent/screen/host.test.ts` (the real
  viewer client against the host: login, the failure limits, ask-to-accept, PeerInfo, H.264 and
  VP9, mouse, wheel, modifiers, scan codes and lock keys, Ctrl+Alt+Del, letting go, view-only,
  clipboard, pointer shapes, the lock screen, the round trip), `media.test.ts` (FLV and IVF
  framing, the command lines, a real encode of the test pattern when ffmpeg.exe is set up),
  `cursor.test.ts` (shapes, the password store), config (`ffmpegBin`, `screenPassword`), api
  (the new routes in its fixture).
  With Claude on this PC (F-007, 2026-10-30), also: `agent/claude/crm.test.ts` (sign-in by
  username and by email, the cookie kept without its attributes, a wrong password, no CRM
  answering, the credential with its cookie and build header, every "none" the CRM gives, an
  ended session, a malformed answer and a CRM error), `index.test.ts` (against a stand-in CRM,
  `agent/test/fake-crm.ts`, over HTTP: sign-in puts the token in and writes neither it nor the
  password anywhere, a wrong password keeps nothing, none takes the app's token out, a new token
  replaces the old, someone else's is left alone until Replace, sign-out, a restart, the 7-day
  end and a 401, the CRM not answering, another person signing in, no user environment),
  `userenv.test.ts` (the real Windows calls on a scratch key under HKCU\Software, removed
  after), config (`crmSession`, `claudeSubscription`), api (the three routes and their checks).
  With Claude subscription failover (2026-10-31), also: `agent/claude/limits.test.ts` (claude's own
  refusal row as 2.1.260-2.1.316 write it, and everything that must not count), `choices.test.ts`
  (the picker's rows, the cap on each subscription, the warnings before a switch), `crm.test.ts`
  (the CSRF-checked write, its path and body, the refusals), `switch.test.ts` (the switch against
  the fake office: the write, the token, the rules against flipping back, who may, what is
  remembered and forgotten), `failover.test.ts` (when it switches and when it must not, the stops,
  the chats, by hand), `rowwatch.test.ts` (real files that grow), `bridge.test.ts`,
  `together.test.ts` (all of it wired as main.ts wires it, with the real chat pool and a fake pty: a
  refusal row appears, one write to the fake CRM, the chat comes back on the new token with its
  conversation and is told to carry on, Lead is told, nobody else is touched, nothing is killed),
  `agent/agentic/restart.test.ts` (/exit first, the usual stop only if needed; the restart route
  and its token), config
  (`claudeSwitch`), api (the four routes and their checks).
  With Remember me (F-008, 2026-10-30), also: `agent/saved-passwords.test.ts` (the answer is the
  viewer's own hash for any challenge and the host's check; per PC and way; a new salt forgets
  it; forgetting; a restart; nothing but H1 on disk; damaged files), the viewer client (a saved
  H1 logs in as the password does), api (the three routes and their checks), config
  (`savedPasswords`), host (the display woken before each capture, the retries spaced out).
  With a PC asleep (2026-10-30), also: `agent/screen/power.test.ts` (mains holds the system
  only, a session the display too, battery nothing unless controlled, the switch off and on,
  an unknown source as mains, closing lets go, the first hold told to nobody; the power button
  and lid set while plugged in and put back when turned off, a change someone made since kept,
  already so, started turned off, Windows refusing, each plan its own, a damaged file, a change
  in Windows reaching the page), host (a display Windows turned off: the connection stays, the
  viewer is told once, and it is woken and tried until the picture comes), config
  (`powerButtons`) and api (`stayReachable`).
  With privacy mode (F-012, 2026-10-30), also: host (offered in PeerInfo; on and off as the
  viewer asks, each answered; the connection ending turns it off; another viewer turned away
  while it is on, and welcome after; Windows refusing; a PC that can't, never offered), the
  viewer client (asked with the first way listed; each answer read as RustDesk reads it;
  NotSupported stops offering it; never asked where not offered; someone else's ends the
  connection, at login or later).
  With the shortcuts (F-013, 2026-10-30), also: `agent/screen/grab-keys.test.ts` (scan codes to
  KeyboardEvent.code; Alt+Tab and the Windows key taken with the modifiers held; a held key
  repeats; Caps Lock, Num Lock and injected input left alone, a key down before the grab going up
  here; another window in front: lost once, taken keys still going up; and the real hook on its
  own thread with keys the test injects, nothing taken after letting go), api (`/keys`:
  grabbing then each key, closing gives them back; the grab ending, one that can't start, and
  none here).
  With the phone (F-014, F-017, 2026-10-30), also: client (text as one `seq`, none while the
  keyboard is off; `sad.text-focus` asked and its answers heard, other plugins left alone), host
  (watched only once asked, each change sent, a click looks again, stopped by `watch: false` and
  by the session ending), and `agent/screen/text-focus.test.ts` (the editable rule, and the real
  UI Automation worker on this PC answering once, a second watcher hearing it at once).
  With the Agentic Workflow section (F-018, 2026-10-31), also, with a pretend node-pty
  (`agentic/chats.fake.ts`; its pids are never tree-killed): floors (the Lead seated, unique
  names, 24 at most, the page's list keeping the bindings, the boss removed with a successor or to an empty floor, loops repaired, a
  corrupt file set aside), memory (save, search, edit, delete, a torn line skipped), claude's
  questions in `~/.claude.json` (absent keys only, the rest of the file kept, an unreadable one
  left alone), chats (how claude is started and its environment, `--resume`, `claude.cmd`; the
  trust menu answered yes whichever option it starts on, the resume gate with 2; working, asking,
  idle, a split marker; replay then stream; paste then Enter; typing once the prompt is up; ending),
  and through the real API: the token on the page's routes, a chat key and no page on the tools'
  route; a chat started from the floor's brief once, then resumed from its transcript; folders
  checked; an agent taken off or a floor deleted ending its chats; memory from the page; the real
  MCP shim with a chat's key (list_chats, floor_roster, read_chat, send_to_chat with its prefix and
  limits, broadcast, memory shared on the floor and announced, agent_hire for the boss only, a
  stopped chat's key refused); the terminal socket (replay, keys, size, exit, a stopped chat) and
  the events socket (token, first floors then live).
  With the memory layer (F-051, 2026-10-31), also: `agentic/memory-layer.test.ts` (search: code
  names whole and in parts, BM25 in and out, a hit's share of the query, the fusion going by
  words for an exact name and by meaning for a sentence, sections and snippets; the wiki: paths
  kept inside it and out of inbox/ and .git/, front matter, made with its rules, the index by
  folder, Shubham's SCHEMA.md kept; turns: said and answered, tool results, commands, claude's
  notices and another chat's messages told apart, read as the file grows, a half line waiting,
  a copied conversation not kept twice; the librarian: the inbox's marks, material taken to its
  size with turns in order, claude -p's flags and environment, its JSON answer; the layer, with
  a pretend embedder and a pretend claude: notes, wiki and turns searched together, recall (not
  the chat's own, not again straight after, nothing for commands, other chats or a word or two,
  off when switched off), the brief, memory_read, a compile (inbox, the run with its cost, the
  index and the log, nothing new after, an edited note new again), a failed run, the past only
  when asked, the settings, a note searched at once; the model: fetched once with its sha256
  checked, a bad one thrown away; the hook: in and out, quiet on errors, run as a process).
  `index.test.ts`: memory_read in the tools' list; memory_search still answers `entries`.
- **E2E (`npm run test:e2e`), on this PC:**
  - Setup: a temp `SAD_HOME` each for a hub and a member, and alternate ports (hbbs 21316,
    hbbr 21317, peer 21320, api 21321/21331, discovery 21322, rustdesk-direct =
    a local TCP echo server).
  - The hub supervises the real hbbs/hbbr from the canonical exe path with a temp cwd.
  - Test steps:
    1. pair the member through the API calls, approving on the hub;
    2. connect: `lan-direct`;
    3. set How to connect to Relay only and reconnect: `relay-lan` through hbbr, with `SAD1`
       seen;
    4. with direct probing disabled by a test-only env var `SAD_TEST_SKIP_DIRECT=1`: the
       `hub-lan` path through FetchLocalAddr;
    5. open a `rustdesk` tunnel stream: bytes echo through the relay path;
    6. remove the member: its next connect is refused;
    7. when this PC runs Tailscale: Tailscale only links through the hub's Tailscale
       listener (the member dials this PC's own Tailscale address), `tailscale` at both ends.
       It runs between 5 and 4; step 4 runs on the RustDesk way, as Auto would take Tailscale
       before hbbs.
    8. (F-006) still on the relay: a control password set on the hub through the API, then
       the viewer's protocol client through the member's `?via=app` pipe logs in to the hub's
       own screen and gets a keyframe and ten frames; the hub lists the session, and ends it
       when the client closes. Both agents run with `SAD_SCREEN_PATTERN=1`. Skipped when
       ffmpeg.exe isn't set up. Runs after 5: order 1, 2, 3, 5, 8, 7, 4, 6. Then (F-008) the
       member saves H1 and a second connection logs in with the member's answer alone; after
       the hub's password changes, a third finds the saved one forgotten.
    9. (2026-10-30) on its own, after the others: a third agent with the real Windows calls
       (`SAD_SCREEN_DRY_INPUT=1`, so input is only logged; ports 21341 to 21343, where nothing
       listens) starts, holds this PC awake when on mains power (`appScreen.power`), lets go
       when `stayReachable` is turned off (kept in its config.json) and holds again when it is
       turned on; it reads this PC's power plan and, input being only logged, never changes
       it; and its `/keys` hooks the keyboard for a moment (F-013) and lets go when closed.
       The other steps run with the test pattern, which leaves the Windows calls
       out; on that path alone the agent once crashed at startup, and this step fails on it.
    10. (F-014, 2026-10-30) after 8: the hub's own API opens the hub's own screen (`?via=app`
       with the hub's ID, no link): login with its control password, a keyframe and frames, the
       session listed as "Another device on this PC's page"; Remember me saved and forgotten
       for itself (`self.savedPassword`); and `?via=rustdesk` with its own ID echoes 200 kB from
       its own direct port. Order 1, 2, 3, 5, 8, 10, 7, 4, 6.
  - Tear everything down, with no stray hbbs/hbbr processes left.
  - As built: the hub and the member are two `node agent/main.ts` processes (IPC for ready
    and stop; config.json names them e2e-hub and e2e-member). The steps run 1, 2, 3, 5, 4,
    6: the tunnel must ride the relay, and step 4 restarts the member with
    `SAD_TEST_SKIP_DIRECT=1` (same pairing, which also proves a restarted member links up on
    its own). Step 1 also proves LAN discovery (a WebSocket open on the member) and refuses a
    wrong code first, then joins with the discovered hub's ID, approves on the hub (not
    stored yet) and confirms on the member; step 3 also reads hbbr's log for "got paired"
    and "Both are raw".
    Both agents run with `SAD_TEST_NO_RUSTDESK=1`, and the member's direct port is the echo
    too, so this PC's RustDesk is never touched. It takes about 6 s.
  - First passed against the real hbbs/hbbr 1.1.16 on 2026-10-29. No RustDesk wire
    assumption had to change: hbbs registered the hub (`update_pk`), pushed FetchLocalAddr
    and request_relay over UDP, relayed the hub's LocalAddr as `is_local`, and hbbr paired
    the two streams with SAD1 passing through.
- `npm run build` and `npm run lint` stay clean.

## F-078 scope fix: a restricted MCP server reaches only the agents that name it

Claude loads the servers of the user's own config (`~/.claude.json`, user scope) in every chat. When windows-mcp was added there (20:45 on 2 Nov) every chat started its own (uvx, uv, python: about 0.7 GB commit each) and every agent could drive the desktop, against F-078's "Windows-MCP for the Assistant only".

- Every chat now starts with `--strict-mcp-config --mcp-config <state>/mcp/<session>.json` (`strictConfigFor`, `mcp-registry.ts`), a file of its own, written atomically, mode 0600, at each start (a restart, a resume, recovery and a subscription switch all go through `startHere`, so the file is always built from the config, registry and agent as they are then).
- It holds: the servers claude would have found itself (user scope, `projects["<folder>"].mcpServers`, the folder's `.mcp.json`) **except the restricted names**; then the registry servers the agent names (`mcpServers`); then the app's own server last (nothing can shadow it). Entries are passed on exactly as they are; the log line names the servers, never a value.
- Restricted: `windows-mcp` always, every server in `mcp-servers.json`, and the file's `"restricted": ["name", …]` list.
- Not carried (they would need the plugin or account that adds them; none is enabled today): plugin servers and claude.ai connectors. A `.mcp.json` above the chat's folder.
- The old way: `SAD_MCP_STRICT=0` (or `strictMcp: false`): chats start as before (the shared `mcp.json`, or their own file when the agent names a registry server, no `--strict-mcp-config`). If the file cannot be written the chat starts the old way and the log says so.
- **Open question for Shubham:** the user-scope server `scyramp-ai-ship-c35fae` (the other app's CRM tools, 39 tools) is NOT restricted: every chat still gets it, as before, because the CRM floors may use its tools. If only some agents should have it, add its name to `"restricted"` in `mcp-servers.json` and name it in those agents' `mcpServers` (it also needs an entry in the registry then).
- Checked with a real claude 2.1.316 on the files this code generates: a normal chat's init shows `shubham-agentic` connected and no windows-mcp; the Assistant's shows `shubham-agentic` and `windows-mcp` both connected.

## F-086/F-087 slice 1: the fast Assistant's host, the Orchestrator duty and hand-offs (hub side)

Dark: nothing changes in the app until the Assistant is switched on (`SAD_FAST_ASSISTANT=1`, or the file `<state>/agent/fast-assistant.on`, or `fastAssistant: true`; the hub only).
Files: `agent/agentic/fast-host.ts` (+ `fast-gate.ts`, `fast-tools-list.ts`), the duty in `shared/agentic.ts` / `floors.ts`, hand-offs in `orders.ts` / `index.ts`.
The session around the process (owners, sockets, brief, snapshot, tools and their gating) is `fast.ts` (Overlay).

- **The process** is NOT a chat: no terminal, no floor, no transcript. One hidden `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --replay-user-messages --no-session-persistence --session-id <uuid> --append-system-prompt-file <brief>
  --strict-mcp-config --mcp-config <file> --tools "" --permission-mode manual --permission-prompts none --allowedTools <fast tools> --settings <no hooks,
  no CLAUDE.md> --model haiku|sonnet --effort low`, started in a private empty folder (`<state>/agent/agentic/fast/room`), with the chats' own login
  (`librarianEnv`), a child of the agent. Its MCP file (mode 0600, deleted when it ends) names the app's shim with a key of its own (`sad_fast_…`) and
  `SAD_TOOLSET=fast`; the shim then lists only `FAST_TOOLS`; the hub decides each call by the key (`host.keyOwns(key)`), never by what the model says.
- **Supervision** is the guard's `supervise()` (backoff 0/2/5/10/20/30 s, 30 s init timeout, hung check); more than 6 exits in 5 minutes: `unavailable`
  with a sentence until somebody opens it again. A turn is sent to a restarted process at most twice. Ended by exact PID and start time (`proc-tree.ts`),
  never by name, pattern, port or `taskkill /T`; on the app stopping, its own handle first.
- **Warm only while open + 10 minutes** (`host.open(who)` / `host.close(who)`; the owners are the session's). No keep-alive turns.
- **Memory** (`fast-gate.ts`, the numbers are in `watchdog_status.fast.gate`): starts at 2.5 GB of available RAM or more; ended first (state `paused`,
  "Assistant paused: memory is low") when available RAM stays under 1.2 GB for 30 s; free commit under 1.0 GB only as a backstop. An unreadable number never
  ends it and never allows a start; when memory is back and somebody still has it open it starts again by itself.
- **Turns**: `ask({id, text, model, snapshot?}, emit)` → frames `delta`, `flush` (end of a text block), `tool {name,label}`, `done {text, ms, costUsd,
  ttftMs, cancelled?}`, `error {status,message}` (plain words, never the raw error). A new ask cuts the old one off (`done {cancelled}`), the process is
  interrupted, and the new turn is written when it has stopped (or after 400 ms); what it still says about the old turn is dropped. `interrupt(id)` =
  Stop (restarted if it does not stop in 2 s). The snapshot goes in front only when it differs from the last this process was given. A model change
  (Haiku / Sonnet "thorough") or a change of the naming choice restarts it between turns. `deliver(note, turnId, emit)` is the hub speaking (a hand-off's
  answer): a turn that never cuts another off and is not kept as Shubham's words. The last 6 turns and the open hand-offs go into the brief at every start.
  The last 30 turns' times (first word, finish) are in `status().timings` and in the log.
- **Role field**: `FloorAgent.duty: 'orchestrator' | null`, set by the hub only. `ensureDuty` (floors.ts) gives it once, from the old name (the agent
  Assistant on the floor Assistant), at the first start and whenever none has it; one agent only; a page can neither set nor clear it. Every check that
  was a name match (`isOrchestratorAgent`, `phoneUser`, the order gate, `prepare_send`, `ui_*`, `wa_*`, `phone_*`) now looks at the duty, so the overlay chat
  can be renamed; the overlay client (`src/overlay/assistant.ts`) finds it by the duty and never makes a second chat.
- **Hand-offs** (`orders.ts`, `HandoffApi` on the agent): an order whose giver is the fast Assistant (`from: 'fast'`, `kind: 'handoff'`, with its `origin`:
  web tab or phone device and ask). Typed into the Orchestrator with the same guards as every message (a prompt or Shubham's unsent text: 409 at once, no
  retry loop; not running: started and the order is `queued`); at most 6 a minute. Progress at 10 s, 60 s and every 5 minutes (`queued`, `typed`, `working`,
  `waiting-you`, `slow` after 15 minutes) with the chat's spinner words; `not-taken` after 120 s; give-up at 3 h. The answer is **not** typed anywhere: it goes
  to the session that registered with `listen({onReturn, onProgress})`; if that returns false the reply waits (kept 1 h) and is tried again. Stop = Esc into the
  Orchestrator and a reply "(cancelled: Shubham stopped it)". One reply per order; a reply is never an order; an acknowledgement opens none.

## M1 hole closed: nothing the app types goes after Shubham's unsent words

`restartChat` (the app's gentle restart: Claude subscription failover, the restart route) typed `/exit` into any idle chat without the draft check that `send_to_chat` has. With his unsent words in the box, `/exit` would have been pasted after them and sent WITH them, and a chat stopped under a draft loses it.

- `restartChat` now asks `hasDraft(sid)` first (the same check as `send_to_chat`: `draftOnScreen`, which ignores claude's grey/dim suggested next prompt and an empty box). A real draft: **409** "<agent>'s chat has unsent text in its box; nothing was typed and it was not restarted." Nothing is typed, nothing is stopped, nothing is started. The restart route returns that 409; the failover bridge logs "couldn't restart" and the chat is left for the person.
- `chats.type(sessionId, text, { refuseDraft: true })` types nothing and answers false on a real draft (the final guard, used by `restartChat` for `/exit` and by the failover bridge). Without the option `type()` is as before (his own say from the chat view joins his draft by design).
- The failover bridge (`claude/bridge.ts`, the "[message from the app]" lines and the note to Lead) now waits while the chat holds a draft (`drafting`), then types with `refuseDraft`; if the draft stays, it gives up with false and types nothing.
- Audited, nothing to change: the heartbeat nudge (`typeWhenReady … holdForDraft`), the watchdog's keys (`press`, only at a menu), a fresh chat's `/effort ultracode` and carry-on text (a chat that was just started has no draft), `send_to_chat` / `broadcast` (checked already), Esc on cancel (not text).
- Not covered: text typed into a chat on another PC (`typeInto` to a member) is not draft-checked there, because only the hub's own chats' screens are known to the caller.
- Tests: `restart.test.ts` (real draft refused with 409 and nothing typed, killed or started; the route's 409 and the retry after he clears it; a grey suggestion and an empty box allowed), `chats.test.ts` (`type` with `refuseDraft`), `bridge.test.ts` (waits for the draft to go; gives up when it stays).

## M1 hole closed, part 2: his unsent words in a chat on a member PC

The draft check (`hasDraft`) ran only for chats on the hub's own PC: the hub knows only its own screens. A message for a chat on a member PC was typed with no check.

- `typeInto` (index.ts) now takes `{ human?: boolean }`. Every caller except Shubham's own words (`sayTo` from the chat view, the `/effort` tune he changes) refuses a draft: locally through `chats.type(…, { refuseDraft: true })`, on a member through the link's `type` message carrying `refuseDraft: true`. The member PC, which knows its own screens, answers `'draft'` when the box holds his unsent text (a grey suggestion and an empty box are not), and types nothing. The hub then throws 409 "<agent>'s chat has unsent text in its box; try again shortly." An older member that does not know the field types as before.
- `send_to_chat` and `app_send_to_chat`: the 409 goes to the caller. A message refused for a draft starts no cooldown (`relayAllowed` now returns what takes it back) and opens no order. `broadcast_to_chats`: a member chat with a draft is counted with the skipped ones in the answer. The heartbeat nudge and the Assistant's reply delivery treat the refusal as "false, try again later"; a hand-off into a member's Orchestrator says it could not take it right now.
- Tests: `team.test.ts` (over the in-memory two-PC link of F-021): a draft in the Laptop chat is a 409 at the Server with nothing typed and the next message (box with only a grey suggestion) goes through at once; an empty box; a broadcast skips the Laptop chat with a draft and reaches it when the box is empty. The two draft tests fail without this change.

## F-114: Ports - share this PC's pages on Tailscale (ports/, shared/agent-api.ts `PortsState`)

Every PC's own agent can share some or all of the ports its programs listen on, on Tailscale, behind its own gate. Default **off** everywhere. `AgentState.ports` (absent on an older agent).

- **Routes**: `POST /ports/settings` {mode?: off|chosen|all, chosen?: number[], tlsBy?: agent|tailscale}, `/ports/share` {port}, `/ports/unshare` {port}, `/ports/refresh`. Each answers the new `PortsState`; 400 for a bad request, 409 for a port that can never be shared (the sentence says why).
- **How a port is shared**: `tailscale serve --bg --yes --tcp=<port> --proxy-protocol=1 tcp://127.0.0.1:<gate>` (raw TCP; default gate port 21223). The gate (gate.ts) reads the PROXY line, asks `tailscale whois` who the visitor is (identity.ts: a device of THIS tailnet, any account; not a shared-in node, not an IP Tailscale does not know), then looks at the first byte: 0x16 is a TLS ClientHello, answered by the gate itself with this PC's real certificate; anything else is plain http. So `https://<name>:<port>` (real certificate) and `http://<100.x.y.z>:<port>` (no warning) open on ONE port. Https by a bare IP can only be clicked through (no certificate can name an IP). The old way is the setting `tlsBy: tailscale` (`--tls-terminated-tcp`, Tailscale does the TLS, by name only), and it is the automatic fallback while there is no certificate (`gate.https: no-cert`).
- **The certificate** (cert.ts): `tailscale cert` only when missing, for another name, or within 21 days of running out; after a failure the next try waits 10, 20, 40 minutes ... up to a day (kept across restarts). The key stays in `<state>/agent/ports/cert/` and is never logged, shown or put in a state/note.
- **What is never shared** (block.ts), by Share all and one by one: `app` (decided by process: the agent, everything below it, the guard above it, the chat host, RustDesk and any copy of the app by its command line; the port numbers 21215-21229 etc. only for a process that cannot be identified), `tailscale`, `low` (< 1024), `windows`, `reserved` (80, 443, 4740, 4741, 4742, 8443, 8444), `debugger` (a browser/driver/Docker by name, `--inspect`/`--remote-debugging-port`/jdwp/debugpy in the command line, well-known ports 2375/2376/9222/9223/9229/9515/4444/4723/2828/5005/5678/5858/5900-5909, or an answer to GET /json/version, /json/list, /_ping, /status that looks like a debugger or WebDriver), `other-entry` (Tailscale already serves the port for the phone gate, the Drive or by hand), `not-reachable`. Only the app's page port (SAD_UI_PORT, 5173) is allowed (`appPage`).
- **Share all** = the dev-server programs (`ALL_PROGRAMS`: node, python, uvicorn, gunicorn, java, php ... matched without .exe and version, so Linux names match), ports 1024-49151, minus every block. A new port is shared only after two scans and a probe (a debugger that opens its port first cannot slip in); shared ports are probed again every 5 minutes.
- **Only its own entries**: the agent changes only the `serve` entries it made (kept in `<state>/agent/ports/state.json`); an entry that points elsewhere (80, 443, 4740, the phone gate's, the Drive's) is never touched and shows read-only (`sharedBy: gate|other`). Never `serve reset`, never Funnel. After a restart its own entries are found again and repaired to the new gate port.
- **Links never lie**: `PortShare.ipUrl` is http only where nobody does TLS in front of the gate; where Tailscale does the TLS (the phone gate's ports, other entries, `tlsBy: tailscale`) it is https with `ipUrlWarns`.
- **The Server button**: the hub puts `ports` (`PortsHello`) in its hello and sends a `ports` message when it changes; a member keeps it (`PortsState.server`); an older hub sends none and the member shows only the saved tailnet name.
- **Systems**: Windows' scanners are netstat and the process table. Linux's (F-116, `ports/scan-linux.ts`) read /proc and run nothing: listeners from `/proc/net/tcp` and `tcp6` (with each socket's uid and inode), the PID behind a socket through `/proc/<pid>/fd` of this account's own processes, and each process's name from its program file (`exe`; Node calls itself "MainThread" in comm). Any other system passes `net`/`procs` to `createPorts` or Ports says it has no scanner there yet.
- **Linux's own ports (F-116)**: a socket of a system account (uid < 1000, or 65534 nobody; never the agent's own non-root uid) or of a known system service (systemd, sshd, cupsd, avahi-daemon, snapd, containerd ...) gets the `windows` reason, worded for both systems. A socket whose PID can't be read (another account's) has `pid: null` and `program: null` in `ListeningPort`, so Share all never takes it.
- **Tailscale rights on Linux (F-116)**: `tailscale serve` and `tailscale cert` work only for root or Tailscale's operator. Ports reads `tailscale debug prefs` (OperatorUser) with the node's facts, once a minute; when this user is neither, `PortsState.tailscaleRights` = {text, command: `sudo tailscale set --operator=$USER`} and the page shows that one line to run once (the app never runs sudo). status and whois work without it. The field is absent on Windows.
- **Plain http by name goes to https (F-117, 5 Nov 2026)**: a browser does not upgrade `http://<name>:5173` by itself, and a Tailscale-terminated port cannot answer plain http at all (curl 52 "Empty reply"). On a share where the agent does the TLS (`tlsBy: agent`, certificate loaded) the gate answers plain http whose Host is this PC's NAME (full or short, any case, trailing dot) with **308** to `https://<full name>:<port><same path and query>` (`Cache-Control: no-store`; a POST keeps its method and body); a WebSocket upgrade over http-by-name gets **426** with the wss address that works. A Host that is a bare IP (v4 or [v6]) stays plain http, and a name that is not this PC's is served as before. **No HSTS**: it is per host, not per port, so it would break http on every other port of the name (80, the old way's ports) and stick in browsers after the setting is switched off. `PortsState.httpRedirect {on, active}` (setting `redirectHttp`, default on; `active` = on + tlsBy agent + gate up + certificate loaded). `tlsBy: tailscale` is unchanged and has no redirect (and no plain http). Every Ports settings change is written to the agent log as `setting changed: <key> <old> -> <new>`.
- **The gate marks every visit that came over the tailnet (F-118, 5 Nov 2026)**: every request the Ports gate passes to a shared page (http, https, and the WebSocket upgrade) gets `x-sad-via: tailnet` and, when Tailscale names the person behind the device (whois `UserProfile.LoginName`; a tagged device has none), `x-sad-via-login: <login>` (printable ASCII; anything else percent-encoded, at most 200 characters). The login is for audit only. Before the header is set, the gate removes every header the visitor sent whose name starts with `x-sad-via` and also drops such a name from a `Connection` header, so nobody can forge the mark or make it disappear further along; the other `Connection` tokens (`Upgrade`) stay. The plain-http-by-name 308 is answered by the gate itself and reaches no page; the request the browser sends on to https gets the mark like any other. A visit that did not come through this gate has no such header. The agent's Accounts reads it for the sign-in level "remote". The phone gate (christopher-remote) is not changed. Tests: `agent/ports/gate.test.ts` 19-22.
- **The Common Drive (F-097) was REMOVED on 10 Nov 2026, on Shubham's order** ("he only needs the CRM files"): no agent/drive store, routes, WebDAV, sync program, phone inbox or Google backup any more; /drive is the CRM files page (F-126). Its folder (`C:\Common Drive`) and agent/drive/settings.json stay on disk untouched. agent/drive/ keeps only tailscale.ts (Ports, tailnet) and mime.ts (CRM files). The F-125 note below is history.
- **Google keys of the Common Drive (F-125, 5 Nov 2026)**: the Drive's setting `googleSource` is `company` (default, bztech68 as the CRM uses it) or `shubhambhole68` (the old way). Company keys: `secrets/gdrive-bztech68.env`, imported by the page's button (`POST /drive/backup/import-keys`, not for sync devices) from `Desktop/Github/CRM/sam-crm-be/.env`: only GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET and GDRIVE_REFRESH_TOKEN are read, the file is locked to the user (icacls / chmod 600) before the keys go in and then renamed into place, and no value is in an answer or a log. shubhambhole68's keys are read from his Desktop (`gdrive-shubhambhole68.env`, `auth secret.json`, `client_secret*.json`; the files fill in for each other) and are never copied. `GET /drive/backup` says `source`, `keysBySource` (`set`/`missing`) and `canImport`. The backup's folder stays its own private "Common Drive" (never the CRM's, never public). Tests: `agent/drive/google-source.test.ts`. F-126's contract (the CRM files tree, mount, routes and error shapes) is `shared/crm-files.ts`.
- **The CRM files (F-126, 5 Nov 2026)**: `agent/crm-files/`. The CRM's own records decide what the files are (`files`, `file_groups`, `file_versions`), not the Google Drive folders; the tree is the old agentic-claude-manager drive's: a folder per `folder` tag, under "projects" a folder per project the signed-in CRM account may open (and "Uncategorised"), nested file groups, files. It shows that account's view, using the CRM session this PC holds (`crm-session.json`) through `crmproxy.request()`. `service.ts` is the one place that knows the tree (`children`, `node`, `file`, `versions`, `upload`, `version`, `folder`, `rename`, `move`): the page reaches it through `routes.ts` (`/agent-api/agentic/crm-files`, shapes in `shared/crm-files.ts`), the Linux mount calls it in process, and the Windows host reaches the CRM through `bridge.ts`. Every change goes through the CRM's own routes (a new file or version: the CRM's Drive token, a resumable upload under the CRM's key naming, then `POST /org/files` or `/org/files/:id/version`; a folder: `POST /org/file-groups`; rename and move: the CRM's PATCH routes). There is NO delete: a DELETE is refused with 405 `nodelete`, the service has no such function, and the bridge refuses it too. Per-node `rights` follow the old drive: writing needs the CRM's write grant (`hierarchy-access/me`), a project the person manages (`accessType` manager/hierarchy) and, for bytes, the upload grant (the token route answers 403 otherwise); a link to another website has no new-version right. A refused upload's body is drained when small and cut off when big. **Windows**: `crm-fs/` is our copy of the old CRM Files drive host (C#, WinFsp), built reproducibly by `dotnet build` of the pinned SDK (8.0.426, in `%LOCALAPPDATA%\dotnet-sdk-8`, called by full path) in a SHORT folder (the net48 reference assemblies fail past MAX_PATH), with `nuget.config` (nuget.org only, signatures required, three Microsoft Corporation author certificates pinned) and `packages.lock.json`; `bin`, `obj` and `.nuget` are not in git. `mount-win.ts` starts it as `crm-fs.exe -m Y:` with `CRM_MGR_BASE` (the bridge: loopback, a new port and a new secret every run, only `/api/crm-proxy/org/...` and `/api/crm/session`, no Origin, Host checked) and `CRM_MGR_TOKEN` in its environment; the host sends the secret in `x-crm-fs-token` to that address only. It stops the host by its own process id (never by name, never a tree; the old build's crm-fs.exe and its X: are never touched), starts it only if `crm-fs.exe` matches `RELEASE.json` `crmFsSha256` when that is set, says in plain words why it can not run (`CRM_FILES_REASONS`), and remembers on/off in `crm-drive.json`. Linux brings its own driver (`mountDriver`). Tests: `agent/crm-files/*.test.ts`.
- **Uploads of any size, in parts, held by the agent (od0b1, 11 Nov 2026)**: `agent/crm-files/uploads.ts`, routes `/agent-api/agentic/crm-files/uploads[/start|/part|/pause|/resume|/retry|/cancel|/clear]` (shapes and words in `shared/crm-files.ts`), the page's helper `shared/crm-upload-client.ts`. No WebDAV, no single long request: the page sends the file in parts (8 MiB by default, any size up to 64 MiB, strictly in order: a part at the wrong offset is refused 409 `offset` with the upload, so the page goes on from `upload.received`); each part is written to `<state>/crm-uploads/<id>.part` and flushed to the disk BEFORE it is acknowledged, then the journal `<id>.json` is written (temp file + rename), so a restart never claims bytes it does not have (bytes after the last acknowledged part are trimmed at the start). A worker sends what is here on to Google Drive through ONE resumable session opened as the CRM's own pages open it (`service.ts` `uploadBackend`: the CRM's token, today's folder, the CRM's key in `appProperties.path`), in pieces of `CRM_UPLOAD_CHUNK` (16 MiB, a multiple of Google's 256 KiB unit; every piece but the last is whole units), as soon as a whole piece is here, at most `CRM_UPLOAD_PARALLEL` (3) uploads at once. Failures that waiting cures (a broken or stalled line: 60 s without a byte, 120 s without an answer; Google 5xx/408/429/401, 403 rate limits; the CRM down or signed out) are retried for ever with growing waits (1 s, 2 s ... 5 min); after one, Google is asked how far it got (`bytes */size`) and the upload goes on from there (Google may keep less than it was sent). A forgotten session (404/410) starts a new one from byte 0. At the end Google's `size` and `md5Checksum` are checked against the md5 of what the page sent (counted as the parts came in, or read again from the file after a restart); a mismatch stops as `failed`/`integrity` BEFORE the CRM is told (Retry sends it again in a new session; the bad copy is left in Drive, nothing points at it). Then the CRM record is made exactly as the one-request upload does (`POST /org/files` or `/org/files/:id/version`); a try whose answer was lost is found by its key first (never a second record); a new file whose name was taken meanwhile is recorded as "name (2).ext" (`savedAs`). Everything is checked before a byte is taken (rights, name, a name already used, the CRM's blocked kinds of file `CRM_BLOCKED_EXTENSIONS`/`CRM_BLOCKED_TYPES`, the CRM's own 500 MB cap `CRM_FILES_MAX_UPLOAD`, room on this PC's disk: 507 `nospace`). The page may close once every byte is on this PC; after a reload an upload still waiting for bytes shows `needsFile` and `resumeWith` goes on with the same file. NOTHING IS DELETED: no DELETE to Google (a cancelled session lapses after a week), no CRM file touched; the only file removed is the agent's own copy, once the CRM has the file or the person cancels (tried again at the next start if Windows holds it). The session address is a credential for that one upload: only in the journal (gone from it once done), never in a log, a list or an error (`scrub`). `addFile` (in process, not a route) copies a file of this PC into the pending folder for the drive's saves; the file itself is never touched. The one-request `POST /upload` and `/version` stay as they were. Tests: `agent/crm-files/uploads.test.ts` (a pretend Google on 127.0.0.1 from port 50000, `google.fake.ts`: cut lines, stalls, busy answers, forgotten sessions, wrong md5, restarts) and `agent/crm-files/upload-client.test.ts` (the helper over the real routes, with a 1 GB sparse file, a cut line and an agent restart in the middle).
- Tests: `ports/parts.test.ts`, `gate.test.ts` (real sockets), `index.test.ts` (fake tailscale `fake-tailscale.ts`, throwaway certificate `test-cert.ts`), `links.test.ts`, `api.test.ts`.

## Stable ports per PC (order od91f, 11 Nov 2026; ports/stable.ts, ports/stable-proxy.ts, shared/stable-ports.ts)

Shubham: "for each PC, we want to have a port stable. So there is chat 1, chat 2, screen and updates." Every PC has four fixed ports, one per tab of its PC control
workspace. Opening one opens the app's own page straight at that tab; nothing else answers on it.

- **The table**: block n (1-99) = 51000 + 10 n + 1 (Chat 1), + 2 (Chat 2), + 3 (Screen), + 4 (Updates); + 5 to + 9 spare. All above Share all's 1024-49151, so
  Share all never takes one. 50126 (the CRM drive's WebDAV on Linux) is never handed out.
- **Who hands them out**: the Server, in `<state>/agent/ports/stable.json` `{v:1, pcs:[{id, name, ports, since, pending?, gone?}]}`: itself first, then the paired
  PCs in the order they joined (devices.json), each the first free block. A block is never handed out twice: a removed PC keeps its own (`gone`), so a saved link
  never opens another PC, and gets it back if it pairs again. A hand-edited file with two PCs on one port: the later one is left out and gets a free block.
- **Each PC's own settings**: config.json `stablePorts {on, share, chat1, chat2, screen, updates}` (the four together or none; a wrong value is an error naming
  the key, like every key). The Server sends the table in its hello (`stable`) and as a `{t:'stable', stable}` message whenever it changes; a member saves its
  own four. A member's hello says what it saved (`stableBlock`): an entry the Server made while that PC was away (`pending`) takes it when no other PC holds those
  ports, so a Server that lost its file gives every PC its old block back. Once settled, the Server's table wins.
- **Off by default** on every PC (`on: false`, `share: false`); never in test mode, never with `SAD_STABLE_PORTS=off`. On: a member answers on its own four,
  the Server on every PC's (one place that is always on). Each port listens on 127.0.0.1 and ::1 (`exclusive`), so the tailnet reaches it only through the Ports gate.
- **A port** (stable-proxy.ts): `GET`/`HEAD /` (exactly) answers `302 /pc-control?pc=<id>&view=<chat1|chat2|screen|updates>` (relative, `no-store`); everything
  else (the page, /agent-api, WebSockets) goes byte for byte to the app's page on this PC (SAD_UI_PORT, 5173; `localhost`, both families), Host and headers as
  they came, so the page server's rules hold as on 5173 (its Host check, the token only for the app's own pages, F-118's sign-in; the sign-in cookie is the host's,
  whatever the port). The page not answering: a plain 502 that says so.
- **The clash check**: before listening, what listens now is read (the Ports scanners); a port another program holds is never moved: its state is `taken`
  with the program and PID, the log says `stable port 51042 (<PC> · Chat 2): node (pid 8120) holds it. It is not moved ...` once per change, and it is tried
  again every 30 s (only what is wanted and not answering). A failed listen (EADDRINUSE the scan missed) is `taken` too; another program on the other loopback
  (::1) closes ours on 127.0.0.1 as well (a visitor through the gate, which dials both, could reach it); EACCES (Windows' excluded ranges) is `reserved`.
  50000+ is also Windows' range for temporary ports, so a clash after a restart is possible: the page names the program and Change moves the block.
- **On Tailscale**: with `share` on, Ports (index.ts option `stable`) shares the ports this PC answers on through its own gate, whatever its mode (Off too),
  with no settling or probe (they are this agent's own pages); block.ts never blocks them as the app's (`pagePorts`); they are never in `chosen`. Off again,
  their entries go. Never Funnel, never `serve reset`.
- **Routes**: `POST /ports/stable/settings {on?, share?}`; `POST /ports/stable/change {pc, ports}` (the Server only; 400 with the reason for four ports that
  may not be used: from 50000 to 65535, all different, none another PC's, none 50126; 409 for one a program holds on the Server now, a removed PC, or a member;
  404 for an unknown PC). Both answer `PortsState`, which carries `stable` (`StablePortsState`: on, share, unavailable, server, pcs with each port's state,
  error, at); every Ports route answers it with `stable` too.
- **The page** (Settings › Ports, `src/ports/StablePorts.tsx`): the two switches, a row per PC with its four ports, each port's state in words with a shape
  (Answering, Off, The Server answers, Held by another program, Kept by the system ...) and its link (the shared one by name, else the local one on this PC),
  the full sentence for a port in trouble, Change in the row (the Server only; the next free block offered), and the removed PCs folded away. The other lists
  of the page leave out the stable ports this PC answers on, and a member's Server card the Server's. Fixtures: `?mock=hub|member&ports=stable|nostable`.
- Tests: `shared/stable-ports.test.ts`, `ports/stable.test.ts` (the table, restart, a new PC, a removed one, the clash check, Change, a member, a lost
  Server file), `ports/stable-proxy.test.ts` (real sockets), `ports/index.test.ts` 15, `config.test.ts`, `api.test.ts`.

## F-118: who is using the app (auth/, agentic/access.ts, shared/auth.ts)

Each person signs in IN THE PAGE (per browser) with their own CRM account; every chat belongs to one person; the owner can
share a chat as "can view" or "can type"; sbskrrt (the CRM id in `auth.json` `admins`, default Shubham's) sees all and alone uses
the PC's own pages. The contract (routes, errors, types, `chatRights`, `scopeFloors`) is `shared/auth.ts`; it is enforced in the
agent, on HTTP, on every WebSocket and in the chats' tools, never only hidden in the page.

- **Sign-in** (`auth/index.ts`): `POST /auth/sign-in {username, password}` goes to the CRM once (`claude/crm.ts` signIn, the F-007
  pattern); the CRM's cookie is used for who-am-I and the member list (a CRM `client` account may not sign in) and dropped. The agent
  issues its own cookie `sad_session` (httpOnly, SameSite=Strict, Secure over https): 256 random bits; only their sha-256 is kept in
  `<state>/agent/auth.json` (mode 0600). A session ends 7 days after it began or 12 h after it was last used (sign-out and
  "sign out everywhere" end it at once; open sockets get `{t:'auth', ended}` and close with 4401). Five wrong tries a minute per
  username, thirty for the whole app (429 `slow-down`). Nothing secret is logged: deny lines carry the username, the id's first 8
  characters, the route and the chat id's first 8.
- **Where it sits**: the token (`x-sad-token`, added by the page server) stays the machine boundary; the cookie is the person boundary
  on top. `api.ts` resolves the cookie after the token check (`callerOf`), gates every route and WebSocket (`gate`: 401 `sign-in` when
  this request has to be signed in, 403 `admin-only` for the core routes and every mount that is not `scoped`), and gives the caller to
  the agentic mount, which decides by person (`MountRequest.caller`, `wsAllow`, `raw(req, res, caller)`). `ownAuth` paths (a chat's own
  key) and the phone's device-key paths are not gated by sign-in; the phone is exempt while `phoneExempt` (default true).
- **How strict** (`auth.require`, saved in `auth.json`): `off` (as before: an unsigned browser is the open app, trusted; a signed-in one
  is scoped), `remote` (a request that came over the tailnet must sign in; this PC's own browser stays open), `all` (everyone).
  "Came over the tailnet" = the header `x-sad-via: tailnet`, which only the Ports gate (it strips any client copy first) and the page
  server (`auth/via.ts`: a connection from a non-loopback address, such as the F-028 listener's) may set; the page server keeps the
  gate's exact value from loopback and drops every other claim. Raising the level is a TRIAL: only a signed-in sbskrrt can, it
  applies at once and reverts after 120 s unless that SAME session calls `POST /auth/settings/confirm`; lowering is immediate.
  Break-glass: the file `<state>/agent/auth-off`, or `SAD_AUTH=off`, forces `off` (read each second; the saved level is untouched).
  Ships as `off`: nothing changes for anyone until sbskrrt raises it.
- **Ownership** (`agentic/floors.ts`): `FloorAgent.owner`, `sharedWith`, `Floor.createdBy`, kept by the hub, never taken from a page
  (`patch` puts the old ones back; an agent the chart adds is the editor's). At start every floor and chat without an owner becomes
  sbskrrt's (idempotent, logged by count). What the open app makes is sbskrrt's; a chat's tools act as its owner; a member passes its
  page's person to the hub (`by`) and the hub decides as for a page of its own.
- **Rights** (`agentic/access.ts`): owner = everything; shared `type` = read and type into a RUNNING chat; `view` = read; sbskrrt =
  everything. Start, stop, restart, move, rename, tune and share are the owner's or sbskrrt's; a floor is changed by its maker (or
  sbskrrt), deleted only by someone who owns every chat on it. `POLICY` lists every route of the agentic table with its rule; a route
  not listed is for sbskrrt only, and `access.test.ts` holds POLICY and the table equal. Lists, `/events`, previews, runs, transcripts
  and the live states are filtered per connection; floors with nothing visible are hidden; a share taken back closes the sharee's open
  terminal and chat sockets (4403) and a downgrade to view stops their typing at once.
- **Tools**: `app_chats`, `list_chats` and `floor_roster` list only what the chat's owner may see; reading, typing, stopping, opening and
  setting effort on another chat need the matching right; `agent_hire` makes the hire the owner's; the task list, the phone, the screen,
  WhatsApp, the watchdog and the app's memory are for sbskrrt's chats only.
- **Tests**: `shared/auth.test.ts`, `auth/index.test.ts` (sessions, throttle, trial, break-glass, who may change the level),
  `auth/via.test.ts`, `api-auth.test.ts` (the gate over HTTP and WebSockets), `agentic/access.test.ts` and `access-hub.test.ts`.

## F-122: codes to add a device for a signed-in sbskrrt (agentic/index.ts ownerCodeBy, agentic/voice.ts, auth/index.ts)

Three agent routes hand out a one-time code. Two follow the approval-device rule and now ALSO the owner's session:
- `POST /agentic/approvals/devices/code` ("Show a code to add a device", Settings › Security › Approval device): the first device needs nothing; after that a registered approval device's signature, or (F-122) a browser signed in as sbskrrt.
- `POST /voice/pair-code` ("Show a pairing code", Settings › Devices › Pair Chris): a registered device's signature, or (F-122) a browser signed in as sbskrrt, even when no approval device is registered yet.
- `POST /pairing/start` (Add a PC on the hub, core route) has NO device rule: it is the page token only (and, since F-118, the owner's pages), and the new PC still has to be approved on the hub. Unchanged. `approvals/devices/recover/finish` gives a code after a Windows administrator prompt on the PC itself: its own rule, unchanged. WhatsApp's `pairCode` is a code WhatsApp makes for its own linking, not a device code.

The rule: a request that carries a signature is checked as a signature, exactly as before. Without one, a caller whose session is sbskrrt's (`caller.person.canSeeAll`) is given the code, unless Settings turned it off (`auth.json` `ownerCodes`, default true; `PUT /auth/settings {ownerCodes}`, signed-in sbskrrt only, logged). "Unsigned, acting as sbskrrt" at sign-in level off does NOT count: only a real session does, since every tailnet device can open the Server's page. Anyone else is refused as before (non-owner people: 403 admin-only). Every code given is logged in the approvals log with who and where ("sbskrrt (019d2ff6) signed in, over the tailnet as <login>, the app (<browser>)" or `device "<name>"`), never the code. `AuthStatus.mayShowCode` tells the page, per browser, whether to show the buttons for the new way. Tests: `agentic/owner-codes.test.ts`, `auth/index.test.ts`, `shared/auth.test.ts`.

## F-118 gap closed: the PC itself is not a browser (agent/auth/types.ts isPageRequest, api.ts callerOf, ui-server.ts)

Found live on 5 Nov at 21:26, when sign-in was raised to Everyone: the Server's own tool (build-api.mjs: the machine token from the api-token file, a plain fetch from 127.0.0.1) was refused with 401 sign-in on /build/info. A request with the machine token and NONE of the page markers is the PC itself: `Caller.machine`. It is not bound by the sign-in level on any route or socket, and acts as the owner of the app (`isAdmin` true, what it makes is sbskrrt's); it holds no person's session, so it still cannot change the sign-in level (a signed-in sbskrrt's to do) and `/auth/me` answers 401 for it.
The page markers, any one of which makes a request a page: the page server's `x-sad-page` (set on EVERY request ui-server.ts forwards, a client's own copy overwritten, so an old browser that sends no fetch metadata still counts), an Origin, `sec-fetch-site` or `sec-fetch-dest` (what a browser always sends; NOT `sec-fetch-mode`, which Node's own fetch also sends), and `x-sad-via` with any value (the Ports gate and the page server). A forged marker only ever makes a program a page, never the other way. F-119's `mayPublish` uses the same test. The chats' own key paths (`/agentic/mcp/call`, `/mcp/recall`) and the phone's device-key paths are not gated by sign-in at all and are unchanged. Tests: `api-auth.test.ts` (the machine, every marker, sockets, the level raised under it), `agentic/machine-caller.test.ts` (build routes, agentic routes, a chat's MCP call at level Everyone), `auth/via.test.ts` (x-sad-page).

## F-124: "Sign-in is enough (no approval device)" (auth/index.ts, agentic/index.ts humanProof, whatsapp/index.ts)

One setting, `signInEnough` in `auth.json` (default ON; F-122's `ownerCodes` is the same switch under its old name: both are shown and both are accepted by `PUT /auth/settings`, an old file that said `ownerCodes: false` stays off). Only a signed-in sbskrrt changes it (401 unsigned, 403 admin-only others, logged). While it is on, EVERY place that asks for a registered approval device's signature also accepts a browser signed in as sbskrrt (a real F-118 session: `caller.person.canSeeAll`); `AuthStatus.mayApprove` (and `mayShowCode`, the same value) tells the page. An unsigned page never counts, at any level (the open app acting as sbskrrt included); other people never; a request that carries a `sig` is always checked as a signature, even from sbskrrt. Off = exactly the approval-device rule. Registered devices work either way. Every action done this way is logged with the person ("sbskrrt (019d2ff6) signed in, on this PC / over the tailnet as <login>") and the browser, never a secret.
The places that check a device signature (all `humanOnly`: a chat's key never reaches them), all through `humanProof(kind, fields, sig, request)` except the two marked:
- `POST /agentic/approvals/answer` (kind `answer`): a tap on a prompt. `POST /agentic/approvals/cancel` (`cancel`): Esc on a prompt.
- `POST /agentic/send-as-me` (`send`): his words into a chat (the Assistant's prepared cards go through it).
- `POST /agentic/approvals/devices/code` (`code`): the code to add a device. `POST /agentic/approvals/devices/remove` (`remove`). `POST /agentic/approvals/devices/unsigned` (`unsigned`): the old no-signature way on or off.
- `POST /voice/pair-code` (`pair`; its own check in the voice wiring, the same rule): the pairing code for the phone.
- `POST /agentic/auto-update` ON (`autoupdate`; its own check, never the unsigned old way): off needs nothing, as before.
- `POST /whatsapp/send` (`wa-send`): a WhatsApp message; the request now travels with the proof (`o.human(kind, fields, sig, request)`).
No WebSocket checks a device signature. `POST /agentic/approvals/devices/register` uses a one-time code, not a signature, and the Windows-administrator recovery its own prompt: both unchanged. Tests: `agentic/sign-in-enough.test.ts` (each place; unsigned and other people refused; a registered device both ways; a wrong signature from sbskrrt refused; switch off = the old rule; the two names), `agentic/owner-codes.test.ts`, `whatsapp/index.test.ts`.

## F-127: new chats on a PC while the Server is down (agentic/index.ts, offline.ts, floors.ts adopt)

A member PC whose hub (the Server) can't be reached used to refuse every floor change and chat start (503). Now, with the per-PC setting on (default ON, `<state>/agent/agentic/offline.json`; `GET/PUT /agentic/offline-chats {on}`, a signed-in sbskrrt changes it, logged), it makes and runs NEW floors and chats itself:
- **When**: the Server has been out of reach for 20 s (`offlineAfterMs`; the stream's loss starts the clock, a blip of the link does not count). `team.offline` {on, active, since, hubName} says so. Before that, and with the setting off, the old 503 (code `hub-offline`, now with what will change).
- **How**: a member keeps a second floor store, `floors-local.json` (the same `createFloorStore`); the `floors` every handler uses is a facade: a member's is the local store (it keeps no copy of the Server's floors in a store: that is the replica), the hub's and a PC alone's is as before. `allFloors()` on a member = the Server's floors (read-only here) + the local ones not yet joined, flagged `local: true`. `route()` runs a route here (`runsHere`) when it is a route of a local floor, or `POST /floors` while offline; the Server's floors stay read-only (503 `hub-offline`). A chat on a local floor starts through the usual `startHere` with no lease, on THIS PC's own Claude sign-in (`o.token`); without one, `409 no-claude` before anything is made. Its tools (`callTool`) run here for a local SESSION (a Server session's go to the Server, decided per call); task list, phone, WhatsApp, screen, the watchdog and the memory layer say "needs the Server" (503 `hub-offline`).
- **Owners** (F-118): a local floor and its chats are the signed-in person's (`createdBy`, `owner`), so scoping and sharing work from the stored fields; every chat on a PC runs on that PC's single Claude sign-in, which the page says.
- **Joining** (`adoptLocal` on the member, `adoptFloors` on the hub, the new link op `adopt`): when the Server can be reached again (and every 30 s after a failure) the member sends ALL its local floors whole (ids, owners, shares, chats, memory notes, which chats run here, the marks of their conversations). The hub keeps the same ids, makes the member the chats' home, holds the running ones for it, catches every conversation up (the F-021 mirror's pull) and answers its copies' marks. A floor it already has by id is a no-op; a name that is taken becomes "<name> (<PC name>)" (numbered if that is taken). The member checks that the Server's list shows each floor with the same agents, chats and owners, that every stopped chat's conversation is equal (size and tail), moves a running chat's stream on from the Server's copy, and only THEN drops the local floors: the old file is kept as `floors-local.adopted-<time>.json`. Any failure leaves everything as it was and is tried again; an older Server that doesn't know `adopt` is said so ("update it"). Status: `adopt` {state, floors, joined, sessions, why} on `GET /offline-chats` and as the event `{t:'adopt'}`.
- **Not in v1**: starting an EXISTING Server agent's chat offline (a partition does not mean the Server is idle: two writers would fork a conversation); "keep on this PC only"; the Server's tasks, approvals page, memory layer, Assistant and WhatsApp (they say they need the Server).
- Tests: `agentic/offline-chats.test.ts` (offline making and running, the debounce, the tools, no Claude sign-in, the setting, joining with a running chat, a name clash, an older Server, a failed copy retried, two people on one PC) and the `adopt` unit tests there; `team.test.ts` updated for `team.offline`.

F-128 (goals reorder, Move to today): no agent change. The CRM proxy has always forwarded changes with the PC's session and the CSRF pair; `agentic/crmproxy-goals.test.ts` pins `PUT /v1/org/goals/my-order` and `POST /v1/org/bucket/today/{reorder,add,remove}`: sbskrrt and the PC itself get through, another person is 403, a page nobody signed in on at level Everyone is 401.

## F-134: Codex as a second engine for agents' chats

Shubham's rule: it works exactly like Claude's. The PC is signed in with the person's CRM login (F-007); the agent asks the CRM for THAT PERSON'S Codex login with that session, so there is no Codex sign-in on any PC and no key or password typed into the app. The only one-time sign-in is the CRM super admin's ChatGPT login, when a subscription is added to the CRM. A login Codex refreshed goes back to the CRM with the same session. The contract (CRM routes, agent types) is `shared/codex.ts` and the CRM side is sam-crm-be `controller/codexSubscriptionsController.js`.

- **Engine per agent.** `FloorAgent.engine` ('' follows Settings › Chats, which is Claude unless changed; 'claude'; 'codex'), `codexModel` (free text), `codexEffort` (low|medium|high|xhigh), and `codexThread` (the agent's own: Codex chooses the id of its conversation, so it is learnt from the rollout file and kept; a page can neither set nor clear it). `ChatDefaults` has the same three. Changing the engine of an agent that has a chat is a 409 `engine-change-new-conversation` with the sentence for the page until the body carries `confirmNewConversation: true`; then the old binding is let go (the old transcript stays on disk). "Default" is judged by the engine that really runs.
- **The login's life on this PC** (`codex/index.ts`): fetched before the first Codex chat and written to `<state>/agent/codex/home/auth.json` with a sidecar `fetched.json` (revision and hash, no secret; the sidecar is written first); watched while Codex chats run (every 20 s); a file Codex REWROTE (a refresh rotates the refresh token, so it is the only copy of the new login) is put back to the CRM at once (`PUT mine/credential`, a compare-and-swap on the revision). It is deleted only after the last Codex chat ends AND the CRM has it (or the file is unchanged, or the CRM can never take it and its own copy has been fetched to replace it). If the CRM is unreachable, busy, braking, or the session ended, the file stays, owner-only, and is tried again every 3 minutes, at the hourly check, and at every start (`sweep`). A 409 (someone wrote newer) fetches the CRM's copy and restarts the running Codex chats on it. A changed file waiting means a new chat starts on THAT file (the newest login there is), never on an older CRM copy. Logs and `GET /codex/status` carry names, codes and revision numbers only.
- **The Codex home** (`codex/home.ts`): one per PC. `config.toml` (login in a file, approval_policy never, sandbox_mode danger-full-access = "No prompts, full access", no update banner), a fixed `AGENTS.md`, and one profile per chat (`chat-<id>.config.toml`: the brief as `developer_instructions` behind a `[sad-chat <id>]` marker, model, model_reasoning_effort, the MCP servers; the chat's own key is only NAMED, `env_vars = ["SAD_AGENTIC_KEY","SAD_AGENTIC_URL"]`, and comes through the terminal's environment). Started as `codex -p <profile> --no-alt-screen [resume <thread>]`. The person's own OPENAI_API_KEY / CODEX_* never reach the chat; the Claude token never reaches a Codex chat.
- **The conversation** (`codex/rollout.ts`): `<home>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`. The chat view reads it through a row format (`chatview.ts` `RowFormat`; Claude's is the default and unchanged); a new chat's id is found by the marker in the first lines. Every place that looks for a chat's file goes through one `findTranscript` that answers the rollout for a Codex chat. Codex conversations stay on the PC that started them for now (opening one elsewhere is a 409 `codex-conversation-elsewhere`, never a silent new conversation).
- **The screen and the sender** (`codex/screen.ts`, `codex/sender.ts`, `chats.ts`): Codex's TUI is read for working ("Working (7s • esc to interrupt)"), idle ("? for shortcuts"), a draft in the box, a menu (a numbered option under the cursor, a menu footer) and background terminals. A message is a bracketed paste, a 2 s wait, Enter, then a look: still in the box = Enter again (3 at most); never an Enter into a menu. Paste-then-quick-Enter was flaky on Codex 0.163.0 (one in four), typing then waiting worked every time.
- **Routes** (`/agent-api/agentic`): `GET /codex/status` (SIGNED; `CodexStatus`: enabled, installed, version, state, hint, assigned {name, kind, revision}, lastFetchedAt, lastWrittenBackAt, waitingToWriteBack), `POST /codex/refresh` (OWNER), `GET|PUT /codex/settings` (read SIGNED, write OWNER: `{enabled}`; ships OFF), `POST …/tune` with `codexModel`/`codexEffort` (kept for the next start). A Codex chat that can't start answers a 409/503 with `code` = turned-off, not-installed, no-subscription, disabled, sign-in-needed, crm-offline or error and a plain sentence.
- **Not in this step**: the Codex CLI is found (SAD_CODEX_BIN, PATH, ~/.local/bin) but not installed by the app; the usage and limits of a Codex chat (the rollout's `token_count.rate_limits` is the source), failover between Codex subscriptions, the memory hook, the page.
- Tests: `codex/{home,index,rollout,sender,crm}.test.ts` (the login's durability: a crash after a refresh, the CRM offline at the end, a 409, a mismatched account, an unchanged file; the rollout reader; the screen and sender; the CRM client against a recording stand-in), `agentic/chats-codex.test.ts`, `agentic/codex-chats.test.ts` (an agent that runs Codex, end to end with fakes), `agentic/floors-engine.test.ts`.


### F-138: the CRM's credentials come in two kinds, for Claude and for Codex

- **Claude** (`claude/crm.ts`, `claude/index.ts`): the credential request sends `x-credential-kinds: subscription,api_key` (without it a CRM answers 409 `KIND_UNSUPPORTED` for an API key, so an old app is never handed one it cannot use). A `subscription` is a setup token in `CLAUDE_CODE_OAUTH_TOKEN`, exactly as F-007; an `api_key` is an Anthropic key in `ANTHROPIC_API_KEY`. Each secret must have its own shape. **Exactly one of the two variables is ever set**: the app removes the other one only if it put it there itself (never a person's own value), after the new one is in; chats and the librarian (`credentialEnv()`, `ChatPoolOptions.credential`) get exactly one and an inherited `ANTHROPIC_API_KEY` (which would silently win) is taken out. An API key has no weekly limit: it is never a switch target (`buildChoices`), the app never switches a person off one by itself (`autoRefusal`), and a manual switch by the super admin from a key to a subscription is a plain "use this one". A `claude-subscription.json` without `kind`/`var` is a subscription in `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex** (`codex/crm.ts`, `codex/index.ts`): the answer is a ChatGPT login (`authJson`, a file, refreshed and put back as in F-134) or an OpenAI API key (`apiKey`, `sk-…`, not `sk-ant-`). A key is **memory only**: no `auth.json`, no sidecar, never written back (the CRM answers 400 `NO_WRITEBACK`), given to each Codex chat as `CODEX_API_KEY` (`credentialEnv()`, `ChatPoolOptions.codexCredential`; the person's own `OPENAI_API_KEY`/`CODEX_API_KEY` and any Claude variable are dropped). A different key, or a change of kind, restarts the Codex chats that hold the old credential (their conversation resumes); a newer revision of the same key does not. A login file of the earlier kind is taken out when the person is moved onto a key (a refresh Codex made meanwhile cannot go back to a subscription that is a key now; that is logged, without the text).
- **How an API key reaches the interactive Codex (checked on Codex 0.163.0, 7 Nov 2026, P1d).** The TUI does NOT read `CODEX_API_KEY` or `OPENAI_API_KEY` (`codex exec` does): with no `auth.json` it shows its sign-in menu whatever the environment holds. So an API-key chat's profile (`chat-<id>.config.toml`, `profileToml` with `keyVar`) names a model provider that reads the key from the environment: `model_provider = "sad-api-key"` and `[model_providers.sad-api-key]` with `name = "OpenAI"`, `base_url = "https://api.openai.com/v1"`, `env_key = "CODEX_API_KEY"`, `wire_api = "responses"`. The key stays in the chat's environment: **in no file and in no log** (no `auth.json` for a key; the profile only names the variable). Seen with `codex -p <profile>` and a FAKE key: no sign-in menu, the request goes to api.openai.com and comes back "401 Incorrect API key". A ChatGPT login's profile has no provider (the login is `auth.json`, as before). Rejected: writing `auth.json {auth_mode: apikey}` (the key would be on disk) and hiding the key kind for Codex chats.
- **REAL API KEY UNTESTED.** Only a fake key has been used. Not yet seen with a real key: the default model on the API (the ChatGPT default, "GPT-6.1-Sol", may not exist there; `codexModel` can name one), usage, the answer. It gets its first real run when a Codex API key is added in the CRM; until then treat an API-key Codex chat as unproven.
- **A running Codex keeps its login in memory** (P1d): it does not re-read `auth.json` while it runs, so a login changed on disk meanwhile is not used until the chat is started again. That is how it is meant to work here: each start places the CRM's copy first (the refresh was seen on a start with an expired login: Codex refreshed by itself, the refresh token rotated, and the new login went back to the CRM at revision 2).
- **Open (P3 polish): the "code mode" `exec` label.** The default model "GPT-6.1-Sol" calls an MCP tool from inside one `exec` custom tool call (JavaScript calling `tools[...]`), so the chat view shows the row as `exec` with the code as its detail, not the tool's name (`floor_roster`). It works; labelling such a row with the tool it calls is later.
- Tests: `claude/kinds.test.ts`, `agentic/chats-credential.test.ts`, `codex/apikey.test.ts`, `codex/home.test.ts` and `agentic/codex-chats.test.ts` (the API-key profile; the key in no file and no log); `test/fake-crm.ts` and `codex/fake.ts` hand out both kinds. `test/codex-real.ts` is the manual run with a real Codex (P1d, 8 steps passed with a real ChatGPT login).

## F-142: switch conversations between Claude and Codex

`codex/from-claude.ts` exports pure `fromClaude(lines, { id, cwd, timestamp, cliVersion? })` and `writeClaudeRollout(lines, home, cwd, now?)`. The writer generates a new UUID and exclusively creates `<home>/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl`, returning `{ id, file }`. `codex/to-claude.ts` exports pure `toClaude(lines, { sessionId, cwd, timestamp, version? })` and `writeCodexAsClaude(lines, projectsDir, cwd, now?)`. Its writer exclusively creates `<projectsDir>/<encodeProjectPath(cwd)>/<fresh sessionId>.jsonl`, with user/assistant message roles, a UUID/parentUuid chain and the session's cwd, timestamp and CLI version. Neither writer reads authentication or configuration; neither changes the source.

`codex/switch-conversation.ts` exposes `switchConversation({ to, file, cwd, codexHome?, projectsDir? })` and the CLI:

```
node agent/codex/switch-conversation.ts --to codex|claude <file>
```

Run from the intended conversation working directory. `CODEX_HOME` selects the Codex destination (default `~/.codex`); `CLAUDE_CONFIG_DIR` selects the Claude config directory (default `~/.claude`, with sessions under `projects`). The CLI prints `{ id, file }`. The earlier one-way CLI remains: `node agent/codex/convert-claude.ts <claude.jsonl> <codex-home>`. Empty/unrecognized histories are conversion failures in the switcher, not successful empty imports.

**Engine changes.** `shared/codex.ts` keeps the existing 409 code and changes its message to say the conversation carries over, the original stays saved, and conversion failure starts a new conversation. The existing `confirmNewConversation` request field remains compatible. `agentic/floors.ts` validates the entire chart before calling the server's carry-over hook. `agentic/index.ts` resolves the old engine's actual transcript, converts it, and binds a fresh app session plus `codexThread` for Codex, or the new Claude `sessionId` for Claude. The next open resumes it. A replaced running chat is stopped. Missing/invalid transcripts, unavailable destination homes and conversations on another PC fall back to the existing empty binding, with a warning explaining why. There is no remote conversion protocol yet. The original file remains readable and untouched.

**Mapping and limits.** Imports preserve user/assistant text and paired tool calls/results. Claude queued prompts are included; Codex custom/function calls become Claude tool_use/tool_result blocks, and Claude tools become Codex custom calls/outputs. Missing tool answers receive a placeholder; orphan outputs become text. Claude images get an omission marker. Thinking, developer instructions, account metadata, sidechains, unknown blocks and malformed lines are skipped. Codex task boundaries are emitted when importing Claude. Lines over 8 MiB are skipped; text/output bodies are capped at 32,000 characters, nested values at 30 levels and arrays at 1,000 entries. Credential-named object fields are removed recursively (including serialized JSON); recognizable inline key/token assignments and bearer/API-key forms are redacted. Arbitrary secrets embedded in ordinary prose cannot be identified reliably. File-based switching streams bounded lines. Claude imports scan for the final main-session system/compact_boundary first, then stream only that context; the pure converter also handles multiple boundaries in an iterable. The following isCompactSummary user message is preserved even when isMeta is true. A 400 KiB serialized rollout budget retains the summary and newest whole turns, with an omission note when turns are dropped; exceptionally large summaries are explicitly shortened. Tool pairs are evicted together with their turn. No whole transcript read or source mutation is involved.

**Tests and acceptance proof.** `codex/{from-claude,to-claude}.test.ts` use invented fixtures only: reader compatibility, round trips, UUID chains, tool pairing, malformed data, redaction, caps, fresh files, CLI destinations and failure cases. `agentic/codex-chats.test.ts` exercises the real API/pool/stores with fake CLIs: confirmed changes in both directions, next-open resume, original-file preservation, and logged fallback when the source is missing. The floor-store tests cover confirmation and validation before conversion.

Localhost-only CLI proof on 7 Nov 2026: installed `codex-cli 0.163.0` ran `exec resume <generated-id>` in a fresh home against a Responses mock. Captured input contained imported user/assistant text and matched custom tool call/output; the CLI completed and appended to the same rollout. Installed Claude Code `2.1.319` ran `--bare --resume <generated-id> --print` against an Anthropic Messages mock using `ANTHROPIC_BASE_URL`, an isolated config directory and a synthetic localhost-only key. Captured input contained imported text and tool_use/tool_result; the CLI completed successfully under the imported id. No real login was read/copied or used, and no paid request was made. These prove CLI restore and serialization, not live provider acceptance of legacy tool names. A real-login check still requires explicit approval first.

### F-142 follow-up: Lead carry-over, MCP approvals and long sends

`from-claude.ts` also exposes `conversationLines`, `claudeFileContext` and `convertClaude`; the latter returns lines and count/byte statistics. File selection uses two bounded passes so obsolete history is never sanitized or accumulated. The CLI and engine switch share this path. Synthetic tests cover multiple and sidechain boundaries, metadata summaries, oversized records, split UTF-8, CRLF, unterminated final records, whole-turn eviction and escaped-text byte budgets.

Each generated `shubham-agentic` MCP profile table now sets `default_tools_approval_mode = "approve"`. Other MCP servers retain their own policy. Codex execution approval_policy and MCP approval modes are separate settings. Installed 0.163.0 rejects invalid values and accepts auto/prompt/writes/approve. A fresh-home localhost Responses + stdio MCP mock proved the interactive distinction: prompt with on-request displayed approval and made zero calls; approve ran the synthetic mutating tool without answering a menu. No real login or paid request was used. Official reference: https://developers.openai.com/codex/config-reference/ .

The Codex sender chunks large writes inside one bracketed paste transaction, checks for the rendered tail (or a collapsed-paste marker), and waits for paste rendering to settle, then presses Enter and checks Working or a completed reply with a visibly empty composer. A missing composer marker is unknown, never proof of submission. It retries Enter at most three times, recognizes subsecond Worked for <1s replies, and never answers a menu. Slow native Windows character input has a bounded drain window (90 seconds, scaling up to five minutes for larger messages); an unsettled paste remains unconfirmed with no Enter. Messages in one chat are serialized through paste, settling and confirmation; an unconfirmed send prevents its already-queued successor from joining its draft. Synthetic tests cover 50 KB drafts, delayed rendering, lost Enters, missing markers, subsecond replies, queues and menus. The existing danger-full-access/never configuration avoids trust and sandbox setup in fresh-home mock runs; no speculative first-run keys were added.

## F-145: Codex thread recovery, onboarding and the F-134 page

The rollout watcher no longer expires after 120 seconds. It keeps retrying while the chat is live and still belongs to the same Codex floor/agent/session binding, stops on discovery or end/replacement, retries transient read errors, and is cancelled on shutdown. Startup scans marked rollouts to backfill null codexThread bindings, including stopped agents; adopted live Codex chats with no rollout yet get a watcher. Starting a null-thread chat also attempts recovery before launching a fresh conversation. No existing non-null binding is replaced. Tests cover a first write after three simulated minutes, end/replacement, transient errors, stopped-agent recovery and delayed adoption.

The shared configuration seeds [windows] sandbox = "unelevated" (the non-admin choice), retaining existing choices. Profiles seed trust_level = "trusted" for the approved cwd and enclosing Git project root, with Windows path case normalization. Rewrites replace app-owned instructions/model/MCP policy but preserve Codex-owned windows, projects and notice tables. The scanner recognizes tables and scalar keys outside quoted/multiline strings and arrays, preserves runtime section contents, and avoids duplicate seed tables/keys. Incomplete TOML is refused rather than silently losing answers. Tests cover repeated starts, profile regeneration, missing answers, saved notices, quoted table/key lookalikes and array tables.

The finished F-134 page work is merged: the per-agent Engine menu has Default/Claude/Codex, engine/model/effort chips follow the engine, Settings > Chats provides Default engine, Codex chats, default Codex model/effort and the agent's plain status reason. Missing older-server support remains handled. Codex status/settings/refresh use the existing agent API; no credentials reach the page. The shared TuneRequest now includes the already-supported Codex fields. The engine dialog and agent-detail hint follow F-142: confirmed switches carry the conversation over, retain the original, and explain the fresh-conversation fallback if conversion is unavailable. The legacy confirmation code/field remain compatible.

The Web delta was identified against C:/saw/f134-new: 15 production/test files plus 7 harness/log files. The latter stay outside the product. shared/agentic.ts was merged additively to preserve today's F-142 confirmation contract. No old backend files were taken from Web's copy. Browser verification uses a separate localhost stand-in and page server at ports 54885/50345, with a fresh headless Edge profile and external requests blocked, at 1280 and 390 CSS pixels. It checks engine options/chips, 409 carry-over confirmation, the confirmation flag, default-engine saving, Codex on/off saving and the status sentence; screenshots are under C:/saw/f145-screenshots. No live app is used.

Installed Codex 0.163.0 also started a fresh synthetic Git repository with the generated trust and Windows settings against localhost mocks, showed YOLO mode without first-run questions, accepted one synthetic message and ran its synthetic MCP tool once. No real login or paid request was used.

## F-146: carried Codex history is visible on resume and keeps its cwd

Codex 0.163.0 has separate model-history and TUI-replay records. Claude imports now write both response_item messages and matching event_msg/item_completed UserMessage/AgentMessage records, with stable message ids, replay content shapes and assistant phase. Each imported turn has turn_context with its cwd; the session header includes session_id, history_mode, runtime workspace roots and the pinned CLI version. Ordinals follow file order. Tool calls/results remain paired model-history records. Compaction selection, secret filtering and the total byte budget apply to the complete output, including replay copies. The app continues reading response_item records, so replay events do not duplicate its messages.

On engine conversion the source chat's running cwd takes precedence, then bounded transcript metadata, then the floor's default. A Codex resume reads its cwd from the saved rollout and uses it for both the profile and process launch. Moving the floor to another folder therefore does not move an existing conversation. Neither the original transcript nor any existing rollout is rewritten. Tests cover conversion with a changed floor folder, stopped-chat metadata recovery, exact resume arguments, HTTP history and WebSocket initial history.

The pinned real CLI was tested against a localhost Responses mock with separate temporary homes and a private copy of a large Claude transcript. The old converter reproduced an empty TUI while its first model request contained all retained messages and tool rows. The corrected converter replayed imported user and assistant history and retained the same complete model context. Only counts, sizes and booleans were reported; no private transcript text, real login, live application or live rollout was used or changed. Reproduction artifacts and the full copy gate are documented outside the product in C:/saw/f146-report.md.

## F-144: personal CRM saved views (extends F-106)

F-106 introduced named Agents window arrangements in browser storage. F-144 synchronizes only those records, separately for PC and phone using the existing usePhone classification. Current windows, floor, focus and live chats stay in their existing local stores; only Open applies an arrangement.

After a successful staff sign-in, auth keeps a CRM-session companion in memory, keyed by the full private app-session hash. The saved-views adapter validates the actual app cookie and the viewer's CRM identity; it never reads the PC owner's CRM session. Expiry, sign-out, revocation and shutdown clear the companion. Restarted agents retain app sessions without CRM companions: VIEW_SYNC_REAUTH_REQUIRED leaves the app signed in and offers the existing sign-in dialog. Cookies and passwords never enter the saved-views cache or responses.

GET/PUT /agent-api/agentic/saved-views/:deviceKind call only the fixed viewer endpoints /v1/org/agentic-views/mine/:deviceKind. Person sessions and normal page/origin guards are required even in an open app or on an exempt phone. PUT acquires the viewer's CRM CSRF pair and retries a CSRF-specific refusal once. CRM stores one global user/device-kind row with strict validation and an atomic revision compare-and-swap; absence is distinct from an intentionally saved empty row. The additive ensure is separate from deployment; unavailable schemas return a typed 503.

The subscription store scopes fallback data and a bounded operation journal by agent origin, CRM origin, person and kind. Edits are immediate; background refresh rebases their preimages over remote snapshots. Disjoint edits merge; changed targets retain remote data and offer Keep mine/Keep remote, with renamed conflict copies getting a fresh UUID. Lost acknowledgements reconcile through GET. Concurrent legacy imports use absence-only revision zero; the losing legacy snapshot stays recovery-only. The old sad-agentic-views bytes are preserved, with the first authenticated claimant owning automatic migration. New anonymous edits require explicit import. Export includes pending intentions and recovery data. Blocked storage uses memory and reports its persistence limitation.

Fake-CRM HTTP tests cover viewer cookies, CSRF, isolated people/kinds, machine/open refusals and reauthentication lifecycle. Pure injected-store tests cover offline changes, races, lost responses, account switches, conflicts, caps and anonymous import. A CRM without views routes returns 404: local editing and pending operations remain available, no bootstrap is attempted, and automatic retries pause. Retry view sync or a new sign-in resumes attempts after deployment. Missing viewer credentials and permission refusals also pause background requests. CRM PGlite tests use production ensure SQL, Drizzle controllers and real Express auth/membership/CSRF middleware. Deployment scripts are review artifacts for Shubham; no live ensure or push is performed by this feature work.
