<p align="center"><img src="assets/imp.jpg" width="360" alt="Imp, a blue-and-white porcelain imp with googly eyes, one finger raised"></p>

# Imp

Your own imp: a self-hosted assistant that runs errands in your apps and builds new ones for you.

Chat is home. Ask for something, and the imp does it on a Linux computer of its own. Ask for a tool, and it builds
an app that stays: a screen you keep using, which the imp can also operate for you.

> Early prototype. Expect everything to change.

## How it fits together

- **`host/`** is the server. It runs the agent on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
  signs in to ChatGPT (your Plus or Pro plan is the model), keeps each app's data in SQLite, and serves the client.
  The agent's computer sits behind a small adapter contract; [E2B](https://e2b.dev) is the one shipped today, plus a
  local adapter for development.
- **`client/`** is the app, written in [Exact](https://github.com/expo/exact)'s Contract language. It runs on the web
  today and keeps iOS and macOS in reach.
- **`client/apps/<id>/`** holds each app: `app.json`, its screen (`app.contract`) and its server code (`server.ts`),
  which runs in a worker on the agent's computer.
- **`sdk/`** is the typed surface an app's server code is written against.

There is no login page. Put the host behind [Tailscale](https://tailscale.com) (`tailscale serve`), which decides who
gets in; `OWNER_LOGIN` narrows it to one person.

## Running it

You need Node 24+, Bun, and a checkout of Exact next to this repository (or set `EXACT` to its path).

```sh
cd host && npm install
cd ../client && API_BASE_URL= bun exact.mjs web-build --out dist
cd ../host && E2B_API_KEY=... node src/server.ts   # http://localhost:8787
```

The host reads `PORT`, `DATA_DIR`, `MACHINE` (`e2b` or `local`), `MODEL` and `OWNER_LOGIN`; `host/src/server.ts`
describes each. Open the app, continue with ChatGPT, and enter the code it shows.

Tests run the client against a host with a fake model: `cd client && bun exact.mjs test web`.

## Credits

Fonts: Instrument Serif, Newsreader, Pinyon Script and IBM Plex Mono, under the SIL Open Font License
(`client/assets/fonts`).
