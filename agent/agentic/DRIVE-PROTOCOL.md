# Common Drive: protocol (F-097)

Status: **draft 1, 2026-11-03 (Connection)**. Part A is what the Drive page, the Settings page and the phone's browser use. It is fixed
enough to build on: later drafts only ADD fields and routes. Parts B to D (WebDAV, sync, Google backup) are summaries for now.
The types are in `shared/drive.ts` (types and pure helpers only; import them, don't copy them).

## 0. What it is

One pool of files on the server (the hub), in `C:\Common Drive` (a setting; Linux: any folder). Every device sees the same pool:

- the **Drive page** (web app and the phone's browser) through the agent's API (part A);
- **WebDAV** from any file manager, Finder, Explorer, a phone file app (part B);
- a real **sync folder** kept in step on a PC or a Linux machine (part C);
- a copy in **Google Drive** (part D).

All of it is Node, with no Windows-only calls, so it behaves the same on Windows and Linux. WinFsp is NOT used.

```
C:\Common Drive\
  files\      the pool itself: what people see
  .bin\       deleted things, 30 days
  .versions\  the last 5 earlier contents of each file
  .stage\     uploads in progress (resumable)
  .meta\      rev counter, changes journal, devices (hashes only)
```

## 1. Rules the store enforces (the same on every way in)

- **Paths** are `/`-separated, relative to `files/`, no leading slash (`""` is the root). Names are stored in Unicode NFC.
- **A name** is 1 to 255 UTF-8 bytes, a whole path at most 240 characters. Refused (400 `badname`):
  control characters; any of `< > : " / \ | ? *`; a trailing dot or space; `.` and `..`; and the Windows device names `CON PRN AUX NUL COM1-9 LPT1-9`
  (with or without an extension, any case). So a file made on Linux can always be opened on Windows.
- **Case**: two names in one folder that differ only in case (`Report.doc`, `report.DOC`) are refused (409 `case`). The same exact name is
  the same file.
- **Real paths**: the store resolves every path to its real location and refuses any that leaves `files/` (`..`, a symlink, a junction): 400 `badname`.
  The store never creates a symlink and never follows one.
- **Quota**: the pool's limit is a setting (default 100 GB). Bin and versions count toward it. A write that would pass it, or leave the server's
  disk with under 20 GB free, is refused 507 `quota` ("The Common Drive is full (100 GB)."), and what was already stored is untouched.
- **Delete is never permanent from a normal call.** `delete` moves to the Bin (30 days, a setting). Only `bin/purge` and the 30-day sweep remove for good.
- **Overwrite keeps the old content** in `.versions` (the last 5, a setting) before the new one is in place. A write never half-replaces a file:
  it is built in `.stage` and moved into place in one step.
- **Conflicts never lose anything** (see `mode` below).

## 2. Part A: the page API

Base: `/agent-api/agentic/drive`. Guarded like every `/agent-api` route (a page on this PC with `x-sad-token`, which the web app's proxy adds,
the same on the phone through the remote gate). On a member PC (the laptop) the same routes answer, and the agent forwards to the hub:
the page never needs to know. Errors are JSON `{ "error": "<words for a person>", "code": "<slug>" }` with the HTTP status.
`code` is one of `badname case exists notfound notempty etag offset quota range disabled busy`.

An **Entry**:

```json
{ "name": "plan.pdf", "path": "Projects/plan.pdf", "kind": "file", "size": 12345, "mtime": 1793600000000, "etag": "3039-18c1f2a3b00", "mime": "application/pdf" }
```

`kind` is `"file"` or `"dir"` (a dir has `size: 0`). `etag` is opaque; only compare it for equality. `mtime` is ms since the epoch.

### Browse

| Call | Answer |
|---|---|
| `GET /status` | `DriveStatus`: `{ enabled, root, limitBytes, usedBytes, binBytes, versionsBytes, diskFreeBytes, rev, pieceBytes, binDays, versionsKept, webdav: {enabled, url}, backup: {...}, now }` |
| `GET /list?path=&cursor=&limit=` | `{ path, entries: Entry[], next?: string }`. Folders first, then files, names A to Z (case-insensitive). `limit` default 500, at most 2000; pass `next` back as `cursor`. 404 `notfound` when the folder isn't there. |
| `GET /stat?path=` | `Entry` |
| `GET /search?q=&limit=` | `{ entries: Entry[] }` by name, case-insensitive, whole pool, at most 200 |

### Download (streamed, not JSON)

`GET /file?path=...` is the bytes. `HEAD` works. It honours `Range: bytes=a-b` (206, `Content-Range`, `Accept-Ranges: bytes`), sends `ETag`,
`Last-Modified`, `Content-Length`. `&download=1` sets `Content-Disposition: attachment`. Without it a picture, a PDF or text is `inline`; anything else is
`attachment`; always `X-Content-Type-Options: nosniff`. An SVG or HTML file is always `attachment` (they can carry script).
`GET /file?path=...&version=<id>` is an earlier version (see Versions).

### Upload (resumable, in pieces)

For any size. Pieces are raw bytes (`application/octet-stream`), not JSON.

1. `POST /upload` `{ "path": "Projects/plan.pdf", "size": 1048576000, "mode": "create", "baseEtag"?: "...", "modified"?: 1793600000000 }`
   gives `{ "id": "u_...", "pieceBytes": 4194304, "received": 0 }`. The quota and the name are checked here, so a refused upload fails at the start.
2. `PUT /upload/<id>?offset=N` with the piece as the body (at most `pieceBytes`). `offset` must equal `received`; answers `{ "received": N+len }`.
   A wrong offset is 409 `offset` with `{ "received": <real> }`: carry on from that.
3. `POST /upload/<id>/commit` gives `{ "entry": Entry, "conflict"?: { "copyOf": "Projects/plan.pdf" } }`. The size must match what was announced.
4. `GET /upload/<id>` gives `{ id, path, size, received }` (to resume after the tab or the app was closed; an upload is kept 24 h).
5. `DELETE /upload/<id>` drops it.

**Small files**: `PUT /file?path=...&mode=...&baseEtag=...` with the whole body (at most 8 MiB) is one call and does steps 1 to 3. Answers the same as commit.

**`mode`** says what happens when the name is already taken:

| mode | when `path` exists |
|---|---|
| `create` (default) | 409 `exists`, nothing written. The page asks the person |
| `overwrite` | replaced; the old content goes to `.versions` |
| `keepboth` | saved as `plan (2).pdf` (`(3)`, ...), `entry` is the new name |
| `ifmatch` | needs `baseEtag`. If it equals the file's etag: replaced, old to `.versions`. If not (someone else saved meanwhile): the upload is saved as `plan (conflict - <device> 2026-11-03 14.05).pdf` beside it, `conflict` is set, and both files are kept |

The page uses `create` and, after the person chooses, `overwrite` or `keepboth`. Sync clients and editors use `ifmatch`.

### Change the pool

| Call | Body | Answer |
|---|---|---|
| `POST /mkdir` | `{ path }` | `Entry`. A folder already there is not an error (answers its Entry); a file with that name is 409 `exists` |
| `POST /move` | `{ from, to, mode?: "create"\|"overwrite"\|"keepboth" }` | `Entry`. A rename and a move are the same call. A folder moves whole. |
| `POST /copy` | `{ from, to, mode? }` | `Entry`. Files and folders; counts toward the quota |
| `POST /delete` | `{ path }` | `{ binId, bytes }`. A folder goes whole, as one Bin item |

### Bin

| Call | Body | Answer |
|---|---|---|
| `GET /bin` | | `{ items: BinItem[] }`: `{ id, name, path, kind, size, deletedAt, deletedBy, expiresAt }`; `path` is the full original path INCLUDING the name (`Projects/plan.pdf`); `name` is its last part |
| `POST /bin/restore` | `{ id, to?: path }` | `Entry`. Goes back where it was; if that name is taken it comes back as `name (restored).ext` |
| `POST /bin/purge` | `{ id }` or `{ all: true }` | `{ freedBytes }`. Permanent. The page asks first |

### Versions

| Call | Body | Answer |
|---|---|---|
| `GET /versions?path=` | | `{ versions: Version[] }`: `{ id, size, savedAt, replacedBy }`: only EARLIER contents, newest first. The current one is the file's Entry |
| `POST /versions/restore` | `{ path, id }` | `Entry`. The current content becomes a version first |

### Settings

`GET /settings` and `PATCH /settings` with any of: `{ enabled, limitBytes, binDays, versionsKept, webdavEnabled }`. Answers the whole `DriveSettings`.
Lowering the limit under what is used is refused (409 `quota`), never deletes. Changing `root` is not offered on the page; it's a file in the agent's state folder.

### The changes feed (stay in step without reloading)

- Every change to the pool (put, mkdir, move, delete, restore, version restore, purge) gets the next number, `rev`, which only goes up.
- `GET /changes?since=<rev>&limit=500&wait=25000` gives `{ rev, changes: Change[], reset?: true }`. `Change` is
  `{ rev, op: "put"|"mkdir"|"move"|"delete"|"restore"|"purge", path, from?, entry?, by, at }`.
  With `wait` the call holds up to that many ms until something new arrives (long poll, works through any proxy).
  `reset: true` (no `changes`) means `since` is older than the journal keeps (the last 10 000 changes or 7 days): list again.
- `GET /ws` is the same as a push: text frames `{"t":"rev","rev":N}` whenever it moves, and it answers `{"t":"ping"}` like the other sockets.
  Re-fetch `changes?since=` on each frame, and again after every reconnect. Use the shared reconnecting socket helper (F-057).
- `by` is the device name: a paired PC's name, the Phone/Web label the page sends in the header `x-drive-client` (at most 40 characters), or this PC's name.

### What the page should show

Used / limit (`usedBytes`, `limitBytes`), the Bin separately (`binBytes`), `rev` to know it is live, and on a quota error the text in `error`.
Upload progress is `received / size`; a failed or closed upload resumes from `GET /upload/<id>`. Save the `id` with the file name in the page's own
state (the upload outlives the page for 24 h).

## 3. Part B: WebDAV

The hub serves WebDAV on the store with the same rules as the page: DELETE goes to the Bin, an overwrite keeps a version, a stale save (`If-Match`) is kept
beside the original as a conflict copy, names are checked the same way. Class 1 + 2 (locks are advisory: a token is handed out so Finder and Office will write).
It is a listener of its own on this PC's loopback (`127.0.0.1:21280`), **off until `webdavEnabled` is switched on**, and it signs devices in by name and drive password.
Reaching it from another device is a second switch: `tailscale serve` puts `https://<this machine>.<tailnet>.ts.net:8444/dav/` in front of it (tailnet only, never funnel,
never ports 80, 443, 4740, 8443, 21229). Every request that comes through serve must carry the OWNER's Tailscale login; a program on this PC (no Tailscale headers) is the
only other way in. Windows' own client refuses a password over plain http, so a Windows PC maps the https address.

Page calls (same guard and base as part A; types in `shared/drive.ts`):

| Call | Body | Answer |
|---|---|---|
| `GET /webdav` | | `DriveWebdav`: `{ enabled, running, port, localUrl, tailnet: {available, serving, httpsPort, url?}, devices: [{name, createdAt, lastUsedAt?}], error? }` |
| `PATCH /settings` | `{ webdavEnabled: true }` | starts or stops the listener (stopping also removes the tailnet address) |
| `POST /webdav/devices` | `{ name }` | `{ name, password }`: the password is shown ONCE; only a salted hash is kept. A name that exists gets a new password |
| `POST /webdav/devices/revoke` | `{ name }` | `DriveWebdav`; that device is out at once |
| `POST /webdav/tailscale` | `{ on: boolean }` | `DriveWebdav`. **Do not call this until Lead has approved the one real serve entry.** 409 `disabled` if WebDAV is off or Tailscale is not running |

**The remote gate does not share this listener.** The phone gate (christopher-remote, `proxy.mjs`) publishes every new loopback listener of a dev program to the tailnet by itself.
Port 21280 is in its `neverShare` list (`C:\Users\Shubham_server\christopher-remote\ports.json`, added 2026-11-03; the original is `ports.json.bak-2026-11-03`), so the one way in from
the tailnet is the `tailscale serve` entry on 8444, which carries the owner's Tailscale login and then the device password. Checked on 2026-11-03: a probe on 21280 and a
control port were started together; the gate shared the control and not 21280. If the listener's port is ever changed, add the new port to `neverShare` too.

What a client maps: Windows "Map network drive" `https://<name>:8444/dav/`; GNOME Files / Dolphin `davs://<name>:8444/dav/`; Finder "Connect to Server" `https://<name>:8444/dav/`;
user = the device name, password = its drive password. WebDAV clients see the pool's free room on the top folder (`quota-available-bytes`).

## 4. Part C: the sync folder

A real folder on a PC kept in step with the pool, both ways. Plain Node, no native parts, the same on Windows and Linux.

**The rules** (the same as the store's, so nothing is lost):
- A change on one side goes to the other. A change on both: BOTH are kept: the other device's version stays, this device's is saved beside it as
  `name (conflict - <device> <date time>).ext`, and then the pool's comes down.
- A delete travels only for a file both sides had in step (it was synced) and that the other side has not changed since. It goes to the pool's Bin (30 days), or
  to a local sync trash (`<state>/trash`); never for good. A file nobody had synced is never deleted. A folder is removed only when it is empty.
- Brakes: a round that would delete more than 20 files and more than 20% of what was synced is held (nothing is deleted; the status says so) until a person says go
  (`--allow-deletes`, or the page). A folder that looks empty although it had files (a drive that is not mounted), a folder that has vanished, or a pool that
  looks empty although it had files, stops the round.
- Left alone: Office scratch files (`~$*`), `Thumbs.db`, `desktop.ini`, `.DS_Store`, `*.tmp`, `*.part`, links; and names the pool refuses (reserved, bad characters,
  two names that differ only in case): they are listed in the report with the reason.
- It remembers what both sides agreed on in `<state>/sync-state.json`, and the change number it has read up to; offline, it catches up from there. A failed file, or a
  delete the brake held, keeps the number back so it comes round again.

**Reaching the pool**
- On the hub itself: the store, in this process.
- On another PC: the drive listener's `/api` over HTTP (the page's routes for files, minus settings, the Bin, versions, search and devices) with Basic auth
  (device name + password), `https://<hub>.<tailnet>.ts.net:8444` through `tailscale serve`, same owner check as WebDAV. Uploads go in 4 MiB pieces, a lost piece is retried
  after asking the server where it is.
- A PC that runs the app (the laptop) uses the Agents member link instead: one JSON line each way, files in pieces of 512 KB. The hub runs the same store calls as for any other
  device, with the member's name (from the link, never from the request) as who did it. Only the calls a sync folder needs exist on that link (rev, changes, list, stat, read, upload start / piece /
  commit / abort, mkdir, remove): no settings, Bin or device calls.

**The sync folder of THIS PC, from the page** (works on the hub and on a member PC, each for its own PC; the hub's own folder is kept in step straight from the store):

| Call | Answer |
|---|---|
| `GET /sync/local` | `DriveLocalSync`: `{ available, reason?, enabled, folder|null, suggestedFolder, state: "off"|"idle"|"syncing"|"offline"|"blocked"|"stopped", lastOkAt|null, error|null, report: {uploaded, downloaded, conflicts, deletedLocal, deletedRemote, held, blocked, errors[]}|null }` |
| `PATCH /sync/local` | `{ folder?: string|null, enabled?: boolean }` chooses the folder and/or switches it on or off. A folder that would do harm is refused with the reason: not a whole path, a whole drive, the home folder, a folder that holds the home folder, a file, or the folder where the Common Drive itself is kept. Switching it on needs a folder first. |
| `POST /sync/local/run` | one round now; answers `DriveLocalSync` (409 `disabled` when it is off, or the hub can't be reached) |
| `POST /sync/local/allow-deletes` | confirms the deletes the brake held; answers `DriveLocalSync` |

A different folder starts clean (its own record of what was synced) and deletes nothing on its account; the old folder is left as it was. Off, the folder is left alone. It starts again by itself after a restart of the agent.

**Pairing** (no password typed anywhere): the page asks `POST /sync/pair` `{ name }` and gets `{ name, code: "ABCD-2345", expiresAt }` (good once, for ten minutes; needs the
"other devices" switch on, the same as WebDAV). The device hands it in: `POST <server>/api/pair` `{ code }` gives `{ name, password }`, that device's own password.
Five wrong codes from one address, then a ten-minute wait.

**The program for another PC**: one file, `common-drive-sync.mjs` (built from `agent/drive/sync-cli.ts`; Node 20.3 or newer):
```
node common-drive-sync.mjs pair --server https://<hub>.<tailnet>.ts.net:8444 --code ABCD-2345 [--folder ~/CommonDrive]
node common-drive-sync.mjs run      # keep in step until stopped
node common-drive-sync.mjs once     # one round, print what it did
node common-drive-sync.mjs unit     # print a systemd user unit (Linux): save as ~/.config/systemd/user/common-drive.service, then systemctl --user enable --now common-drive
```
The password is kept in the program's config file (`~/.config/common-drive/config.json`, `%APPDATA%CommonDrive` on Windows), readable by that user only, and is never printed.

## 5. Part D: the backup (Google Drive)

The pool stays on the server. A one-way copy follows it into a folder called "Common Drive" in Google Drive (the account whose keys are in the secrets folder), within about
a minute of a change settling, plus a full check at 03:00 every night. **Off until `backupEnabled` is switched on** (settings, default false).

- **What is copied**: every file and folder, with the file's modified time. Each Google file carries `appProperties` (`path` in the pool, `etag`), which is how the nightly check finds what
  is there with one list call and what is out of date. An overwrite in the pool updates the same Google file (Google keeps its own revisions).
- **Deletes**: a delete in the pool takes the COPY to Google's trash (never for good). More than 20 at once and over 20% of the copy is HELD: nothing is removed until a person says
  `POST /backup/allow-deletes`. Copies in Google that are not in the pool are counted ("extra") and left alone.
- **The keys** (F-125): two Google accounts, picked by the setting `googleSource`. `company` (the default) is bztech68, the account the CRM uses: its keys are the file
  `<agent state>/secrets/gdrive-bztech68.env` (GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN), put there by `POST /backup/import-keys` (the Import button) from
  the CRM backend's own `.env`: only those three keys are read and kept (GDRIVE_PUBLIC, the folder id and everything else are not), the file is locked to the user before the keys
  are written, and the answer shows only "set" or "missing". `shubhambhole68` is Shubham's own account, the old way, read (never copied) from his Desktop: `gdrive-shubhambhole68.env`,
  `auth secret.json` or Google's `client_secret*.json` (a client JSON gives the id and secret, an env file the refresh token; they fill in for each other), then the old
  `secrets/gdrive-shubhambhole68.env`. A key is read only when an access token is needed, held in memory for that token's life, and never logged, shown, or put in an answer.
  The backup uses its own private "Common Drive" folder in that account, never the CRM's folders, and sets no sharing. When Google refuses a refresh token the page says to
  make a new refresh token for that account (one consent run).
- **No keys**: the same copy goes into a folder instead (`G:My DriveCommon Drive`, Google Drive for desktop's own folder, when it exists). A copy removed from the pool is moved to
  `_removed/<time>/` beside it. With neither, the page is told "nowhere to copy to".

| Call | Answer |
|---|---|
| `GET /backup` | `DriveBackupInfo`: `{ state: "off"|"idle"|"copying"|"error", lastOkAt?, pending?, error?, target: "Google Drive"|"the folder …"|null, keys: boolean, fallbackFolder: string|null, held? }` |
| `PATCH /settings` | `{ backupEnabled: true|false }` starts or stops it |
| `POST /backup/run` | the full check now; answers `DriveBackupInfo` (409 `disabled` while off) |
| `POST /backup/allow-deletes` | confirms the held removals and does them; answers `DriveBackupInfo` |
| `GET /status` | its `backup` field is `{ state, lastOkAt?, error? }` |

## 6. Part E: uploads from the phone (the Chris share target)

"Share → Common Drive" from any Android app. The phone has no app token, only its **device key** (the one `POST /voice/pair` gave it). These routes take that key and nothing else.

Base: `/agent-api/agentic/drive/phone`. Every call carries `Authorization: Bearer <device key>`; the app token is neither needed nor looked at, and the page's own routes (`/list`, `/file`, …) refuse a device key.
A browser page (any `Origin` header) is refused 403; a missing, wrong or revoked key is 401. **Files only**: a phone can put files into its own inbox in the pool and nothing else: no list, no download,
no delete, no Bin, no settings, no devices, no overwrite.

- **Where it lands**: `Phone/<device name>/<dir?>/<name>` in the pool (`<device name>` is the name the phone gave when it paired, made safe for a folder name; two phones with one name share a folder).
  The device is named from its KEY, never from the body: a `by`, `device` or `path` field in a body is ignored.
- **A name that is taken is never overwritten**: the new file is saved as `name (2).ext`. The reply says the path it really got.
- **Why JSON with base64, not raw bytes**: the agent's streamed device-key routes are an allow-list for GET/HEAD only. Pieces of 512 KiB in JSON (a third bigger) need nothing new in the guard; a raw PUT can be added later if speed asks for it.
- Errors are JSON `{ "error": "<words for a person>" }` with the HTTP status (this route has no `code`). Statuses: 400 bad name / bad body, 401 key, 403 Origin, 404 no such upload, 409 the drive is off / wrong offset / too many open uploads,
  413 a piece or a file too big, 507 the Common Drive is full.

| Call | Body | Answer |
|---|---|---|
| `GET /phone/status` | | `{ device: "Fold", inbox: "Phone/Fold", pieceBytes: 524288, maxFileBytes: 4294967296, freeBytes, open: [{id, path, size, received}], dirs: ["Trip", …] }`. `freeBytes` = what the pool still has room for. `open` = this phone's uploads still in progress (kept across a restart of the hub), so a phone that lost its own record can resume or drop them. `dirs` = the sub-folders of this phone's inbox, one level, newest first, at most 20 (what a share could go into; `[]` before the first share) |
| `POST /phone/upload` | `{ name, size, dir?, modified? }` | `{ id, path, pieceBytes, received: 0 }`. `name` is one file name (no slash); `dir` an optional sub-folder of the inbox (up to 3 levels, same name rules as the pool); `modified` ms since the epoch, kept on the file. 507 now if it can't fit |
| `POST /phone/upload/<id>/piece` | `{ offset, data }` | `{ received }`. `data` is base64 of at most 512 KiB; `offset` must equal `received` (else 409 "Expected the next piece at N": ask `GET /phone/upload/<id>` and carry on from there) |
| `GET /phone/upload/<id>` | | `{ id, path, size, received }` (to resume after the app was closed; an upload is kept 24 h) |
| `POST /phone/upload/<id>/commit` | | `{ entry: {name, path, size, mtime, etag, mime}, renamed: boolean }`; the size must match what was announced |
| `POST /phone/upload/<id>/abort` | | `{ ok: true }` |

At most 8 uploads open per phone at once (409 beyond; the count is the uploads in its inbox, so it survives a restart of the hub and a phone that lost its record can drop them from `open`). An upload belongs to the phone that started it: another phone's key gets 404 for its id.

**A share, step by step** (what Chris does): `POST /phone/upload` with the file's name and size → loop `POST …/piece` with the next 512 KiB until `received == size` (after a network error: `GET /phone/upload/<id>`, carry on from `received`) →
`POST …/commit` → show `entry.path`. The upload is also what shows on the Drive page and in the sync folders, within seconds (it is a normal change in the pool, labelled with the phone's name).

## 7. What is live

**Live in Dev since 2026-11-03 (merged, not published): all of part A.** status, list, stat, search, file (GET/HEAD/PUT, Range), upload (start, pieces, info, commit,
abort), mkdir, move, copy, delete, bin (list, restore, purge), versions (list, restore, `file?version=`), settings (GET/PATCH), changes (long poll) and `/ws`.
The drive is on by default and opens on first use (no folder until a call needs it); WebDAV is off. If a shape in `shared/drive.ts` needs to change, tell me before you depend on it.
Not yet: parts B to D (WebDAV, sync, Google backup), and on a member PC (the laptop) every call answers 409 `disabled` until the sync part lands.
