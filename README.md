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
- **Memory.** The imp remembers what it learns about you, and about itself (a name you give it, how it should
  speak), across conversations, and Settings lists all of it with a way to forget each fact. The default is the Model
  Context Protocol's [reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
  used as a library: a knowledge graph in one JSONL file, `memory.jsonl` in the data directory, that you can also open
  in an editor. Another memory system implements `MemorySystem` in `host/src/memory.ts` and is passed to `startHost()`
  as `memory`.

## Apps the imp builds

Ask for an app and the imp writes its folder on its own computer, then calls `preview_app`. The host takes only that
folder, tries the server code on a copy of the app's data, writes the shell's wiring for the app's screen
(`host/src/shell.ts`) and rebuilds the web client, which takes a few seconds. The app's tab then shows the new
version as a preview, on a copy of the data, with Save and Discard; open pages reload into it by themselves. Only
Save touches the real data, and the version before it can be undone for 48 hours. The host keeps the apps it holds
and their history in `DATA_DIR` (`host/studio/GUIDE.md` is what the imp reads about the format).

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

**Releasing.** Push a tag: `git tag v0.2.0 && git push origin v0.2.0`. `.github/workflows/release.yml` builds the host
and web client on Linux and the Mac app on macOS (`scripts/package.sh`), and publishes them as a GitHub release.

## Running it from a checkout

You need Node 24+, Bun, a checkout of Exact next to this repository (or set `EXACT` to its path), and the Rust
toolchains its web build pins (`bun exact.mjs setup --check` in `client/` names what is missing): the host rebuilds
the web client whenever the imp previews an app.

```sh
cd host && npm install
cd ../client && API_BASE_URL= bun exact.mjs web-build --out dist
cd ../host && node src/server.ts   # http://localhost:8787
```

Open the app, continue with ChatGPT, enter the code it shows, and pick a computer in Settings. `MACHINE=local` instead
fixes the agent's computer to a directory on this one, with no isolation; `host/src/server.ts` describes the rest.
`node scripts/smoke-machine.ts` checks a machine adapter on its own.

Tests run the client against a host with a fake model: `cd client && bun exact.mjs test web`.

## Credits

Fonts: Instrument Serif, Newsreader, Pinyon Script and IBM Plex Mono, under the SIL Open Font License
(`client/assets/fonts`).
