# Development

You need Node 24+ and git. From the root of the repository:

```sh
sh scripts/setup.sh  # a few minutes the first time
pnpm start           # http://localhost:8787
```

Setup installs pnpm, Bun and Rust when they are missing, puts [Exact](https://github.com/expo/exact) at the commit in `client/exact-rev` where the client looks for it (`tools/exact` two directories above the repository, or `EXACT`), installs what Exact's web build reads, runs `pnpm install` for every workspace and the lint and type tooling, and builds the web client. Most of the first run is that build compiling Exact's web tools; later builds take seconds. `sh scripts/setup.sh mac` sets up the Mac app's build too, on macOS, after which `cd client && bun exact.mjs mac` builds it. The host needs all of this because it rebuilds the web client whenever the imp previews an app. Run setup again after a pull that moves `client/exact-rev`.

Open the app, continue with ChatGPT and enter the code it shows (or use an API key), then pick a computer. `MACHINE=local pnpm start` instead fixes the agent's computer to a directory on this one, with no isolation.

## The repository

The repository is a [Turborepo](https://turborepo.com) monorepo on pnpm workspaces, `host/` and `client/`. `pnpm build`, `pnpm dev` and `pnpm test` at the root run each package's script of that name through turbo.

| Path | What it holds |
| --- | --- |
| `host/` | The host: the agent, the app gateway, the studio, memory, the vault and the HTTP API. Node runs its TypeScript directly. |
| `host/src/<context>/` | One part of the host each, such as `apps/` or `secrets/`, which the others reach only through `<context>/<context>.ts`. [Architecture](architecture.md#the-hosts-contexts) lists them and what each may use. |
| `host/machine/` | What runs on the agent's computer: agentd and `setup.sh`, which decides what is installed there. |
| `client/` | The app you open, in [Exact](https://github.com/expo/exact)'s Contract language. |
| `client/apps/<id>/` | One app per folder: `app.json`, its screen (`app.contract`) and its server code (`server.ts`). |
| `sdk/` | The typed surface an app's server code is written against. |
| `docs/` | These docs, in plain Markdown. |
| `scripts/` | Setup, packaging, the host and Mac installers, the check of the host's context map (`boundaries.ts`), and the lint policy's probes. |

`AGENTS.md` holds the conventions code in the repository follows, and `.agents/setup` sets up an [Amp](https://ampcode.com) orb with `scripts/setup.sh`.

## Checks

| Command | Where | What it checks |
| --- | --- | --- |
| `pnpm check` | root | Lint, the host's context map, the lint policy, unused files, exports and dependencies ([knip](https://knip.dev), `knip.config.ts`), formatting and types. CI runs it. |
| `pnpm test` | root | The host's HTTP API tests, each against its own host with a scripted model. CI runs it. |
| `bun exact.mjs test web` | `client/` | The client against a host with a fake model. |
| `node scripts/smoke-machine.ts` | `host/` | One machine adapter on its own. |

After you change an app in `client/apps/` by hand, run `node host/scripts/shell.ts` to rewrite its wiring in the client.
