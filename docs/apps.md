# Apps

An app is a folder with three files: `app.json`, a screen (`app.contract`) and server code (`server.ts`). Its server code runs on the agent's computer, its data lives on the host, and both you and the imp use it through the same operations.

## Operations

An app declares each thing it can do once, as an **operation** in `server.ts`: a read or a write, with a description and typed parameters. Then:

- **The screen** calls an operation as `<appId><Name>`, with its arguments in order. The todos app's `setDone` is `todosSetDone(id, done)`. A read streams to the screen live and answers again after every write.
- **The agent** finds operations with `find_app_actions` and runs them with `run_app_action`, by name, with named arguments. Its tool list stays the same whichever apps are installed.

An operation marked `agent: false` is the screen's alone. The host checks every call against the operation's parameters, from either side.

## Where an app runs

`host/src/apps.ts` is the app gateway. It opens one WebSocket to agentd's `/apps` on the computer, and agentd runs each app's server code in a worker of its own (`host/machine/worker.ts`). A new version replaces the old worker, and terminating a worker frees everything it held.

The app's database is a SQLite file on the host, `DATA_DIR/apps/<id>.sqlite`. Every `app.db` call in the worker crosses the socket to the host and back. That is why a computer can be switched, suspended or replaced without losing a single row: the computer holds the code, the host holds the data.

## Slots: live and draft

Versions run in slots. An app's live version runs in the slot named by its id. A draft being previewed runs beside it in `<id>~draft`, on a **copy** of the live data. The shell's views use the draft while there is one. The agent's actions always reach the live version unless they ask for the draft.

## From the imp's workspace to your screen

1. **The imp writes the folder**

   `app_code(app)` writes the app's current code into `apps/<id>/` in the imp's workspace (a working starter for a new app), with the build guide, the SDK and Contract's docs. The imp edits the three files.

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

Undo's history, which holds the data too, lasts 48 hours. The code lasts longer: every save and undo commits the live apps' code to a git repository in `DATA_DIR/backup`, a folder per app (`host/src/backup.ts`). The host also commits at start, so apps from before backup existed are kept too.

**Backup** in Settings connects GitHub with the GitHub CLI's device code sign-in, shown like the ChatGPT one. The host keeps that sign-in in `DATA_DIR/gh` and never takes a token from its environment. It finds or creates a private `<you>/imp-apps` repository and pushes each version there. A failed push is shown in Settings and retried on the next save.

Only code is backed up. The apps' data stays on the host, so back up `DATA_DIR` for that. The host needs `git` for the history and `gh` for GitHub, and Settings says which one is missing.

To write an app yourself, see [Build an app](building-apps.md).
