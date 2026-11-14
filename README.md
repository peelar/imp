<img src="client/assets/icons/app/icon-512.png" alt="The imp: a woodcut face with horns" width="112">

# Imp

Your own imp: a self-hosted assistant that runs errands in your apps and builds new ones for you.

Chat is home. Ask for something, and the imp does it on a Linux computer of its own. Ask for a tool, and it builds
an app that stays: a screen you keep using, which the imp can also operate for you.

> Early prototype. Expect everything to change.

## How it fits together

- **`host/`** is the server. It runs the agent on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
  signs in to ChatGPT (your Plus or Pro plan is the model), keeps each app's data in SQLite, and serves the client.
  The agent's computer is durable (its home directory survives suspends, reboots and host restarts), and you pick it
  in Settings: Imp cloud (an [E2B](https://e2b.dev) sandbox, on its free plan) or a Linux computer of yours on your
  tailnet, which the host reaches over Tailscale SSH. Both sit behind one adapter contract (`host/src/machine.ts`),
  and wherever it runs, the host decides what is installed: `host/machine/setup.sh`. The computer has a desktop with
  Chrome on it; open **Computer** in the app to watch your imp work there, or take over (`host/src/screen.ts`).
- **`client/`** is the app, written in [Exact](https://github.com/expo/exact)'s Contract language. It runs on the web
  today and keeps iOS and macOS in reach.
- **`client/apps/<id>/`** holds each app: `app.json`, its screen (`app.contract`, a `component Screen` whose props
  name the app's operations) and its server code (`server.ts`, which declares those operations and runs in a worker
  on the agent's computer). The agent finds and runs any app's operations through two tools.
- **`sdk/`** is the typed surface an app's server code is written against.
- **`docs/`** is the website: a landing page and the docs for people who host their own Imp, built with
  [Blume](https://useblume.dev). `npm run dev -w @imp/docs` serves it.
- **Memory.** The imp remembers what it learns about you, and about itself (a name you give it, how it should
  speak), across conversations, and Settings lists all of it with a way to forget each fact. The default is the Model
  Context Protocol's [reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
  used as a library: a knowledge graph in one JSONL file, `memory.jsonl` in the data directory, that you can also open
  in an editor. The imp writes to it with tools while it works, and after every answer a background task asks the
  model what the exchange taught it, so it remembers without being told to. Another memory system implements
  `MemorySystem` in `host/src/memory.ts` and is passed to `startHost()` as `memory`.
- **Secrets.** API keys you add in Settings (GitHub, OpenAI, Anthropic, Linear, or any HTTPS API) work on the imp's
  computer without the imp or its computer holding them. They live in an [OpenBao](https://openbao.org) the host runs
  in its data directory (`host/src/vault.ts`); the computer gets a stand-in such as `GITHUB_TOKEN=imp-secret-github`,
  and its HTTPS requests to a key's hosts go through agentd to a [mitmproxy](https://mitmproxy.org) on the host, which
  puts the key on them and takes it out of the response (`host/src/egress.ts`). It works the same on Imp cloud and on
  your own computer. The host downloads pinned, checksummed builds of both the first time it needs them
  (`host/src/tools.ts`). Settings lists each key's latest uses, and OpenBao's audit log (`vault/audit.log`) records
  every read. When the imp needs a key it does not have, it asks for it in Settings, never in the chat.

The repository is a [Turborepo](https://turborepo.com) monorepo on npm workspaces: `host/`, `client/` and `docs/` are
its packages, and one `npm ci` at the root installs them all with the lint and type tooling. `npm run build`,
`npm run dev` and `npm test` run each package's script of that name through turbo.

## Apps the imp builds

Ask for an app and the imp writes its folder on its own computer, then calls `preview_app`. The host takes only that
folder, tries the server code on a copy of the app's data, writes the shell's wiring for the app's screen
(`host/src/shell.ts`) and rebuilds the web client, which takes a few seconds. The app's tab then shows the new
version as a preview, on a copy of the data, with Save and Discard; open pages reload into it by themselves. Only
Save touches the real data, and the version before it can be undone for 48 hours. The host keeps the apps it holds
and their history in `DATA_DIR` (`host/studio/GUIDE.md` is what the imp reads about the format).

Every save and undo also commits the apps' code to a git repository in `DATA_DIR/backup`, so every version is kept.
**Backup** in Settings connects GitHub with a device code, like the ChatGPT sign-in, and the host then pushes each
version to a private `imp-apps` repository of yours (`host/src/backup.ts`). Only code is backed up; the apps' data
stays on the host. This needs `git` on the host, and the [GitHub CLI](https://cli.github.com) (`gh`) for GitHub.

After changing an app in `client/apps/` by hand, run `node host/scripts/shell.ts` to rewrite its wiring in the client.

There is no login page. Put the host behind [Tailscale](https://tailscale.com) (`tailscale serve`), which decides who
gets in; `OWNER_LOGIN` narrows it to one person.

## Installing it

On the machine that will run your Imp (Linux with systemd, or macOS), with Node 24+:

```sh
curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
```

It installs the latest release in `~/.imp` as a service, serves it on your tailnet (`tailscale serve`), and prints one
link. Open it, sign in with ChatGPT, and give your imp a computer in Settings: paste an E2B key for Imp cloud, or pick
a Linux computer on your tailnet (Settings shows the one command to run on it and the policy rule to add). Then, if you
want the Mac app:

```sh
curl -fsSL https://<your host>.ts.net/install-mac.sh | sh
```

That puts Imp in `~/Applications`, already connected to that host. `sh install-mac.sh --uninstall` removes it.

Both keep themselves at the latest release. The host checks every hour, and restarts into a new release once the
agent is idle; open pages then reload. Set `IMP_AUTO_UPDATE=0` in `~/.imp/env` to stop that. The Mac app checks at
login and every hour, and replaces itself (quitting and reopening if it is running). It is not signed with an Apple
Developer ID; macOS opens it because curl doesn't quarantine what it downloads.

**Releasing.** Each PR adds a changeset (`npm run changeset`, bumping `@imp/host`, whose version is Imp's) or carries
the `skip changeset` label. On `main`, `.github/workflows/release.yml` keeps a release PR open with the next version
and its changelog. Merging it builds the host and web client on Linux and the Mac app on macOS (`scripts/package.sh`),
and publishes them as a GitHub release. See `.changeset/README.md`.

## Running it from a checkout

You need Node 24+, Bun, a checkout of Exact next to this repository (or set `EXACT` to its path), and the Rust
toolchains its web build pins (`bun exact.mjs setup --check` in `client/` names what is missing): the host rebuilds
the web client whenever the imp previews an app.

```sh
npm ci
cd client && API_BASE_URL= bun exact.mjs web-build --out dist
cd ../host && node src/server.ts   # http://localhost:8787
```

Open the app, continue with ChatGPT, enter the code it shows, and pick a computer in Settings. `MACHINE=local` instead
fixes the agent's computer to a directory on this one, with no isolation; `host/src/server.ts` describes the rest.
`node scripts/smoke-machine.ts` checks a machine adapter on its own.

**Checks.** After `npm ci` at the root:

```sh
npm run check   # oxlint (Ultracite's core and anti-slop rules, type-aware), the lint policy probes, oxfmt, tsc
npm test        # the host's HTTP API against a host with a fake model and a local machine
npx turbo run build --filter=@imp/docs   # the docs site
cd client && bun exact.mjs test web   # the client against the same host
```

`.github/workflows/ci.yml` runs the first three on every push and pull request. `AGENTS.md` says what the rules ask of
new code.

## Credits

Fonts: Instrument Serif, Newsreader, Pinyon Script and IBM Plex Mono, under the SIL Open Font License
(`client/assets/fonts`).
