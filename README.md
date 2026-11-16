<img src="client/assets/icons/app/icon-512.png" alt="The imp: a woodcut face with horns" width="112">

# Imp

Your own imp: a self-hosted assistant that runs errands in your apps and builds new ones for you.

Chat is home. Ask for something, and the imp does it on a Linux computer of its own. Ask for a tool, and it builds
an app that stays: a screen you keep using, which the imp can also operate for you.

<a href="docs/media/imp-launch.mp4"><img src="docs/media/imp-launch.gif" alt="Imp's launch video: on the web the imp builds a Habits app and it is saved; on an iPhone the imp ticks a habit off when told; the Mac app shows it live; a tick on the Mac reaches the web and the phone at once." width="100%"></a>

> [!WARNING]
> Imp is an early prototype. Expect everything to change.

## Features

- **A computer of its own.** The imp works on a durable Linux machine with a desktop and Chrome: an
  [E2B](https://e2b.dev) sandbox or a computer of yours on your tailnet, or, with neither, a free container on the
  host's own machine (Docker, OrbStack or Podman). You can watch it work there, or take over.
- **Apps it builds for you.** New apps open as a preview on a copy of their data, with Save, Discard and Undo. Every
  version of their code is kept, and can be backed up to a private GitHub repository.
- **Memory.** It remembers what it learns about you and about itself, and Settings lets you forget any of it.
- **Routines.** Ask for something on a schedule, and it runs in a conversation of its own.
- **Secrets it never holds.** API keys and website logins live in a vault on the host, and are added to the imp's
  requests on their way out, so neither the imp nor its computer ever sees them.
- **Yours to host.** Your ChatGPT plan (or any OpenAI-compatible API key) is the model, your data stays on your machine, and Tailscale decides who gets
  in.

## Install

On the machine that will run your Imp (Linux with systemd, or macOS), with Node 24+ and Tailscale:

```sh
curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
```

It installs Imp as a service and serves it on your tailnet. On a Mac it also installs the Mac app, then opens it and
the web app; on Linux it opens the web app if there is a desktop, and prints its link. Sign in with ChatGPT or an
OpenAI-compatible API key, and give your imp a computer. The host and the Mac app keep themselves at the latest
release. [Install](docs/install.md) covers the details, and the Mac app on another Mac.

## Development

With Node 24+ and git:

```sh
npm run setup   # Bun, Rust, Exact and the dependencies, then a build of the web client
npm start       # http://localhost:8787
npm run check   # lint, formatting and types
npm test        # the host's API tests
```

[Development](docs/development.md) explains setup, the repository's layout and the other checks.
[`AGENTS.md`](AGENTS.md) holds the conventions code in this repository follows, and
[`.changeset/README.md`](.changeset/README.md) explains how a change is released.

## Documentation

The [docs](docs/README.md) cover hosting your own Imp and how it works inside:

- **Self-hosting:** [install](docs/install.md), [the imp's computer](docs/computer.md),
  [configuration](docs/configuration.md), [updates](docs/updates.md)
- **How it works:** [architecture](docs/architecture.md), [apps](docs/apps.md), [machines](docs/machines.md),
  [memory](docs/memory.md), [routines](docs/routines.md), [the secrets vault](docs/vault.md),
  [security](docs/security.md)
- **[Building apps](docs/building-apps.md)** by hand

## License

[MIT](LICENSE).

## Credits

Fonts: Instrument Serif, Newsreader, Pinyon Script and IBM Plex Mono, under the SIL Open Font License
(`client/assets/fonts`).
