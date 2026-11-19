# Apps

An app is a folder with three files: `app.json`, a screen (`app.contract`) and server code (`server.ts`). Its server code runs on the agent's computer, its data lives on the host, and both you and the imp use it through the same operations.

## Operations

An app declares each thing it can do once, as an **operation** in `server.ts`: a read or a write, with a description and typed parameters. Then:

- **The screen** calls an operation as `<appId><Name>`, with its arguments in order. The todos app's `setDone` is `todosSetDone(id, done)`. A read streams to the screen live and answers again after every write.
- **The agent** finds operations with `find_actions` and runs them with `run_action`, by name, with named arguments. The same two tools reach the tools of the [MCP servers](connections.md#mcp-servers) the owner connected, so its tool list stays the same whichever apps are installed and whichever servers are connected.

- **Other assistants** on your tailnet, such as Claude Code or Cursor, use the apps you share with them in Settings → Assistants, over MCP. See [Other assistants](#other-assistants).

An operation marked `agent: false` is the screen's alone. The host checks every call against the operation's parameters, from any side.

## Other assistants

The host is also an MCP server, at `https://<your host>/mcp` over MCP's Streamable HTTP transport (`host/src/assistants/`). It sits behind the same `tailscale serve` and `OWNER_LOGIN` check as the rest of the host, so only devices on your tailnet reach it. There is no OAuth and no Funnel, so cloud connectors such as claude.ai or ChatGPT can't reach it.

No app is shared until you turn it on in **Settings → Assistants**, which keeps your choice in `DATA_DIR/assistants.json`. Each operation of a shared app is one tool, named `<app>_<operation>`, such as `todos_add`. A read has MCP's read-only hint and a write its destructive hint. Operations marked `agent: false` and drafts are never tools: a call always reaches the saved app. The host sends MCP's `notifications/tools/list_changed` on the stream a `GET /mcp` opens whenever the tools change: when an app loads, is uninstalled, or you share it or stop sharing it.

A call runs the way the imp's `run_action` does, so your open views update at once. What a tool answers goes to the other assistant's model, under that assistant's terms, not Imp's. Share only the apps whose data you are happy to send there. To add Imp to Claude Code:

```sh
claude mcp add --transport http imp https://<your host>/mcp
```

## Where an app runs

`host/src/apps/apps.ts` is the app gateway. It opens one WebSocket to agentd's `/apps` on the computer, and agentd runs each app's server code in a worker of its own (`host/machine/worker.ts`). A new version replaces the old worker, and terminating a worker frees everything it held.

The app's database is a SQLite file on the host, `DATA_DIR/apps/<id>.sqlite`. Every `app.db` call in the worker crosses the socket to the host and back. That is why a computer can be switched, suspended or replaced without losing a single row: the computer holds the code, the host holds the data.

## Slots: live and draft

Versions run in slots. An app's live version runs in the slot named by its id. A draft being previewed runs beside it in `<id>~draft`, on a **copy** of the live data. The shell's views use the draft while there is one. The agent's actions always reach the live version unless they ask for the draft.

## Live apps: reading your services

An app can read your services and keep a copy current in its database ([Build an app](building-apps.md#reading-a-service)). What it may reach is in its code, as `connections`, and the preview's bar says it before you save: "Reads api.github.com with your github key, every 15 min." The host holds every `app.fetch` to those hosts, to reads, and to the keys the connections name (`host/src/apps/connections.ts`), and sends it from the host (`host/src/secrets/app-fetch.ts`), so the app's code never holds a key.

The host runs an app's `sync` on its live version only, never on a draft:

- when you open the app's tab and its copy is due,
- when you press **Sync now** in the app's **Manage** dialog (the gear in its page's bar),
- on schedule, while the host is connected to the computer, and
- when a URL the sync watches changed.

On E2B, where the computer pauses after 10 minutes unused, a schedule alone does not keep it running: a scheduled sync waits until you open the app or the imp uses the computer. A computer of yours never pauses.

A watched URL (`sync.watch`, at most five, each on one of the app's connections) is how an app hears about a change without waking the computer to look (`host/src/apps/watch.ts`). The host asks each one itself, with your key, as often as the service's `X-Poll-Interval` allows and at least a minute apart, sending the `ETag` and `Last-Modified` it saw last. An answer of nothing new (304) costs neither the service's rate limit nor the computer. Only an answer whose body differs from the last one runs the sync, and that is the one time a sync wakes the computer. The host keeps what it saw in `DATA_DIR/apps/watch.json`, so a restart is not a change. A URL that fails is asked again later, twice as late each time, up to an hour. The bar says what the app watches: "Reads api.github.com with your github key, every 15 min, and when api.github.com/notifications changes."

The bar says how the last sync went ("Synced 3 min ago", or "Sync failing for 20 min: GitHub answered 401"). The host keeps that in `DATA_DIR/apps/sync.json`, outside the app's database, so an app cannot make it up. A failed sync is tried again later, twice as late each time, up to once a day. An app that reads with a key you have not added yet does not fail: it waits, without syncing, and its page says which key it needs, with a button to the place in Settings that adds it (**Settings → Connections** for the `github` key). It syncs as soon as the key is in the vault.

## From the imp's workspace to your screen

1. **The imp writes the folder**

   `app_code(app)` writes the app's current code into `apps/<id>/` in the imp's workspace (a working starter for a new app), with the build guide, the SDK and Contract's docs. The imp edits the three files. An app you install from the **App directory** or a GitHub link starts the same way: the imp clones the repository and copies its app folder into `apps/<id>/`.

2. **It asks for a preview**

   `preview_app(app)` makes the host take only that folder from the computer. The host loads the server code, applies its migrations to a copy of your data, writes the shell's wiring for the screen, and rebuilds the web client, which takes a few seconds. If anything fails, the imp gets the error and where it is.

3. **You try it**

   The app's tab shows the new version as a preview, on a copy of your data. The page's bar says **Preview** beside the app's name and offers **Save**, and **Back** (←), which discards the preview and goes back to the saved version. Open pages reload into the new version as soon as the host serves it. The Mac app carries the screens Imp ships and draws them natively. For an app whose version is another one (a preview, a saved change, or an app the imp built), it shows the host's own page for that app in the app's page, framed under the Mac app's bar and beside its chat, so it has the same screen as the browser. That page is the app's alone (`/<id>?embed=1`): no sidebar, bars or chat of its own. The Mac app also passes the host's address (`&host=`), which the page uses only when it can't look up its own address from the host. An app the Mac app has no tab for at all opens at `/hosted/<id>`, listed in the sidebar with the others.

4. **Only you save**

   Save makes the draft live and keeps the version before it. **Undo**, the back arrow in the bar after a save, restores it for 48 hours.

On disk, under `DATA_DIR/code/<id>/`:

- `live/`: the live version the imp made or changed (else `client/apps/<id>/`)
- `draft/`: the draft being previewed
- `history/`
  - `1794639291602/`: a saved-over version: its code, data.sqlite, and meta.json

The host keeps the last three web builds in `DATA_DIR/builds/`, and `builds/current.json` names the one it serves.

## The chat beside an app

On a wide window an app's page has the chat beside it, and the imp is told which app you have open when you write there. Each app keeps its own chat: opening an app shows the latest chat you started beside it, or a new chat until you write in one, whichever chat was open before. A chat you pick in the sidebar opens on the chat page. A chat started on the chat page in which the imp previews a new app sits beside that app from then on, so the app opens on the chat that built it. The host remembers which app each chat sits beside in `DATA_DIR/conversations.json` (`host/src/chats/chats.ts`), so a reload, or opening Imp on an app's page, shows the same chat. On any other page Imp opens on a new chat.

## Install and uninstall

No app runs until it is installed. A new host has none until the onboarding installs GitHub.

**Uninstall**, in the **Manage** dialog that the gear in every app's page bar opens, asks "Are you sure you want to delete the app and all its data?" and then removes the app: its worker, its live version and draft, Undo's history and its database (`host/src/studio/installs.ts`). Its git backup keeps its code. The host leaves `DATA_DIR/code/<id>/uninstalled` behind, which says the app stays out. The shell stops listing the app at once, and its screen leaves the shell's build the next time the host builds it.

**Install** puts in an app Imp ships, from `client/apps/`, without the imp: the onboarding installs GitHub this way, and the **App directory** Todos. To have an uninstalled app again, install it again, or ask the imp: `app_code` writes an app Imp ships that you don't have as Imp ships it, and you save its preview like any app's.

A host that ran an app Imp ships before apps had to be installed has its data, and keeps it installed (`storedApps` in `host/src/studio/code.ts`).

## Every version, kept in git

Undo's history, which holds the data too, lasts 48 hours. The code lasts longer: every save and undo commits the live apps' code to a git repository in `DATA_DIR/backup`, a folder per app (`host/src/backup/backup.ts`). The host also commits at start, so apps from before backup existed are kept too.

**Settings → Connections** is where the host signs in to GitHub, and where Backup can also copy that history to GitHub. **Connect GitHub** runs the GitHub CLI's device code sign-in, shown like the ChatGPT one, with a pinned `gh` the host downloads into `DATA_DIR/tools` the first time and checks against its SHA-256, so there is nothing to install, and asks for the `notifications` scope beside gh's own, so the GitHub app can read them (`host/src/connections/`). The token goes into the vault as your key named `github`, and the host keeps only the account's name, in `DATA_DIR/connections.json`. From there it works like a key you added: the GitHub app, the imp's `gh` and `git`, and Backup all use it through the vault, and none of them holds it. **Disconnect** deletes the key and turns Backup off; the account on GitHub is untouched. A `github` key you add in Settings → Secrets connects GitHub too. A host whose backup signed in before Connections existed has that sign-in moved from `DATA_DIR/gh` into the vault at its first start.

The git repository on the host is always there. With GitHub connected, **Copy to GitHub** adds a copy of it: it first asks you to confirm the `<you>/imp-apps` repository it creates under your GitHub account, and whether it is private (the default) or public. Then it creates that repository through GitHub's API, or uses the one you already have by that name as it is, and pushes each version there. **Stop copying** stops the pushes and leaves the host's history as it was. A failed push is shown in Settings and retried on the next save.

Only code is backed up. The apps' data stays on the host, so back up `DATA_DIR` for that. The host needs `git` for the history, and Settings says when it is missing.

## Apps Imp ships

The onboarding's last step, **Build your first app**, shows you what an app is with GitHub. You describe the GitHub app you want, such as one that shows only the pull requests waiting for your review, and **Build it** sends your words to the imp in the chat, which builds a new app from scratch while you watch. Nothing is installed first. As soon as the imp previews the app, the shell opens it, with that chat beside it, and you save it or discard it. **Skip, use Imp's GitHub app** installs Imp's as it ships instead. Until GitHub is connected, an app that reads GitHub offers **Connect GitHub** right on its page (Imp's GitHub app) or asks for the key in Settings (one the imp built). Either way, once a host has had an app, the onboarding doesn't show again.

Todos (`client/apps/todos`) is in the **App directory**. Installed, it is yours like an app the imp built: the host copies it into `DATA_DIR/code/todos/live/` and runs it from there, and Imp's later changes to it don't reach it.

An app in `client/apps/` whose `app.json` says `"server": "imp"` keeps Imp's server code: installed, it runs as the repository has it (`DATA_DIR/code/<id>/installed`). Its screen is yours to change, like any app's, but its `server.ts` and `app.json` are Imp's: the host always runs the repository's copy of them under the screen you saved (`host/src/studio/code.ts`), at start, in a preview and on Undo, so Imp's updates to them reach you and your screen stays yours. A preview that changes them is refused, and the imp is told to say what data the screen is missing instead.

### GitHub

The GitHub app (`client/apps/github`) is the first app Imp ships this way: its server code reads GitHub, and the screen is yours, or the one the imp builds you. Its sync reads, with your key named `github`, the pull requests waiting for your review, your own open pull requests, the issues and pull requests assigned to you, and your unread notifications, and merges them into one item per issue or pull request. It watches `api.github.com/notifications`, so a new notification brings a sync within a minute or so.

- **It needs your key named `github`.** Without one it shows nothing yet, and the imp asks you for one with a request in Settings, without waiting for it to build.
- **Notifications need a classic token** with the `notifications` scope (or `repo`): GitHub gives them to nothing else. With another key, the app shows the rest and says so.
- **Done and Snooze are the app's own.** They change nothing on GitHub, and a sync keeps them. A done item comes back when it changes on GitHub again, and a snoozed one when its snooze ends.
- **Saved filters are the app's own too.** It keeps the organizations you want to see (none: all of them) and the repositories you hide, on the host, so they survive reloads and follow you to every device; a sync keeps them. The default screen leaves hidden items out. Ask your imp to add controls for them to the screen, or to hide a repository for you.
- **Acting on GitHub is the imp's.** Ask in the chat beside the app ("review the gift card PR", "mark my notifications read"): the imp reads the app's items and acts with `gh`.

To write an app yourself, see [Build an app](building-apps.md).
