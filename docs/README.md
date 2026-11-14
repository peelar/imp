# Imp documentation

Imp is a self-hosted assistant. You talk to it in a chat, and it does what you ask on a Linux computer of its own. Ask it for a tool, and it builds an app that stays: a screen you keep using, which the imp can also operate for you.

These docs are for the people who run an Imp: how to install it, how its parts fit together, and why they are built the way they are. They follow the code in [peelar/imp](https://github.com/peelar/imp), and the source files are named on each page, so you can read on from there.

> [!WARNING]
> **Early prototype.** Imp is young. Expect file layouts, settings and contracts to change between releases.

## The parts

- **The host** (`host/`) is the server you run. It runs the agent, signs in to ChatGPT (your Plus or Pro plan is the model), keeps every app's data in SQLite, and serves the app. It listens on localhost only. Tailscale is the door in front of it.
- **The agent's computer** is a durable Linux machine: an [E2B](https://e2b.dev) sandbox ("Imp cloud") or a computer of yours on your tailnet. The agent's tools run there, along with each app's server code and a desktop with Chrome that you can watch.
- **The client** (`client/`) is the app you open, written in [Exact](https://github.com/expo/exact)'s Contract language. It runs on the web today, and there is a Mac app.
- **Apps** (`client/apps/<id>/`) are what the imp builds: a screen, server code, and a SQLite database on the host.
- **The SDK** (`sdk/`) is the typed surface an app's server code is written against.

## Contents

**Self-hosting**

- [Install the host](install.md): one command on a Linux or macOS machine on your tailnet
- [The agent's computer](computer.md): Imp cloud on E2B, or a Linux computer of yours
- [Configuration](configuration.md): the host's environment variables and its data directory
- [Updates and releases](updates.md): how the host and the Mac app stay current, and how a release is made

**How it works**

- [Architecture](architecture.md): the host, the machine, the client, and how a request travels between them
- [Machines](machines.md): the adapter contract every machine provider implements
- [Apps](apps.md): how an app runs, where its data lives, and how a new version reaches your screen
- [Routines](routines.md): what the imp does on a schedule
- [Memory](memory.md): what the imp remembers, and how to plug in another memory system
- [The secrets vault](vault.md): how the imp uses your API keys without ever seeing them
- [Security model](security.md): who can reach your Imp, and where every credential lives

**Building on Imp**

- [Build an app](building-apps.md): the app folder, its operations and its screen, by hand
- [Development](development.md): run Imp from a checkout, and the repository's checks
