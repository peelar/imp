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
                                     │  adapter: a loopback port, E2B URLs, or SSH tunnels
                                     ▼
  ┌──────────────────────── the agent's computer ─────────────────────────┐
  │  agentd (one port, token required)                                    │
  │    /pi-env   the agent's read, write, edit, bash tools                │
  │    /apps     one worker per app's server code                         │
  │    /screen   a desktop with Chrome, over VNC                          │
  └───────────────────────────────────────────────────────────────────────┘
```

## The host

`host/src/host.ts` opens every part and connects them, and serves one HTTP origin on localhost: the built web client, and its API. `host/src/server.ts` starts it, and is the one file that reads settings from the environment.

- **The agent** (`host/src/agent/agent.ts`) runs on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), with its conversation in `harness.sqlite`. It survives restarts in the middle of a turn. The model is your ChatGPT account, signed in with ChatGPT's device code flow (`host/src/account/account.ts`), or a key for an OpenAI-compatible API (`host/src/account/api-key.ts`).
- **The app gateway** (`host/src/apps/apps.ts`) loads every app's server code onto the computer and keeps each app's SQLite database on the host. See [Apps](apps.md).
- **The studio** (`host/src/studio/studio.ts`) is where the imp makes apps: it takes an app folder from the computer, checks it, rebuilds the web client, and shows the result as a preview.
- **Memory** (`host/src/memory/memory.ts`) is what the imp knows about you and itself. See [Memory](memory.md).
- **The vault** keeps your API keys, and the egress proxy adds them to the imp's requests. See [The secrets vault](vault.md).

### The host's contexts

`host/src` has one folder per part of the host that owns its own rules and data. The files at its top (`server.ts`, `host.ts`, `http.ts`, `shell-api.ts`, `static.ts`) put the parts together and serve them. Each part offers itself to the rest through one file named after its folder, such as `apps/apps.ts`. Its other files are its own to change. No part is open to every other: code that several parts need is a part of its own, named for what it does (`live/`, `datadir/`, `processes/`), and the table lists each use of it.

| Folder | What it owns | May use |
| --- | --- | --- |
| `apps/` | The app gateway: each app's code in a worker on the computer, its data in SQLite on the host, its versions, what it reads from outside and its syncs, and the two tools the agent runs apps with | `machine`, `live`, `datadir` |
| `studio/` | Making apps: previews, Save, Discard and Undo, the code the host keeps, and the web builds with the apps in them | `apps`, `live`, `datadir`, `processes` |
| `agent/` | Who the imp is, the registry the parts install their tools and prompt sections on, and the Pi Durable harness that runs it |  |
| `chats/` | The conversations, and the lines the host adds to a message, such as a routine's | `live` |
| `routines/` | What the imp does on a schedule, each in a conversation of its own | `chats`, `live` |
| `notifications/` | What the person is told while they are away: a routine's run, a key the imp asks for, a reply it finished | `chats`, `routines`, `secrets`, `live` |
| `memory/` | The memory contract and the knowledge graph behind it | `chats`, `live` |
| `secrets/` | The vault, the egress proxy and typing logins into Chrome | `machine`, `live`, `datadir`, `processes` |
| `computer/` | The owner's choice of computer, switching to another, their own computers on the tailnet, and the screen | `machine`, `live`, `datadir` |
| `machine/` | The machine adapter contract, every provider's adapter, and the runtime the host installs on every machine | `processes` |
| `backup/` | Every saved version of the apps' code, in git and on GitHub | `apps`, `live`, `datadir` |
| `account/` | The model account: the ChatGPT sign-in or an API key, their credentials, and the model the person chose | `live`, `datadir` |
| `tricks/` | The browser tasks the imp keeps on its computer, and how it uses the web | `live` |
| `update/` | The host's updates to the latest release |  |
| `flags/` | The feature flags: each one's default, deciding them from the owner's `flags.json` or Vercel Flags, and keeping the choice Settings makes for the next start | `datadir`, `live` |
| `live/` | Live answers: the topics a change names, and the streams that answer again when one changes |  |
| `datadir/` | Reading back the JSON files the host keeps in its data directory, so a damaged one never stops the host |  |
| `processes/` | The programs the host runs beside itself, killed when it exits, and the ports they take on its loopback |  |

`npm run check` enforces this map (`scripts/boundaries.ts`). It refuses an import of another part's inner file, a use of a part the table doesn't list, an import of the top files from inside a part, a setting read from the environment anywhere but `server.ts`, and code in `host/machine/` that imports more than types from a part's entry. It also keeps packages to one place each: `e2b` to the E2B adapter, `node:sqlite` to the apps' data and the credentials, and the Flags SDK (`flags`, `@flags-sdk/vercel`) to `flags/flags.ts`, which decides every [feature flag](configuration.md#feature-flags). A part never reads a flag itself: `host.ts` hands it what the flag changes for it, as it hands the app gateway the apps a flag keeps off. A part that needs another one, or a new part, changes the table there and here in the same commit, and the check refuses a table here that differs from the one there. A part the person can see is named as the app names it (`tricks/`, `routines/`, `secrets/`); one they never see is named for what it does.

The agent and the client reach each part the same way. A part installs its tools and prompt section on the agent's registry from its `tools.ts`, and names its reads and changes for the client in its `shell.ts`, which `shell-api.ts` puts together. So a part's folder says what the imp can do with it, what the person can do with it, and what it keeps. A part tells the open views about a change by its topic (`live/live.ts`), never by calling the views.

## The client

The client (`client/`) is written in Exact's Contract language. Everything it shows is a live stream: `GET /api/live/<source>` is a server-sent event stream that sends the answer when it opens, and again whenever a topic it depends on changes (`host/src/live/live.ts`). Every change is a `POST /api/call/<name>` with JSON arguments, which answers `{ ok, error }`.

`client/app.contract` is the root: the routes, and every resource, mutation and action, which Contract allows only there. The screens are in files named as the app names them, as the host's parts are: `chat.contract`, `sidebar.contract`, `routines.contract`, `tricks.contract`, `app-directory.contract`, `apps.contract` (an installed app's tab and page), `computer.contract` and `settings/<section>.contract`. `host.contract` holds the shapes of what the host answers, and `look.contract`, `parts.contract` and `onboarding.contract` what the screens share.

Writes name the topics they change, so a change by the imp and a change by you reach every open view the same way. When the imp adds a todo, your open Todos tab updates.

The microphone button in the composer dictates a message with the browser's own speech recognition (Exact's `@exact/speech-recognition`), so the host never hears the audio. Words join the draft as the recognizer settles on them, and the ones it is still unsure of show above the field. Sending while dictating sends those too. The browser chooses where recognition runs: Chrome and Safari send the audio to Google's or Apple's speech service. The Mac app opens the microphone itself (`@exact/media-capture`) and hands its track to Apple's recognizer, which runs on the Mac. Browsers without speech recognition show no microphone.

Each command with a shortcut is a button that declares its chord (`aria-keyshortcuts`), so the chord works only while that button is on the screen, and the Mac app lists it in its menu bar. ⌘L is the one exception: the message box it moves to is no button, so the app's root `key` handler takes it, and it is not in the menu bar.

| Keys | What it does | Where |
| --- | --- | --- |
| ⌘N | New chat | Every page: the sidebar's New chat beside the chat on a wide window, the page header's button elsewhere |
| ⌘1 to ⌘9 | Open each app and the Computer in the bar's order | Always |
| ⌘, | Open Settings | Always |
| ⌘L | Put the cursor in the message box: the chat's beside the page, else the chat page's, which it opens | Always |
| ⌘. | Stop the imp | While it works and the message box is empty |
| ⌘S | Save an app's preview | While the app shows one |
| ⌘R | Run the open routine now | In a routine's conversation |
| ⌃⌘S | Open or close the conversations drawer | The chat on a narrow window |
| Escape | Close the drawer | While it is open |
| ⌃⌘C | Show or hide the chat beside an app | An app on a wide window |

In the Mac app (or an installed desktop web app, so not in a browser tab, where the browser keeps ⌘N and ⌘1 to ⌘9 for itself), New chat and Settings show their keys in the sidebar, and holding ⌘ alone for a moment puts each visible control's keys on its corner until ⌘ is let go.

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
