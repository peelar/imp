# Imp

The repository is a Turborepo monorepo on npm workspaces (`turbo.json`, the root `package.json`): `host/`, `client/` and `docs/` are its packages. `host/` is the host: Node runs its TypeScript directly, so there is no build step and only erasable syntax (no enums, namespaces or parameter properties). `sdk/app.ts` is the contract an app's `server.ts` is written against. `client/` is the Exact shell and has its own `AGENTS.md`; `client/apps/<id>/` holds one app per folder. `docs/` is the website and the self-hosting docs, a [Blume](https://useblume.dev) site: Markdown in `docs/content`, the landing page in `docs/pages/index.astro`.

## Checks

- Install once: `npm ci` at the root installs every workspace's dependencies and the lint, format and type tooling into one `node_modules`. Add a dependency to the package that uses it (`npm install <name> -w @imp/host`), never to the root unless it is tooling.
- Before you call a change done, run `npm run check` (lint, the lint policy probes, formatting, types) and `npm test` (`turbo run test`: the host's API tests, about a minute) at the root. CI runs the same two, then builds the docs (`npx turbo run build --filter=@imp/docs`).
- `npm run lint:fix` formats and applies the automatic fixes. Run it before fixing diagnostics by hand; some fixes only apply on a second run.
- After a change to the client, or to what the host sends it, also run `cd client && bun exact.mjs test web` (needs Bun and Exact; see `client/AGENTS.md`). CI's studio job runs those, and the studio's API tests, with Exact pinned in `.github/workflows/ci.yml`; move that pin when the client needs a newer Exact.
- After a change to the host's behavior, settings or files, update the page in `docs/content` that describes it. Write callouts as `<Callout>` components, not `:::` directives, which oxfmt folds onto one line.
- A new behavior of the host's HTTP API gets a test in `host/test/`, in the file for its part of the API (`api.test.ts`, `secrets.test.ts`, `backup.test.ts`, `egress.test.ts`, `machine-ssh.test.ts`). Each file starts its own host with a scripted model (`host/test/harness.ts`, `host/scripts/test-host.ts`). The host's `test` script runs the files one at a time: on a fresh machine, hosts that download and start OpenBao and mitmproxy together are slow enough to miss the tests' waits.
- A change to what Imp does adds a changeset in the same commit: `.changeset/<name>.md` with `"@imp/host": patch` (or `minor` for a feature) in its front matter and one or two sentences for the changelog, written for the person using Imp. Pushing it to `main` releases it to every installed host. Refactors, tests, CI and docs need none.

## Lint policy

The rules in `oxlint.config.ts` are strict on purpose. Fix a diagnostic by changing the code, not the config, and do not add `oxlint-disable` comments. Three exceptions, each with its reason written after `--`:

- A type assertion the type system cannot avoid (a library typed `any`): put `// SAFETY: <the invariant that makes it true>` above it, then `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <why>`.
- A poll or retry loop that must await in sequence: `// oxlint-disable-next-line no-await-in-loop -- <why>`. Independent work uses `Promise.all`.
- `sdk/app.ts` keeps `run` as a method signature so apps can narrow its arguments.

What the rules ask for, where the answer is a design choice:

- Data from outside the process (files, `JSON.parse`, HTTP, child-process output, the model's tool arguments, messages from the agent's machine) is checked with a compiled `@earendil-works/pi-schema` schema before use. `host/src/protocol.ts` and `host/src/computer-choice.ts` show how.
- `typeof` appears only inside a type-predicate function. No parameter is typed `unknown` except one named `cause`. JSON values are `Json` from `sdk/app.ts`, not `Record<string, unknown>`.
- Limits: 500 lines per file, 100 per function, 3 parameters (take one options object beyond that), nesting depth 3, cognitive complexity 15. When a file or function passes one, split it by what each part owns and say that in the new module's opening comment.
- When you change `oxlint.config.ts`, add or update a probe in `scripts/lint-policy.ts` that proves the rule fires.

## Module boundaries in `host/src`

- `host.ts` only composes. What the shell reads and changes is in `shell-api.ts`; how it is served is in `http.ts`.
- `protocol.ts` is the one definition of the messages between the host, agentd, each app's worker and agentd's egress proxy. `host/machine/*.ts` runs on the agent's machine with its types stripped and no packages except `ws`: import types only there, and nothing from `host/src` at runtime.
- `apps.ts` is the app gateway and composes `app-folders.ts`, `app-manifest.ts`, `app-data.ts`, `app-machine.ts` and `app-tools.ts`. An app's data stays on the host; only `app-data.ts` touches its SQLite file.
- `secrets.ts` composes the vault (`vault.ts`, `vault-server.ts`, `vault-files.ts`), the egress proxy (`egress.ts`, `egress-proxy.ts`) and the `secret-*.ts` modules. A secret's value goes into the vault and is read back only by mitmproxy's addon (`host/egress/inject.py`) and, for a login, by `signIn` in `secret-logins.ts`, with a read-only token minted for that one read, to type it into a page of the login's site (`chrome.ts`). Nothing else in `host/src` reads, logs or shows a value, and none goes to the agent's machine except a login typed into its site's page; API keys reach it only as stand-ins.
- `backup.ts` composes `backup-history.ts` (the git repository of the apps' code) and `backup-github.ts` (the sign-in and the repository on GitHub). Both run git and gh only through `backup-commands.ts`, which keeps the host's GitHub sign-in in its data directory and drops GitHub tokens from the environment.
- A program the host starts and must not leave behind registers with `killOnExit` in `children.ts`, the one module that listens for the host's exit.
- A JSON file the host keeps in its data directory is read with `readKept` in `kept.ts`: a damaged one reads as empty and is logged, and never stops the host.
- Only `computer-machines.ts` names a machine provider. Everything else reaches the agent's machine through the `Machine` contract in `machine.ts`.
- The shell opens at most five live streams, because a browser allows six connections per host and a sixth stream makes calls hang. New shell state rides on an existing stream, as the computer, memory, secrets and backup ride on `account`.
- A name the shell's API starts with (such as `memory`) is added to `RESERVED` in `app-folders.ts`, so no app can take it as its id.

## Generated and shipped files

- Never edit or format the blocks between `// <apps:…>` and `// </apps:…>` in `client/app.contract` and `client/app.ts`. Regenerate them with `node host/scripts/shell.ts` after changing an app's Screen props or operations.
- A release ships `host/`, `sdk/` and `client/apps/` (`scripts/package.sh`). The host's production dependencies come from the lockfile pruned to `@imp/host` (`turbo prune`) and ship in `host/node_modules`. Code under `host/src` and `host/machine` may import only the `dependencies` of `host/package.json`. Workspaces hoist every package into the root `node_modules`, so an undeclared import still resolves in a checkout and fails only in a release. The root `package.json` is tooling and is not shipped.
