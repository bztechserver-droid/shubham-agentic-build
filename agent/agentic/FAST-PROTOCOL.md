# The fast Assistant: stream contract (F-086 / F-087, slice 1)

Owner: Overlay. Code: `shared/fast.ts` (types and the checker for what a client sends, with tests). This file is the words.
Built and live since 3 Nov: the hub's side is `agent/agentic/fast.ts` (the session) and `fast-host.ts` (the warm process), wired in `index.ts`;
the web page (`src/assistant/`, `shared/assistant.ts`) and Chris (`mobile/`) speak it. F-221 (order ob98a, 14 Nov) added live talk's frames and
routes (the hold latch, tap-to-send cards, the direct line): see "Live talk" below.

## Names

- **Assistant** = the new, very fast agent (Haiku by default, Sonnet when he asks for a thorough answer). Opens with Alt+K on the web, "Hey Chris" and every entry in Chris.
- **Orchestrator** = today's overlay chat (floor "Assistant", agent "Assistant" on disk). Until he says to flip, labels follow the Settings choice (Old / New); identity on the hub is the `role` field (Connection), not the name.

## Two sockets, one set of frames

| Who | URL | Auth |
|---|---|---|
| web page | `/agent-api/agentic/fast` | the app token (as every page socket); same origin |
| Chris | `/agent-api/voice/fast` (`B/fast`) | a device key in the handshake, no Origin (as `/voice/live`) |

One JSON object per WebSocket text message, at most 12 KiB. Anything not understood gets an `error` frame (the socket stays), except the key/origin
checks, which refuse the handshake. If the hub has no Assistant (off, or an old hub) the handshake is refused with 404: the client falls back to its
old way (the web opens the Orchestrator panel; Chris uses `/voice/ask`).

## hello: is B/fast on? (Chris)

`GET /voice/hello` carries a top-level field `fast: {ready: boolean, model?: 'haiku'|'sonnet'}` (`shared/fast.ts` `FastHello`, built by `fastHello`).
`ready` is JSON `true` only while the Assistant is switched on and `/voice/fast` serves (a cold, idle process counts: the first `start` wakes it; `paused` for low memory counts, asks then go to the Orchestrator). It is `false` when the Assistant is off, or its process cannot start (`unavailable`). `model` = the model it will use now; it is left out when unknown.
A hub without the Assistant has no `fast` field at all. Chris opens `/voice/fast` and sends fast asks only while the last hello had `fast.ready === true` (nothing else counts); no field, not-true or no hello yet = never B/fast; a 404 on the socket stays the second fallback. Chris reads hello at every start and every conversation start. The hello also has `names` (`'old'|'new'`).

## Client → hub

| Frame | Meaning |
|---|---|
| `{t:'start', client:'web'\|'phone', id, model?, resume?}` | Claim the Assistant. `id` = a tab id or the device id. One owner at a time: a second `start` takes it, the first gets `state taken-over` (and loses its cards). `resume:true` (a reconnect) never takes it from another owner, and (F-221) holds as this `id` held before the blip, so the asks a client sends right after it are held too; a resume only ever raises hold (it is on if this `id`'s hold is on, or the connection holds already), never lowers it, and the resuming connection owns that hold from then on. A plain `start` begins with this connection's hold off and leaves the `id`'s hold as it is. A client sends `hold` right after every `start`, a resume included (a hub that restarted remembers no hold). |
| `{t:'ask', id, text, via:'voice'\|'typed', thorough?, heard?}` | A question or an order, up to 2000 characters. `id` is the client's (1–64 of `A-Za-z0-9_.:-`, never starting `o:`). `via:'voice'` = answer for the ear. `thorough:true` = Sonnet for this turn. A new ask while one runs cuts the old one off (`done {cancelled:true}`). `heard` (F-221, at most 600 characters, tidied to one line) = the part of the previous answer he actually heard before he cut in: the Assistant carries on from there, and its history keeps that answer as cut off. |
| `{t:'cancel', id}` | Barge-in: stop turn `id` now. F-221: also `o:<orderId>`, the hub's turn that tells a hand-off's answer, but only one told on this connection and still running. |
| `{t:'stop'}` | Done: release the Assistant (the hub keeps the process warm for a while). F-221: this connection's cards are dropped, and its hold ends (End), the `id`'s too when this connection owns it. |
| `{t:'ping'}` | Answered with `pong`. |
| `{t:'hold', on}` | F-221: this connection's HOLD latch (`on` is true or false). While it is on and this connection owns the Assistant, EVERY hand-off made during its asks becomes a card (never typed). Live talk sends `hold {on:true}` right after `start`. T4: the Alt+K bar and Live talking classic send `hold` right after EVERY `start` (the first, a reconnect's, the one that takes the Assistant back), `on` as Settings › Assistant › Spoken hand-offs says: Tap to send (the default) `true`, Send at once (the old way) `false`; the bar also sends it at once when he changes the setting. Review of T4: `true` only where the cards are drawn (`shared/assistant.ts` `TAP_CARDS_DRAWN`), so no hand-off waits on a card nobody sees; T4 phase 2 draws them with live talk's TalkCard (in the bar, and in a panel at the foot of the classic page, each keeping its own link's `card` / `card-gone` frames), so "Tap to send" holds and the setting is shown. The hold is also kept per `id` (sticky, for a reconnect on a new socket): `on:true` makes this connection its owner; only the owner's `on:false` or `stop` clears it, never another connection with the same `id` (its plain `start`, its own `hold {on:false}`, its `stop`). |
| `{t:'drop', card?}` | F-221: drop one card of this connection (`card` = its id), or all of them (a stop word, a change of mind, End). |

Every field is checked: anything else in a frame (a wrong type, an unknown `t`) is refused with an `error` frame and one plain sentence; unknown extra fields are dropped.

A cold process: while the Assistant is switched on but has no process yet, the first `state` on connect says `ready` (as hello says); `start` owns it at once and wakes the process (`state starting`, then `ready`). An `ask` sent right after `start`, or while `starting`, is not refused: it waits for ready and then runs (if the start fails it gets a 503 with the reason, and the client gets `state paused`). A process that idled out while the client still owns it is woken by its next ask.

At most 30 asks a minute per client (then an `error` 429 frame).

## Hub → client

| Frame | Meaning |
|---|---|
| `{t:'state', state, reason?, model?, holds?}` | `off, starting, ready, unavailable, paused, taken-over, stopped`. `paused` = memory is low: asks go straight to the Orchestrator. `reason` is one plain sentence. Sent on connect and on every change. F-221: `holds: true` on every state frame of a hub that can hold hand-offs as cards; a page offers live talk only then ("Update the app first" otherwise). |
| `{t:'delta', id, text}` | Answer text as it streams: speak it as it arrives. |
| `{t:'flush', id}` | A boundary (end of a text block): speech may start for what is queued. |
| `{t:'tool', id, name, label}` | The Assistant uses a tool; `label` is short ("Opening that"). Show it or say it. |
| `{t:'done', id, text, ms?, costUsd?, cancelled?, ttftMs?}` | Turn over; `text` is all it said. `ttftMs` = from the turn being written to its first word. |
| `{t:'error', id?, status, message}` | One plain sentence. |
| `{t:'handoff', id, orderId, line}` | The Assistant handed the ask to the Orchestrator (sent as soon as the order exists, usually before the Assistant's own words about it). `line` is a one-line description of the request for a card ("Asked the Orchestrator: publish the build"); what the Assistant says about it ("Let me ask the Orchestrator and get back to you") arrives as ordinary `delta` frames. `orderId` tracks it: for Chris it is also an ask id (`GET /voice/ask/<orderId>` answers as today's asks). |
| `{t:'handoff-progress', orderId, phase, sec, words?}` | `queued, typed, working, waiting-you, slow, not-taken`; at 10 s, 60 s, then every 5 min; `words` = the Orchestrator's spinner words. `waiting-you` = it waits for HIS answer on the PC. |
| `{t:'handoff-answer', orderId, text, cancelled?}` | The Orchestrator's full reply (show it). The Assistant then says a short version as an ordinary turn whose `id` is `o:<orderId>` (delta / flush / done as any turn). If nobody is connected the answer goes out as a Heartbeat / notification and is kept 1 h. |
| `{t:'card', card}` | F-221: a card to show, new or changed (a higher `version`). `card` = `{id, version, kind:'handoff'\|'relay', to, text, via:'voice'\|'typed', createdAt, expiresAt}` (`shared/fast.ts` `TalkCard`; `to` is a display name: the big chat for a hand-off, "<agent> on <floor>" for a relay). |
| `{t:'card-gone', id, reason, orderId?}` | F-221: a card went: `sent` (his tap; `orderId` = the order it became, whose `handoff`, progress and answer follow as usual), `dropped`, `expired` (10 minutes, or the oldest of more than 20), `closed`, `taken-over`. Review of T4: the Alt+K bar follows the order of a `sent` card from here as a hand-off of its own ("Asking the …", its progress; closing the bar keeps the link while it is out): the `handoff` frame that follows names the ask that made the card, long over. |
| `{t:'pong'}` | |

Every turn the client did not start (the `o:` ones) is told the same way, so one handler serves both. Both clients ignore a frame they do not know.

## Live talk (F-221, order ob98a): spoken words never approve, pay, delete or publish

Enforced on the hub, in code, whatever any model says:

- **Fail closed (every client).** A `hand_off` with no current ask is refused and nothing is typed (`{ok:false, reason:'There is no current question to hand off from.'}`):
  a cancelled turn, the `o:` turn that tells an answer, a closed socket, an ask not yet given to the process. So is one made while the process is
  still stopping a cut-off turn (`FastHost.stopping()`: from the interrupt until it settles, restarts, or speaks of a turn written after the cut,
  by its `user_message_uuid`), whose late call would otherwise be credited to the new ask. A tool call that comes before the new turn's first
  stream event is still refused; the new turn's own hand-off, which comes after its first word, is not.
- **The old way (hold off: the Alt+K bar and Live talking classic set to "Send at once", Chris's `/voice/fast`).** `hand_off` types the request as before and
  holds nothing, so the Orchestrator can still message agents for it (Chris has no card screen). Its label says where the words came from:
  `[message from Quick (typed), order oX]` for a typed ask, `[message from Quick (spoken, not tapped), order oX]` for a spoken one (the names
  in force: "the Assistant" when they are switched); the Orchestrator's brief treats the second as unconfirmed (answer and prepare only). Every
  ask of the Alt+K bar is spoken, and so is Live talking classic's "Hand to the Orchestrator" (his last utterance, sent `via:'voice'`): today a
  typed ask comes from Chris (his phone's keyboard). An old-way hand-off to an Orchestrator on another PC whose link fails after the request was
  sent is "could not take it" (409), as before T2 (only the direct line and his tap on a card read that as "not known").
- **Hold → card.** With the owner connection's hold latch on, `hand_off` makes a `handoff` card (the text with whitespace collapsed, `[` and `]`
  removed, marker lookalikes neutralized) and answers Quick `{ok:true, held:true, note}`; nothing is typed. A connection's cards go when it closes,
  is taken over, sends `drop` or `stop`; every card expires after 10 minutes. (A `relay` card, below, belongs to no connection: it goes on his tap,
  the drop route or its 10 minutes.)
- **His tap** is an HTTP route, never a frame. Routes (under `/agent-api/agentic`, the owner's page only; a chat's key and the fast key are refused):
  - `GET /talk/cards` → `{cards}`. `POST /talk/cards/<id>/drop` → `{ok, dropped}`.
  - `POST /talk/cards/<id>/send {version, text?}` needs his signed-in CRM session as the approvals do (401 `sign-in` without it, 403 for a key; a
    member PC answers 409 `hub-sign-in-required`). 404 for a card that is gone (sent, dropped, expired), 409 "The card changed. Check it and tap Send
    again." for another version, 409 while the same card is being sent. `text` = his edit (cleaned the same way, at most 4000 characters). A
    `handoff` card is typed into the Orchestrator as `[message from Quick (spoken, he tapped Send), order oX] <text>` (`typed` for a typed ask), the
    `, order oX]` last; its connection gets `card-gone {sent, orderId}` and then the usual frames. A `relay` card carries out the held message as the
    Orchestrator's chat. At a prompt or with his unsent text the answer is 409 and the card stays, so he can tap again. A relay to a chat on another
    PC whose link fails after the request was sent, before that PC answers, may have gone: the card is used up (409 `delivery-unconfirmed`), never
    sent twice. One whose link never opened carried nothing: a plain 409, and the card stays for another tap.
  - `POST /talk/ask {id, text}` (the direct line, "Send straight to the Assistant chat"): his spoken words, cleaned, at most 2000 characters, typed as
    `[message from Live voice (spoken, not tapped), order oX] <text>` with the same safe typing; `{ok:true, orderId, phase}` or `{ok:false, status,
    reason}`. One spoken line at a time, typed only into an Orchestrator that rests (no turn running, no prompt, nothing in its box) and that no
    other spoken line holds: until then the request waits on the hub, in order (at most 3 wait, each at most 2 minutes), then that line is answered
    `{ok:false, status:409, reason:'The Assistant is busy; say it again in a moment.'}` and nothing of it is typed. So the latch below covers that
    line's own turn, never his typed work. (The rest is looked at again right after the box is read, which on another PC is a round trip: a turn
    that started meanwhile gets no line.) Its order is opened and saved (queued, spoken) BEFORE the line is typed; when that save does not land
    nothing is typed (`{ok:false, status:503, reason:'The Server could not save this, so nothing was sent. Say it again in a moment.'}`); it goes
    again only when the line was certainly not typed. Review of T4: it is typed only into an Orchestrator the voice lock reaches (as
    `GET /talk/caps` says `'full'`: running on this PC, as Claude Code, this very run started with the lock); the hub checks that itself, again
    right before the typing, and answers any other at once with a 409 and nothing typed (also while it works, or while it is held by another PC out
    of reach), whatever the page read of the caps earlier: `'<name> runs without the voice lock (it needs a restart); nothing was typed.'`, or for
    a chat on another PC `'<name> runs on another PC, where the voice lock cannot reach; nothing was typed.'`. `GET /talk/ask/<orderId>` → the
    order as `/voice/ask` shows it (queued / working with status words / done with `speak` / error), plus `phase` while it is open (`queued, typed,
    working, waiting-you, slow`; `waiting-you` = the Orchestrator waits for HIS answer on the PC: a direct line has no socket for
    `handoff-progress`), `late` once its turn still runs past 3 hours (the words he is told: "Still working on this after 3 h; no answer yet."; it
    still holds), `held` (T4 phase 2: the Assistant chat is held for this line now, by its order or by the residual hold it left, below) and
    `cards` (relays held by that order). Its answer is kept for the page and never told by the Assistant (past the hour too while a residual hold
    carries it).
  - `GET /talk/caps` (T4) → `{holds: true, voiceLock: 'full'|'app-tools'}`. `'full'` only while the Orchestrator chat running on this PC now was
    started with the voice lock (below); `'app-tools'` when it is not running here, runs as Codex, or was started without the lock (before it
    existed: it needs a restart). The page offers the direct line only on `'full'` (and the hub refuses a direct line on anything else: above).
  - `POST /talk/ask/<orderId>/let-go` (T4): his Let go, his own tap: his signed-in CRM session as for a card's Send (401 `sign-in` without it, 403 for
    a key; a member PC answers 409 `hub-sign-in-required`). Review of T4: the order is stopped FIRST, while its hold is still on (Esc into the
    Orchestrator lands with the voice lock on), then the hold goes at once (its app tools and its voice lock file) before the route answers. As for
    any spoken order, Esc alone does not close it: it stays open until its turn is really over, and its reply is then "(cancelled: Shubham stopped
    it)", so `GET /talk/ask/<orderId>` says it was stopped. `{ok: true, released}`; `released: false` when it held nothing any more (then no Esc is
    sent). 404 for an order that is not a spoken line (or is gone and no residual hold carries it). Logged without words. T4 phase 2: an order
    that closed abnormally is gone, but the residual hold it left carries its id: his Let go finds it there (below).
  - A plain hand-off typed into an Orchestrator that runs on another PC, whose link fails after the request was sent and before that PC answers, may
    be in: it is kept as an order waiting to be taken (phase `queued`), never typed again; it is decided when the PC is back (its turn in the
    transcript). A link that never opened carried nothing: "could not take it" (409). (A direct line never goes to a chat on another PC since the
    review of T4; a spoken order kept from before would hold while that PC is out of reach, as `orders.ts` says.)
- **The spoken latch.** Only the direct line arms it (an untapped hand-off typed the old way holds nothing, above; a tapped card never arms it). It
  holds the Orchestrator chat's app tools from before its line can be submitted (its order is saved first) until he taps Let go (the let-go route
  above: the order is stopped, then the hub's `handoff.releaseSpoken(orderId, 'let-go')`) or the line can no longer run (`talk-latch.ts`,
  `orders.ts`): its reply is made (the turn that took the line ended); the Orchestrator chat stopped or restarted (the order is closed, saying
  so); or the line never entered and the chat rests with an EMPTY box (read twice; text in the box keeps it held). No clock lets it go while its
  line can still run: past 3 hours a running turn gets a progress line, not the give-up reply; a cancel sends Esc but the hold stays until the turn
  is seen over; a chat on another PC that is out of reach keeps it. The order keeps `spoken` in `orders.json`, so a restart of the agent keeps
  holding (the chat outlives it). A lost link to the chat host is no chat end (fix round 3): the pool's chats end then (-1) because the LINK went,
  so nothing is closed for them, and until the link is back and its reopen loop is over a chat not seen is not known to have stopped; the same
  process taken over again, or the chat reopened and told to carry on (`CONTINUE_TEXT`), keeps the hold until that turn is seen over. A member
  PC whose chat host link is lost lets none of those chats' leases go and reports them in its `live` frames as `reconnecting: [sessionId]` until
  it knows (the hub keeps their leases meanwhile, so a spoken order there holds as for a PC out of reach).
  While it holds: reads, notes (`task_add`, `task_update` without delete, `memory_save`) and prepared cards run;
  `ui_control` only opens pages and scrolls; `send_to_chat` / `app_send_to_chat` are not sent: they become `relay` cards (filed with the hub:
  listed with the order and in `GET /talk/cards`; "Held: ... he must tap Send ..."); everything else is refused (403).
  **What it holds, said plainly:** only the app's own tools (this hub's MCP server), for a direct line. The chat's shell (which can call the hub
  as the app itself, with the app's token), its desktop clicks (windows-mcp) and any other MCP server it has are held by the PreToolUse voice lock
  (below); until the Assistant chat runs with that lock (`GET /talk/caps` says `'full'`), the page does not offer the direct line. Hey Chris's
  `/voice/ask` stays as it is (its own safety tags): it is outside this feature.
- **The residual hold (T4 phase 2: fail-safe after an abnormal end).** A spoken order that closes for ANY reason other than its reply being seen
  (the turn that took the line ended) or his Let go (its chat stopped or was restarted, its line was not taken) leaves a **residual hold** on that
  Orchestrator chat, made before the order lets go, so there is no gap (`talk-residual.ts`, kept in `talk-residual.json`, atomic; a restart of
  the agent keeps holding). So does ANY start of a chat a spoken line holds (review of T4: `startHere` and a start on its home PC, whoever starts
  it: the reopen loop and start-up recovery telling it to carry on (`CONTINUE_TEXT`), the F-083 watchdog's `--resume` restart and nudge, a
  hand-off or a phone ask that starts it, the tools refresh, his own open): made before it starts, it holds what runs there next even if the order
  closes first (an end in its record at the resume). The watchdog never races the reopen loop of a lost chat host link (`recoveryBusy` while it
  runs). A chat that ends (`onEnded`) is held again from then. If `talk-residual.json` cannot be written, the order that would close holds on (it
  is on disk) and closes once the hold is saved (written again at every tick). It holds exactly as the order did (the app's tools; its
  `talk-latch/<session>` file, so the voice lock too) until a turn END is seen in that chat AFTER it was made, the chat then at rest with an
  EMPTY box (read twice in a row), or until he taps Let go on an order it carries. A turn end is seen as: the chat seen working after the hold
  was made (its transcript in the simple layer, its screen under the old rule, its PC's reports for a chat on another PC; every state change is
  looked at, not only the 1 s tick), then at rest with an empty box; a chat seen nowhere in between (a crash, a restart, a lost link) must be seen
  working again; no clock lets it go. Review of T4: a turn a chat started again reads back from its record (begun before this run started: the
  one the stop cut off) is no turn of its own; its own screen working (the spinner, a prompt) counts at once. A text of the app's still waiting
  for a chat's prompt (`typeWhenReady`: a carry-on, the watchdog's nudge, a hand-off's line) keeps its box from counting as empty. While one
  holds, a new spoken line waits as for a held chat (one spoken line at a time). **The old order rule** ("Old way" / `SAD_SYNC=old`, Codex,
  OpenCode: no transcript turn) sees a spoken line's reply only as its chat seen working since the line was typed, in the run it is in now (seen
  nowhere twice, or the chat reopened, undoes that), then at rest with an empty box (read twice); at rest without that it waits (no clock), gone
  it closes abnormally. **Start-up and a lost
  chat host:** no spoken line is typed before the hub knows its chats (adoption, recovery, a lost link until its reopen loop is over): a line that
  comes during the reopen loop waits and starts nothing, and (review of T4) it goes in only after a carry-on that loop or recovery scheduled has
  been typed and its turn seen over. One list of lost chats for every loss, worked through by one reopen loop at a time: a loss while it runs adds
  to it, the next back goes on with what is left, and the host counts as settled only once every lost chat was looked at; a chat whose carry-on was
  not typed yet when the link went again is told to carry on again. **A member PC** reports `adopting: true` in its `hello` / `live` frames until its
  start-up take-over has settled (its pool does not have the chats its chat host kept yet), and the hub lets none of that PC's leases go for such a
  frame (a spoken order there holds while the chat is away). `GET /talk/ask/<orderId>` answers `held: true` while the order holds or a residual
  hold carries it (also after its answer; review of T4: after a restart of the agent too, when the answer kept in memory is gone: `state:'done'`
  with a short line), `held: false` once nothing holds for it (after his Let go too), so the page shows the voice lock line and Let go exactly
  while it is true. His Let go on a residual hold (`POST /talk/ask/<orderId>/let-go`, the order may be gone: the hold carries
  its id) sends Esc first while the chat works here (as for an order), then lets the whole hold on that chat go; `{ok:true, released:true}`.
  `GET /talk/caps` is unchanged.
- **The voice lock below the model (T4).** The Orchestrator's chat, and only it, starts with `<state>/agent/agentic/hooks-orchestrator.json`: the
  prompt hook every chat gets (the memory's, or the prompt report, or none, by the same rules) plus a PreToolUse hook on every tool (matcher `"*"`):
  `agent/agentic/latch-hook.ts <latch folder> <its session>`. The hub mirrors the spoken latch into `talk-latch/<session>` (`talk-latch.ts`): a
  file is written when a direct line arms the latch, before the line is typed (a line whose file cannot be written is not typed: 503); it goes
  when the hold goes (its reply, his Let go; T4 phase 2: a chat stopped keeps it under its residual hold, above), and the folder is rebuilt from
  the saved orders and the residual holds when the agent starts. While a file
  names the chat (by the session Claude Code reports, or the session the hook was written for, so a `/clear` changes nothing), the hook refuses
  every tool but Read, Grep, Glob, LS, TodoWrite, ToolSearch, WebSearch, WebFetch and the app's own `mcp__shubham-agentic__<tool>` (which the hub
  holds itself; review of T4: by the whole name, lower-case words joined by single underscores, so another server whose name only begins like the
  app's, such as `shubham-agentic__x`, is refused), with "That came from his voice: he has to type it or tap it himself. Tell him so in one
  sentence; do not try another way." Otherwise it
  prints nothing. It always exits 0 and logs nothing. Which chats were started with it is kept by start time (`voice-lock.json`), so a chat the
  chat host keeps running across an Update still counts. Not checkable on this PC: that the real Claude Code honours the refusal under
  bypassPermissions (it is checked on his first direct line after the Assistant chat restarts).
- **Markers.** Only the card route writes "he tapped Send". Every other text the hub types into a chat (hand-offs, direct lines, relayed messages,
  broadcasts, order replies, phone asks, the heartbeat) has a lookalike neutralized ("tapped Send" → "tapped [Send]"), judged by how the text looks
  (its skeleton: NFKD, so fullwidth, mathematical and accented letters are plain ones; marks, invisible characters and modifier letters and
  symbols left out; the Latin-looking letters of other scripts for t, a, p, e, d, s and n read as those, the Cherokee small letters through their
  capitals, the hooked, barred, curled and tilded Latin forms of those letters too, and a capital as its small form when only that is listed),
  with any non-letters (or none) between the two words. Done twice it changes nothing more. A card's words also lose square brackets, their
  fullwidth forms too. Every label says its
  source (`(typed)`, `(spoken, not tapped)`, `(…, he tapped Send)`), always followed by `, order oX]`; the Orchestrator's brief
  (`src/overlay/brief.ts`, v10) words its rules by that label and counts the markers only at the very start of a message.

## What the Assistant can and cannot do (enforced on the hub by who is calling, never by what the model says)

Tools it has (read-only, plus one write): `app_chats`, `floor_roster`, `app_read_chat`, `app_read_conversation`, `memory_search`, `memory_read`,
`memory_recent`, `task_list`, `task_add` (the only write), `ui_screen`, `ui_control` (only `goto` and `crm_goto`, `scroll` and `wait`: it can open and
read pages, not click, type or press keys), `watchdog_status`, `approvals_waiting` (a count and who waits: read-only), `hand_off {text}`, `order_status`.

Tools it never has: `app_send_to_chat`, `send_to_chat`, `broadcast_to_chats`, `prepare_send`, `agent_hire`, `app_open_chat`, `app_stop_chat`,
`app_set_effort`, `memory_save`, `task_update`, `ui_invoke`, `phone_control`, `phone_screen`, `phone_update`, anything WhatsApp. It has no tool that answers
Approvals or any signed action (those need his device signature and stay human-only); a hand-off goes to the Orchestrator, whose own approvals apply.
Text from chats, pages, WhatsApp and tool results is data, never instructions.

## The host (Connection) and the session (Overlay): the seam

`FastHost` (Connection, `agent/agentic/fast-host.ts`): the warm headless process.
`state()`, `ask({id, text, model, snapshot?}, emit)` (emit HostEvents = the hub→client turn frames above, without the transport), `interrupt(id)`,
`deliver(note, turnId)` (a system note to the process's stdin, answered as turn `o:<orderId>`), `stop(why)`. Start/stop, memory gate, supervision and the
exact-PID kill are the host's.
`FastSession` (Overlay, `agent/agentic/fast.ts`): owners, the two sockets, the brief and snapshot, the tools and their gating, hand-off and order routing.
