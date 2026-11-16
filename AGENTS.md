# Imp

Rules and conventions you can't read from the code. For how things work, read the code.

- A secret's value lives only in the vault. The only code that reads it back is mitmproxy's addon (`host/src/secrets/inject.py`) and `signIn` in `host/src/secrets/logins.ts`. Never log it, show it, or send it to the agent's machine. The machine gets stand-ins for API keys, and a login is typed straight into its own site's page.
- An app's data never leaves the host. Only `apps/data.ts` opens an app's SQLite file.
- `host/src` has one folder per bounded context, and the folders are the architecture (`docs/architecture.md` draws the map). From outside a context, import only its entry, `<context>/<context>.ts`, and export from there what others need. A context may use only the contexts `scripts/boundaries.ts` lists for it, and `pnpm check` refuses the rest. Put new code in the context that owns the behavior. When it needs another context, or a new context, change the map in `scripts/boundaries.ts` and `docs/architecture.md` in the same commit, and say why in its message. Never work around the check with a re-export that hides who depends on whom.
- If you change `scripts/boundaries.ts`, add a crossing to `scripts/lint-policy.ts` that shows the check refuses it.
- Where code goes, in this order. Code that runs on the agent's machine goes in `host/machine/`. Code that owns data, a setting, a package or a product rule goes in the context that owns that behavior, or in a new context. Something only the files at the top of `host/src` read is still a context, one no other context uses, as `flags/` is. Code several contexts need belongs to the context whose concept it is, or is a context of its own named for what it does, such as `live/` or `processes/`. There is no shared folder every context may use. The files at the top of `host/src` only open the contexts and connect them.
- Name a context the person can see by the name the app shows for it, in the sidebar, in Settings or in `docs/`: `tricks/`, `routines/`, `secrets/`. Name one they never see by what it does. A file or function that maps directly to something in the app uses the app's word too.
- Code in `host/machine/` runs on the agent's machine with its types stripped. It may use the `ws` package and nothing else, and import only types from `host/src`, from a context's entry. `pnpm check` refuses the rest.
- Only `host/src/server.ts` reads settings from the environment. Every other part is handed what it needs through `HostOptions`, and `pnpm check` refuses a `process.env.<NAME>` anywhere else.
- Each machine provider is an adapter in `machine/`, and only `computer/machines.ts` picks one, from the owner's choice. Everything else goes through the `Machine` interface in `machine/machine.ts`.
- The shell keeps at most five live streams open. Browsers allow six connections per server, and a sixth makes every other request hang. Put new shell state on a stream that already exists, as `account` carries the computer, memory, secrets and backup. An app's stream is open only while its tab is.
- Every program the host starts registers with `killOnExit` (`processes/processes.ts`), so it stops when the host stops.
- Read JSON files in the data directory with `readKept` (`datadir/datadir.ts`). A damaged file must never stop the host.
- Check anything that comes from outside the process (files, HTTP, `JSON.parse`, child processes, the model's tool arguments, the agent's machine) against a `pi-schema` schema before using it.
- When you add a new top-level name to the shell's API, add it to `RESERVED` in `apps/folders.ts` too, so no app can take it as its id.
- Don't edit the `// <apps:…>` blocks in `client/app.contract` and `client/app.ts` by hand. They are generated: run `node host/scripts/shell.ts`.
- Code in `host/src` and `host/machine` may only import packages listed under `dependencies` in `host/package.json`. In a checkout the root's packages resolve too, from the root's `node_modules`, but a release ships only the host's own dependencies.
- Node runs the host's TypeScript as it is, so use only syntax that can simply be erased: no enums, namespaces or constructor parameter properties.
- The lint rules are strict on purpose. Fix the code, not the config, and don't add `oxlint-disable` comments. There are two exceptions: a type assertion that truly can't be avoided (with a `// SAFETY:` comment above it saying why it holds), and a retry or polling loop that must wait one step at a time. Write the reason after `--`.
- If you change `oxlint.config.ts`, add a probe to `scripts/lint-policy.ts` that shows the rule fires.
- When a file or function grows past a lint limit, split it by what each part is responsible for, and say so in the new file's opening comment.
- `client/exact-rev` is the only place that pins Exact's version. Setup, CI and releases all read it.
- A new feature lands for everyone, unless the user says it goes behind a feature flag; say in the chat which it does, without asking. A flag is declared in `host/src/flags/flags.ts`, off by default, and `host.ts` hands the parts what it changes; no part decides a flag itself.
- Every change to what Imp does needs a changeset in the same commit: `.changeset/<name>.md`, marked `patch` or `minor`, with a sentence or two written for the person using Imp. Pushing to `main` releases it to every installed host. A refactor says `Changeset: none` in its commit message instead. Changes to tests, CI and docs need neither.
- When the host's behavior, settings or files change, update the page in `docs/` that describes it.
- New behavior in the host's HTTP API gets a test in `host/test/`.
- Before calling a change done, run `pnpm check` and `pnpm test`. If you touched the client or what the host sends it, also run `bun exact.mjs test web` in `client/`.
