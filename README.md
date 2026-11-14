<img src="client/assets/icons/app/icon-512.png" alt="The imp: a woodcut face with horns" width="112">

# Imp

Your own imp: a self-hosted assistant that runs errands in your apps and builds new ones for you.

Chat is home. Ask for something, and the imp does it on a Linux computer of its own. Ask for a tool, and it builds
an app that stays: a screen you keep using, which the imp can also operate for you.

> [!WARNING]
> Imp is an early prototype. Expect everything to change.

## Features

- **A computer of its own.** The imp works on a durable Linux machine with a desktop and Chrome, either an
  [E2B](https://e2b.dev) sandbox or a computer of yours on your tailnet. You can watch it work there, or take over.
- **Apps it builds for you.** New apps open as a preview on a copy of their data, with Save, Discard and Undo. Every
  version of their code is kept, and can be backed up to a private GitHub repository.
- **Memory.** It remembers what it learns about you and about itself, and Settings lets you forget any of it.
- **Routines.** Ask for something on a schedule, and it runs in a conversation of its own.
- **Secrets it never holds.** API keys and website logins live in a vault on the host, and are added to the imp's
  requests on their way out, so neither the imp nor its computer ever sees them.
- **Yours to host.** Your ChatGPT plan is the model, your data stays on your machine, and Tailscale decides who gets
  in.

## Install

On the machine that will run your Imp (Linux with systemd, or macOS), with Node 24+ and Tailscale:

```sh
curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
```

It installs Imp as a service, serves it on your tailnet and prints one link. Open it, sign in with ChatGPT, and give
your imp a computer in Settings. The host keeps itself at the latest release.
[Install](docs/content/docs/self-hosting/install.mdx) covers the details, and the optional Mac app, which installs from
your host with one command.

## Development

With Node 24+ and git:

```sh
npm run setup   # Bun, Rust, Exact and the dependencies, then a build of the web client
npm start       # http://localhost:8787
npm run check   # lint, formatting and types
npm test        # the host's API tests
```

[Run from a checkout](docs/content/docs/self-hosting/from-source.mdx) explains setup, the repository's layout and the
other checks. [`AGENTS.md`](AGENTS.md) holds the conventions code in this repository follows, and
[`.changeset/README.md`](.changeset/README.md) explains how a change is released.

## Documentation

The [docs](docs/content/docs) cover hosting your own Imp and how it works inside:

- **Self-hosting:** [install](docs/content/docs/self-hosting/install.mdx),
  [the imp's computer](docs/content/docs/self-hosting/computer.mdx),
  [configuration](docs/content/docs/self-hosting/configuration.mdx),
  [updates](docs/content/docs/self-hosting/updates.mdx)
- **How it works:** [architecture](docs/content/docs/how-it-works/architecture.mdx),
  [apps](docs/content/docs/how-it-works/apps.mdx), [machines](docs/content/docs/how-it-works/machines.mdx),
  [memory](docs/content/docs/how-it-works/memory.mdx), [routines](docs/content/docs/how-it-works/routines.mdx),
  [the secrets vault](docs/content/docs/how-it-works/vault.mdx), [security](docs/content/docs/how-it-works/security.mdx)
- **[Building apps](docs/content/docs/building-apps/index.mdx)** by hand

## Credits

Fonts: Instrument Serif, Newsreader, Pinyon Script and IBM Plex Mono, under the SIL Open Font License
(`client/assets/fonts`).
