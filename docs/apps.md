# Apps

An app is a folder with three files: `app.json`, a screen (`app.contract`) and server code (`server.ts`). Its server code runs on the agent's computer, its data lives on the host, and both you and the imp use it through the same operations.

## Operations

An app declares each thing it can do once, as an **operation** in `server.ts`: a read or a write, with a description and typed parameters. Then:

- **The screen** calls an operation as `<appId><Name>`, with its arguments in order. The todos app's `setDone` is `todosSetDone(id, done)`. A read streams to the screen live and answers again after every write.
- **The agent** finds operations with `find_app_actions` and runs them with `run_app_action`, by name, with named arguments. Its tool list stays the same whichever apps are installed.

An operation marked `agent: false` is the screen's alone. The host checks every call against the operation's parameters, from either side.

## Where an app runs

`host/src/apps/apps.ts` is the app gateway. It opens one WebSocket to agentd's `/apps` on the computer, and agentd runs each app's server code in a worker of its own (`host/machine/worker.ts`). A new version replaces the old worker, and terminating a worker frees everything it held.

The app's database is a SQLite file on the host, `DATA_DIR/apps/<id>.sqlite`. Every `app.db` call in the worker crosses the socket to the host and back. That is why a computer can be switched, suspended or replaced without losing a single row: the computer holds the code, the host holds the data.

## Slots: live and draft

Versions run in slots. An app's live version runs in the slot named by its id. A draft being previewed runs beside it in `<id>~draft`, on a **copy** of the live data. The shell's views use the draft while there is one. The agent's actions always reach the live version unless they ask for the draft.

## Live apps: reading your services

An app can read your services and keep a copy current in its database ([Build an app](building-apps.md#reading-a-service)). What it may reach is in its code, as `connections`, and the preview's bar says it before you save: "Reads api.github.com with your github key, every 15 min." The host holds every `app.fetch` to those hosts, to reads, and to the keys the connections name (`host/src/apps/connections.ts`), and sends it from the host (`host/src/secrets/app-fetch.ts`), so the app's code never holds a key.

The host runs an app's `sync` on its live version only, never on a draft:

- when you open the app's tab and its copy is due,
- when you press **Sync now** on the app's bar,
- on schedule, while the host is connected to the computer, and
- when a URL the sync watches changed.

On E2B, where the computer pauses after 10 minutes unused, a schedule alone does not keep it running: a scheduled sync waits until you open the app or the imp uses the computer. A computer of yours never pauses.

A watched URL (`sync.watch`, at most five, each on one of the app's connections) is how an app hears about a change without waking the computer to look (`host/src/apps/watch.ts`). The host asks each one itself, with your key, as often as the service's `X-Poll-Interval` allows and at least a minute apart, sending the `ETag` and `Last-Modified` it saw last. An answer of nothing new (304) costs neither the service's rate limit nor the computer. Only an answer whose body differs from the last one runs the sync, and that is the one time a sync wakes the computer. The host keeps what it saw in `DATA_DIR/apps/watch.json`, so a restart is not a change. A URL that fails is asked again later, twice as late each time, up to an hour. The bar says what the app watches: "Reads api.github.com with your github key, every 15 min, and when api.github.com/notifications changes."

The bar says how the last sync went ("Synced 3 min ago", or "Sync failing for 20 min: GitHub answered 401"). The host keeps that in `DATA_DIR/apps/sync.json`, outside the app's database, so an app cannot make it up. A failed sync is tried again later, twice as late each time, up to once a day.

## From the imp's workspace to your screen

1. **The imp writes the folder**

   `app_code(app)` writes the app's current code into `apps/<id>/` in the imp's workspace (a working starter for a new app), with the build guide, the SDK and Contract's docs. The imp edits the three files. An app you install from the **App directory** or a GitHub link starts the same way: the imp clones the repository and copies its app folder into `apps/<id>/`.

2. **It asks for a preview**

   `preview_app(app)` makes the host take only that folder from the computer. The host loads the server code, applies its migrations to a copy of your data, writes the shell's wiring for the screen, and rebuilds the web client, which takes a few seconds. If anything fails, the imp gets the error and where it is.

3. **You try it**

   The app's tab shows the new version as a preview, on a copy of your data, with **Save** and **Discard**. Open pages reload into it by themselves.

4. **Only you save**

   Save makes the draft live and keeps the version before it. **Undo** restores it for 48 hours.

On disk, under `DATA_DIR/code/<id>/`:

- `live/`: the live version the imp made or changed (else `client/apps/<id>/`)
- `draft/`: the draft being previewed
- `history/`
  - `1794639291602/`: a saved-over version: its code, data.sqlite, and meta.json

The host keeps the last three web builds in `DATA_DIR/builds/`, and `builds/current.json` names the one it serves.

## Every version, kept in git

Undo's history, which holds the data too, lasts 48 hours. The code lasts longer: every save and undo commits the live apps' code to a git repository in `DATA_DIR/backup`, a folder per app (`host/src/backup/backup.ts`). The host also commits at start, so apps from before backup existed are kept too.

**Backup** in Settings connects GitHub with the GitHub CLI's device code sign-in, shown like the ChatGPT one. The host keeps that sign-in in `DATA_DIR/gh` and never takes a token from its environment. It finds or creates a private `<you>/imp-apps` repository and pushes each version there. A failed push is shown in Settings and retried on the next save.

Only code is backed up. The apps' data stays on the host, so back up `DATA_DIR` for that. The host needs `git` for the history and `gh` for GitHub, and Settings says which one is missing.

## Apps Imp ships

An app in `client/apps/` whose `app.json` says `"server": "imp"` keeps Imp's server code. Its screen is yours to change, like any app's, but its `server.ts` and `app.json` are Imp's: the host always runs the repository's copy of them under the screen you saved (`host/src/studio/code.ts`), at start, in a preview and on Undo, so Imp's updates to them reach you and your screen stays yours. A preview that changes them is refused, and the imp is told to say what data the screen is missing instead.

To write an app yourself, see [Build an app](building-apps.md).
