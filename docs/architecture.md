# Architecture

Imp has three places where things run, and one rule about what lives where: **what is yours stays on the host.** Your data, your credentials, your memories and your secrets are in the host's data directory. The agent's computer is where work happens, and it can be replaced.

```txt
  your browser / Mac app
          │  HTTPS, over your tailnet (tailscale serve)
          ▼
  ┌─────────────────────────── host (127.0.0.1:8787) ───────────────────────────┐
  │  web client · /api/live/* (event streams) · /api/call/* (writes)            │
  │  agent (Pi Durable) · app gateway · studio · memory · vault                 │
  │  DATA_DIR: SQLite for conversation, apps, credentials; memory.jsonl         │
  └──────────────────────────────────┬──────────────────────────────────────────┘
                                     │  adapter: E2B URLs, or SSH tunnels over Tailscale
                                     ▼
  ┌──────────────────────── the agent's computer ─────────────────────────┐
  │  agentd (one port, token required)                                    │
  │    /pi-env   the agent's read, write, edit, bash tools                │
  │    /apps     one worker per app's server code                         │
  │    /screen   a desktop with Chrome, over VNC                          │
  └───────────────────────────────────────────────────────────────────────┘
```

## The host

`host/src/host.ts` starts everything and serves one HTTP origin on localhost: the built web client, and its API.

- **The agent** runs on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), with its conversation in `harness.sqlite`. It survives restarts in the middle of a turn. The model is your ChatGPT account, signed in with ChatGPT's device code flow (`host/src/account/account.ts`).
- **The app gateway** (`host/src/apps/apps.ts`) loads every app's server code onto the computer and keeps each app's SQLite database on the host. See [Apps](apps.md).
- **The studio** (`host/src/studio/studio.ts`) is where the imp makes apps: it takes an app folder from the computer, checks it, rebuilds the web client, and shows the result as a preview.
- **Memory** (`host/src/memory/memory.ts`) is what the imp knows about you and itself. See [Memory](memory.md).
- **The vault** keeps your API keys, and the egress proxy adds them to the imp's requests. See [The secrets vault](vault.md).

### The host's contexts

`host/src` has one folder per part of the host that owns its own rules and data. The files at its top (`server.ts`, `host.ts`, `http.ts`, `shell-api.ts`, `static.ts`) put the parts together and serve them. Each part offers itself to the rest through one file named after its folder, such as `apps/apps.ts`. Its other files are its own to change. `kernel/` is code every part shares.

| Folder | What it owns | May use |
| --- | --- | --- |
| `apps/` | The app gateway: each app's code in a worker on the computer, its data in SQLite on the host, its versions, what it reads from outside and its syncs, and the two tools the agent runs apps with | `machine` |
| `studio/` | Making apps: previews, Save, Discard and Undo, the code the host keeps, and the web builds with the apps in them | `apps` |
| `chats/` | The conversations, and the lines the host adds to a message, such as a routine's |  |
| `routines/` | What the imp does on a schedule, each in a conversation of its own | `chats` |
| `notices/` | What the person is told while they are away: a routine's run, a key the imp asks for, a reply it finished | `chats`, `routines`, `secrets` |
| `memory/` | The memory contract and the knowledge graph behind it | `chats` |
| `secrets/` | The vault, the egress proxy and typing logins into Chrome | `machine` |
| `computer/` | The owner's choice of computer, every machine provider, the runtime the host installs, and the screen | `machine` |
| `machine/` | The machine adapter contract that every provider meets |  |
| `backup/` | Every saved version of the apps' code, in git and on GitHub | `apps` |
| `account/` | The ChatGPT sign-in and the model's credentials |  |
| `tricks/` | The browser tasks the imp keeps on its computer |  |
| `update/` | The host's updates to the latest release |  |

`npm run check` enforces this map (`scripts/boundaries.ts`). It refuses three things: an import of another part's inner file, a use of a part the table doesn't list, and an import of the top files from inside a part. It also keeps two packages to one place each: `e2b` to the E2B adapter, and `node:sqlite` to the apps' data and the credentials. A part that needs another one, or a new part, changes the table there and here in the same commit.

The agent and the client reach each part the same way. A part installs its tools and prompt section on the agent's registry, usually from its `tools.ts`, and `shell-api.ts` gives its reads and changes the client's names. A part tells the open views about a change by its topic (`kernel/live.ts`), never by calling the views.

## The client

The client (`client/`) is written in Exact's Contract language. Everything it shows is a live stream: `GET /api/live/<source>` is a server-sent event stream that sends the answer when it opens, and again whenever a topic it depends on changes (`host/src/kernel/live.ts`). Every change is a `POST /api/call/<name>` with JSON arguments, which answers `{ ok, error }`.

Writes name the topics they change, so a change by the imp and a change by you reach every open view the same way. When the imp adds a todo, your open Todos tab updates.

The microphone button in the composer dictates a message with the browser's own speech recognition (Exact's `@exact/speech-recognition`), so the host never hears the audio. Words join the draft as the recognizer settles on them, and the ones it is still unsure of show above the field. Sending while dictating sends those too. The browser chooses where recognition runs: Chrome and Safari send the audio to Google's or Apple's speech service. Browsers without speech recognition, and the Mac app, show no microphone.

Each command with a shortcut is a button that declares its chord (`aria-keyshortcuts`), so the chord works only while that button is on the screen, and the Mac app lists it in its menu bar. ⌘L is the one exception: the message box it moves to is no button, so the app's root `key` handler takes it, and it is not in the menu bar.

| Keys | What it does | Where |
| --- | --- | --- |
| ⌘N | New chat | Every page: the sidebar's New chat beside the chat on a wide window, the page header's button elsewhere |
| ⌘1 to ⌘9 | Open the chat, then each app and the Computer in the bar's order | Always |
| ⌘, | Open Settings | Always |
| ⌘L | Put the cursor in the message box: the chat's beside an app, else the chat tab's, which it opens | Always |
| ⌘. | Stop the imp | While it works and the message box is empty |
| ⌘S | Save an app's preview | While the app shows one |
| ⌘R | Run the open routine now | In a routine's conversation |
| ⌃⌘S | Open or close the conversations drawer | The chat on a narrow window |
| Escape | Close the drawer | While it is open |
| ⌃⌘C | Show or hide the chat beside an app | An app on a wide window |

In the Mac app (or an installed desktop web app, so not in a browser tab, where the browser keeps ⌘N and ⌘1 to ⌘9 for itself), New chat shows its keys in the sidebar, and holding ⌘ alone for a moment puts each visible control's keys on its corner until ⌘ is let go.

> [!NOTE]
> The Contract compiler finds Exact's modules in a `node_modules` folder. `scripts/link-exact.sh` links the ones `client/app.contract` uses from the Exact checkout into `client/node_modules`, and setup, CI and releases run it. The host links them the same way into the copy of the client it builds.

## The agent's computer

The computer runs one process the host puts there, **agentd** (`host/machine/agentd.ts`, which the host installs with its types stripped). It serves everything on one port, and every connection must present the machine's token, which the host derives from its own secret:

| Path | What it carries |
| --- | --- |
| `/health` | A hash of the token and the runtime's version, so the host can tell whether this agentd is the one it would start. |
| `/pi-env` | A [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env) daemon: the agent's file and shell tools. |
| `/apps` | The app daemon: one worker per app's server code. |
| `/screen` | The desktop, a VNC stream bridged to x11vnc on a local socket. |
| `/egress` | The egress proxy's tunnels to the host, which adds your API keys. See [The secrets vault](vault.md). |

`host/machine/setup.sh` decides what is installed on every computer: a pinned Node, a virtual display with a light desktop, and Chrome. It runs as root whenever the computer has not run this exact version, and every step is safe to run again, because computers are durable and keep what earlier versions installed.

How the host reaches agentd depends on the provider. That is the [machine adapter](machines.md)'s job, and nothing else in the host knows which provider runs the computer.
