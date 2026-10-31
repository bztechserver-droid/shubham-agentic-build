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
| `Update.cmd` | `git pull`, and `npm ci` when the packages changed. The Build page's **Update** runs it |
| `RELEASE.json` | Which build this is: when it was built, and Dev's commit |
| `app/` | The built page |
| `agent/`, `shared/` | The device agent, run by Node as is |

**Updates:** each PC's Build page looks here every 15 minutes (and on **Check now**) and offers
**Update** when there is a newer build; it never updates by itself.
