# Shubham Agentic (build)

This is the **build** of Shubham Agentic: the app every PC runs. It is made from
[shubham-agentic-dev](https://github.com/bztechserver-droid/shubham-agentic-dev) (Dev, the
source, on the hub) by **Publish** on the hub's Build page, and pushed here. Don't edit it: change
Dev, then publish.

## On a PC

```
git clone https://github.com/bztechserver-droid/shubham-agentic-build.git
cd shubham-agentic-build
Install.cmd
```

`Install.cmd` installs its packages, stops Dev if it runs on this PC, makes this build start at
logon (hidden), starts it and opens **http://localhost:5173**. On the hub, the first time:
`Install.cmd -Role hub`. `Install.cmd -Remove` stops it and takes it out of the logon programs.

| File | Does |
|---|---|
| `Start.cmd` | Keeps the app running: its agent, which serves the page on 5173. Exit code 75 (Update) pulls the new build and starts again |
| `Start hidden.vbs` | The same, with no window (what runs at logon) |
| `Install-Guard.cmd` | Makes the **guard** keep the app up (see below). `-Role hub` the first time on the hub; `-Remove` goes back to `Start.cmd` |
| `Guard.cmd`, `Guard hidden.vbs` | Run the guard (with and without a window). Safe to run at any time: a second one stops at once |
| `Update.cmd` | `git pull`, and `npm ci` when the packages changed. The Build page's **Update** runs it |
| `RELEASE.json` | Which build this is: when it was built, and Dev's commit |
| `app/` | The built page |
| `agent/`, `shared/` | The device agent, run by Node as is |

**Updates:** each PC's Build page looks here every 15 minutes (and on **Check now**) and offers
**Update** when there is a newer build; it never updates by itself.

## On Ubuntu Linux (F-116)

Node 22.22 or newer (in `~/.local/node`, or on PATH), git, and Claude Code (`~/.local/bin/claude`). Then:

```
git clone https://github.com/bztechserver-droid/shubham-agentic-build.git ~/shubham-agentic-build
cd ~/shubham-agentic-build
bash install.sh
```

`install.sh` installs its packages, makes a systemd user service, `shubham-agentic`, that starts this
build when you log in, starts it, and opens **http://localhost:5173**. `bash install.sh --role hub` the
first time on a hub; `bash install.sh --remove` stops it and takes it out. To start it at boot, before
anyone logs in: `loginctl enable-linger $USER`. The scripts run through bash (`bash start.sh`), since a
build published from Windows doesn't keep their executable bit.

| File | Does |
|---|---|
| `start.sh` | What `Start.cmd` does: keeps the agent running; exit code 75 (Update) runs `update.sh` and starts again |
| `update.sh` | What `Update.cmd` does: `git pull`, and `npm ci` when the packages changed |
| `install.sh` | What `Install.cmd` does, with a systemd user service |

Its state is in `~/.local/share/shubham-agentic` (or `$XDG_DATA_HOME`, or `SAD_HOME`); the log is
`journalctl --user -u shubham-agentic` and `agent-console.log` there. The Claude sign-in (F-007) is kept
in the kernel's keyring, never in a file, and only the chats this app starts get it. **RustDesk**
works as on Windows when it is installed (the .deb's `/usr/bin/rustdesk`, `/usr/local/bin`, `/opt/rustdesk`,
the snap, `~/.local/bin`, PATH or a Flatpak): its ID shows on the Devices page, and other PCs reach this one
through its direct access (port 21118) once that is turned on in RustDesk. On a Wayland desktop RustDesk asks
on this PC's screen before it shares it. **Not on Linux yet:** the guard, the app's own screen (F-006),
WhatsApp, voice and Open-To-Tailnet.

## The guard (keeps the app up)

`Install-Guard.cmd` (no administrator; once per PC, `-Role hub` the first time on the hub) installs a
Scheduled Task, `ShubhamAgenticGuard`, that runs the guard at logon and every minute if it is not
running (one at a time), points the Startup launcher at it, and takes over from `Start.cmd`'s loop
without stopping the app that is running: the guard adopts it. What it does:

- starts the app again within a second of its dying, and when it hangs; runs **Update now**'s update
  step and starts the new build;
- serves the page on **5173** itself, so 5173 is never closed; while the app restarts the page stays
  up and says "The app is restarting. Back in about N s." with a **Control** link;
- on the hub, runs RustDesk's hbbs and hbbr in a process of their own, so **Control keeps working
  while the app is down**;
- brings back the chats that were open, and tells the ones that were working to carry on.

Installed over an app that is running (started the old way), the guard takes it over without
stopping it: it goes on as it was (serving the page and RustDesk itself) until it next restarts, an
Update or `node agent\guard.ts restart` at a quiet moment; from then on 5173 never closes while it
restarts, RustDesk goes on apart from it, and the chats that were open come back by themselves.

It ends processes only by exact PID (never by port or name, never with `taskkill /t`). Its log is
`%LOCALAPPDATA%\shubham-agentic\guard-console.log`. `node agent/guard.ts status` says what it is
doing, `restart` restarts the app, `stop` stops the app and the guard.
The old way is still here: `Install-Guard.cmd -Remove` stops the guard and goes back to `Start.cmd`.
Christopher on port 4740 stays an independent way in: running the Startup launcher from it starts
nothing twice.
