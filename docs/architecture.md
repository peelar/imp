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

- **The agent** runs on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), with its conversation in `harness.sqlite`. It survives restarts in the middle of a turn. The model is your ChatGPT account, signed in with ChatGPT's device code flow (`host/src/signin.ts`).
- **The app gateway** (`host/src/apps.ts`) loads every app's server code onto the computer and keeps each app's SQLite database on the host. See [Apps](apps.md).
- **The studio** (`host/src/studio.ts`) is where the imp makes apps: it takes an app folder from the computer, checks it, rebuilds the web client, and shows the result as a preview.
- **Memory** (`host/src/memory.ts`) is what the imp knows about you and itself. See [Memory](memory.md).
- **The vault** keeps your API keys, and the egress proxy adds them to the imp's requests. See [The secrets vault](vault.md).

## The client

The client (`client/`) is written in Exact's Contract language. Everything it shows is a live stream: `GET /api/live/<source>` is a server-sent event stream that sends the answer when it opens, and again whenever a topic it depends on changes (`host/src/live.ts`). Every change is a `POST /api/call/<name>` with JSON arguments, which answers `{ ok, error }`.

Writes name the topics they change, so a change by the imp and a change by you reach every open view the same way. When the imp adds a todo, your open Todos tab updates.

The microphone button in the composer dictates a message with the browser's own speech recognition (Exact's `@exact/speech-recognition`), so the host never hears the audio. Words join the draft as the recognizer settles on them, and the ones it is still unsure of show above the field. Sending while dictating sends those too. The browser chooses where recognition runs: Chrome and Safari send the audio to Google's or Apple's speech service. Browsers without speech recognition, and the Mac app, show no microphone.

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
