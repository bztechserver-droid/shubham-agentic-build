# Approval devices: recovery from this PC (order o4a52, 4 Nov 2026)

For Web (the Settings › Approval device screen). Types are in `shared/approval-sign.ts`; the agent side is `agent/agentic/approval-recovery.ts`.

## Why

A device's signing key lives in the browser storage of ONE page address. The phone registered at `https://server.tailc768e5.ts.net:5173`; at the new address
(`https://server.tail36192f.ts.net:5173`) it is a stranger. With one device registered there is no bootstrap ("the first device needs no code"), a code needs a
signature, and removing a device needs a signature: he is locked out. Every program on the PC (the agents too) can use the page's token, so a request is never proof.

## The way back in

A **Windows administrator (UAC) prompt on the PC the hub runs on**. Agents run un-elevated and cannot answer it (secure desktop). The person must be at that PC (or
on a remote screen of it). Where the hub is not Windows: `supported: false` with `why` (Linux: "not built yet, pkexec later").

```
Use this PC to add a device  ──start──▶  [UAC prompt: "reg.exe", Microsoft Windows]  ──Yes──▶  "Finish"  ──▶  a 6-digit code  ──▶  register (the usual way)
```

## Routes (all under `/agent-api/agentic`, all human-only: a chat's key is refused with 403)

| Route | Body | Answer |
|---|---|---|
| `GET /approvals/devices/recover` | – | `RecoveryAnswer` |
| `POST /approvals/devices/recover/start` | `{}` | `RecoveryStarted` = `RecoveryAnswer` (state `waiting`) + **`ticket`**. Opens the prompt on the hub PC and returns at once; it does not wait for the answer. |
| `POST /approvals/devices/recover/finish` | `{ ticket }` | `RecoveryFinished` = `DevicesAnswer` + `{ code, expiresAt }` |
| `POST /approvals/devices/register` | `{ name, jwk, code, origin }` | as before; `origin` is new (below) |

```ts
type RecoveryState = 'none' | 'waiting' | 'ready' | 'declined' | 'failed' | 'expired' | 'used'
interface RecoveryAnswer { supported: boolean; why?: string; state: RecoveryState; startedAt?: string; expiresAt?: string; detail?: string }
interface RecoveryStarted extends RecoveryAnswer { ticket: string }
interface RecoveryFinished extends DevicesAnswer { code: string; expiresAt: string }
```

### The ticket (closes a race)

After he says Yes, any program that shares the page's token could call finish first, take the code and register itself. So **`start` returns a random one-time `ticket`, in that answer only**
(`GET .../recover` and the log never show it), and **`finish` must send it back** (`{ ticket }`, compared in constant time). A program that wants to finish must therefore have called start itself, and then
he sees a prompt he did not ask for. A missing or wrong ticket is **403 and that recovery is over** (state `failed`; the right ticket afterwards is too late: start again).
**The page keeps the ticket in memory only** (a variable or React state; never `localStorage`, `sessionStorage`, the URL, or the console), uses it for Finish, and drops it when the recovery ends.
A page reload loses it: the person starts again (the old prompt, if still open, simply expires).

### What the page does

1. Show **"Use this PC to add a device"** when the device list is not empty (when it is empty, the old bootstrap code button is all that is needed). If `supported` is false, show `why` and nothing else.
   **Before pressing Start the page must say, up front:** *"Windows will ask: "Do you want to allow Registry Console Tool (Microsoft Windows) to make changes?" on the PC the app runs on. Click Yes only if you started this yourself, just now. If you did not, click No."*
2. **Start** → keep the `ticket` in memory, and say: *"A Windows administrator prompt has opened on the PC the app runs on. Answer Yes there. (5 minutes.)"* Poll `GET .../recover` about every 1.5 s.
   - `waiting`: keep saying it. `declined`: *"The prompt was answered No."* `failed`: show `detail`. `expired`: *"The 5 minutes are over."* Offer Start again.
   - `ready`: enable **Finish**.
3. **Finish** (send `{ ticket }`) → the answer has `code` (6 digits, 5 minutes, ONE use, exactly like the first device's code). Register THIS browser with it at once: the existing register call, with `origin: location.origin`. No second screen is needed.
4. After registering, the new device can sign, so removing the dead one is the usual signed **Remove**; there is no unsigned removal.

### Errors (HTTP status, words are in the body's `error`; show them as they are)

| Status | When |
|---|---|
| 501 | not built for this system (Linux, macOS) |
| 409 | start: a prompt is already open. finish: nothing started / prompt still open / declined / failed / expired / already used |
| 429 | start: asked again within 30 s, or more than 5 times in an hour |
| 403 | finish: the ticket is missing or wrong (that recovery is over), or the administrator step left no proof (then start again) |

## `origin` on a device (for showing, never for deciding)

`register` takes `origin: location.origin` in its body. The remote gate rewrites the `Origin` HEADER to its own loopback value, so the agent cannot see the page address
any other way. The agent keeps it if it is a plain `http(s)://host[:port]` (at most 200 characters), else drops it; a real header is used only as a fallback and never the gate's
`http://127.0.0.1:4740`. `ApprovalDevice.origin?: string` is in `list()` and in `approval-devices.json`; it is absent for devices registered before (e.g. "My phone").
Suggested: show it under the device's name; for a device whose origin differs from `location.origin`, a quiet note *"Registered from another address: it can only sign there."*

## Safety, and what is left

- The proof is a one-time random token in the agent's memory (5 minutes) that an **elevated Windows `reg.exe`** writes to `HKLM\SOFTWARE\ShubhamAgentic` (value `ApprovalRecovery`), a place only an administrator can write. Finish accepts only if the value equals the token and is under 5 minutes old, and spends it. A stale value in the registry is useless.
- Nothing starts it but the start route. No unsigned removal, no "this PC is trusted" shortcut. Every step goes in the approvals log, with "after a Windows administrator prompt".
- An agent cannot flood prompts: one at a time, 30 s apart, 5 an hour.
- **The one thing that remains:** if the person answers an unexpected UAC prompt Yes, the program that asked for it (it holds the ticket, having called start) can then finish and register itself. The prompt reads "Registry Console Tool, Microsoft Windows" and the page says up front what it is for and that Yes is only for a recovery he started; do not teach him to click Yes on prompts he did not start.
