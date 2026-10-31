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
  - `agent/config.json`: `{ role, name, ports: { peer, api, discovery, hbbs, hbbr }, publicHost, lanAddress?, route, stayReachable }`
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
  page, as Christopher's builds do (so the CRM's weekly caps don't count it).

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
- **F-017, the keyboard by itself** (`agent/screen/text-focus.ts`, `text-focus-worker.ts`): ours,
  not RustDesk's. The viewer sends `Misc.plugin_request` with id `sad.text-focus` and JSON
  `{"watch": true}` (`false` to stop); the app's own screen then answers `{"editable": bool}` at
  each change of "a text box has the keyboard focus here". RustDesk carries plugin messages this
  way and leaves one it has no plugin for alone, so a viewer on RustDesk just never hears back.
  The phone's page asks only while its key row shows, and only through the app's own screen.
  The answer comes from Windows UI Automation (what Windows' own touch keyboard asks):
  `GetFocusedElement`, then its control type and Value pattern; an Edit that isn't read-only, or
  a Document or ComboBox whose value can change (`editableOf`). It runs on its own worker thread,
  polled every 300 ms while any session watches and looked at again 120 ms and 400 ms after each
  mouse button comes up; the thread ends with the last watcher (UI Automation makes Chrome turn
  its accessibility support on, so never longer than needed). The page focuses its hidden
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
  after 5 s.
- **Publish** (`POST /build/publish {skipChecks?}`, the hub only, one at a time): runs Dev's
  `node agent/scripts/publish.ts [--skip-checks]` in Dev, keeps its last 400 lines (colour codes
  stripped) for `GET /build/info`, and reads the published version from its `PUBLISHED <json>`
  line; then checks for itself. `publish.ts`: Dev's commit and changes; `tsc -b`, `oxlint
  --deny-warnings` and the agent's tests; `vite build`; the build in `<state>/publish/stage`
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
