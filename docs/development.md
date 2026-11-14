# Development

You need Node 24+ and git. From the root of the repository:

```sh
npm run setup   # a few minutes the first time
npm start       # http://localhost:8787
```

Setup installs Bun and Rust when they are missing, puts [Exact](https://github.com/expo/exact) at the commit in `client/exact-rev` where the client looks for it (`tools/exact` two directories above the repository, or `EXACT`), installs what Exact's web build reads, runs `npm ci` for every workspace and the lint and type tooling, and builds the web client. Most of the first run is that build compiling Exact's web tools; later builds take seconds. `npm run setup:mac` sets up the Mac app's build too, on macOS, after which `cd client && bun exact.mjs mac` builds it. The host needs all of this because it rebuilds the web client whenever the imp previews an app. Run setup again after a pull that moves `client/exact-rev`.

Open the app, continue with ChatGPT, enter the code it shows, and pick a computer in Settings. `MACHINE=local npm start` instead fixes the agent's computer to a directory on this one, with no isolation.

## The repository

The repository is a [Turborepo](https://turborepo.com) monorepo on npm workspaces, `host/` and `client/`. `npm run build`, `npm run dev` and `npm test` at the root run each package's script of that name through turbo.

| Path | What it holds |
| --- | --- |
| `host/` | The host: the agent, the app gateway, the studio, memory, the vault and the HTTP API. Node runs its TypeScript directly. |
| `host/machine/` | What runs on the agent's computer: agentd and `setup.sh`, which decides what is installed there. |
| `client/` | The app you open, in [Exact](https://github.com/expo/exact)'s Contract language. |
| `client/apps/<id>/` | One app per folder: `app.json`, its screen (`app.contract`) and its server code (`server.ts`). |
| `sdk/` | The typed surface an app's server code is written against. |
| `docs/` | These docs, in plain Markdown. |
| `scripts/` | Setup, packaging, the host and Mac installers, and the lint policy's probes. |

`AGENTS.md` holds the conventions code in the repository follows, and `.agents/setup` sets up an [Amp](https://ampcode.com) orb with `npm run setup`.

## Checks

| Command | Where | What it checks |
| --- | --- | --- |
| `npm run check` | root | Lint, the lint policy, formatting and types. CI runs it. |
| `npm test` | root | The host's HTTP API tests, each against its own host with a scripted model. CI runs it. |
| `bun exact.mjs test web` | `client/` | The client against a host with a fake model. |
| `node scripts/smoke-machine.ts` | `host/` | One machine adapter on its own. |

After you change an app in `client/apps/` by hand, run `node host/scripts/shell.ts` to rewrite its wiring in the client.
