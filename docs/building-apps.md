# Build an app

The imp builds apps for you when you ask. You can also write one yourself, or change one the imp made. An app is a folder, `client/apps/<id>/`, where `<id>` is lowercase letters and digits, such as `calendar`.

- `client/apps/todos/`
  - `app.json`: the app's name, description and icon
  - `server.ts`: its data and operations, run in a worker on the agent's computer
  - `app.contract`: its screen, in Exact's Contract language

`host/studio/GUIDE.md` is the guide the imp itself reads, and the most complete reference. This page walks through the same ideas with the Todos app.

## app.json

```json
{
  "id": "todos",
  "name": "Todos",
  "symbol": "symbol:checkmark",
  "description": "A list of things to do. The agent can read and change it."
}
```

The description tells the imp, later, what the app is for. `symbol` is the app's icon in the shell.

## server.ts

`server.ts` exports an `AppServer` (`sdk/app.ts`): its migrations and its operations. It runs in a worker with no packages, so it may only `import type` from the SDK.

```ts
import type { AppServer } from "../../../sdk/app.ts";

export default {
  // Migrations, in order. Never edit or remove one the data has had: add new ones at the end.
  schema: [
    "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)",
  ],
  operations: {
    list: {
      kind: "read",
      description:
        "List every todo, with its id, title and whether it is done.",
      params: {},
      run: async (_args, app) => {
        const rows = await app.db.all<{
          id: number;
          title: string;
          done: number;
        }>("SELECT id, title, done FROM todos ORDER BY id");
        return rows.map((row) => ({
          id: String(row.id),
          title: row.title,
          done: row.done === 1,
        }));
      },
    },
    setDone: {
      kind: "write",
      description: "Mark a todo done or not done.",
      params: { id: { type: "string" }, done: { type: "boolean" } },
      run: async ({ id, done }, app) => {
        const { changes } = await app.db.run(
          "UPDATE todos SET done = ? WHERE id = ?",
          done ? 1 : 0,
          Number(id)
        );
        return changes > 0
          ? { ok: true, error: "" }
          : { ok: false, error: `No todo with id ${id}.` };
      },
    },
  },
} satisfies AppServer;
```

- **Operation names are camelCase.** Each needs a `description`, which is what the imp searches, and `params` (`{}` for none). Param types are `string`, `number`, `integer`, `boolean` and `enum` (with `values`); `optional: true` makes one optional.
- **`app.db` is SQLite**, kept on the host: `all`, `get`, `run`, and `batch`, which runs statements in one transaction. The host applies the migrations a database has not had yet, before the first call.
- **A write may refuse** by returning `{ ok: false, error: "why" }`. Anything else counts as done.
- **Every operation is the imp's too**, unless it says `agent: false`. Use that only for what must stay yours.

## Reading a service

An app can read your services, such as GitHub, and keep a copy of what it needs in its database. It names every host it reads in `connections`, with the name of your key for it, and brings the data in with `sync`:

```ts
export default {
  schema: ["CREATE TABLE prs (id TEXT PRIMARY KEY, title TEXT NOT NULL)"],
  connections: [
    { host: "api.github.com", secret: "github", query: "/graphql" },
  ],
  sync: {
    every: "15m",
    run: async (app) => {
      const answer = await app.fetch(
        "https://api.github.com/search/issues?q=is:pr+is:open+author:@me"
      );
      if (answer.status !== 200) {
        throw new Error(`GitHub answered ${answer.status}`);
      }
      const { items } = JSON.parse(answer.body);
      await app.db.batch([
        { sql: "DELETE FROM prs" },
        ...items.map((pr) => ({
          sql: "INSERT INTO prs (id, title) VALUES (?, ?)",
          params: [String(pr.id), pr.title],
        })),
      ]);
    },
  },
  operations: {/* reads that answer from app.db */},
} satisfies AppServer;
```

- **`app.fetch` only reads, from the app's connections.** HTTPS on port 443, GET or HEAD, or POST to a connection's `query` path, because GraphQL APIs take reads by POST. It follows no redirect, and refuses a host that resolves to an address on your host's network. It answers `{ status, headers, body }` with the body as text.
- **Your key goes on the request at the host.** A connection's `secret` names one of your keys in Settings → Secrets. The host sends the request through the same proxy as the imp's commands, which puts the key on it and takes it out of the answer, and **Recent use** names the app. Without the key, `app.fetch` throws `needs secret github`.
- **`sync.every`** is `15m`, `1h`, `6h` or `1d`. See [Apps](apps.md#live-apps-reading-your-services) for when it runs.
- **`sync.watch`** lists up to five URLs that say when the service has something new, such as `https://api.github.com/notifications`. The host asks them itself, cheaply, and runs the sync when one's answer changed, waking the computer if it must. Each must be on one of the app's connections.
- **Fetch everything, then write once.** One `app.db.batch` keeps the last good copy whole when a sync fails halfway. Throw on a failure, so the app's bar says why.

## app.contract

The screen is one `component Screen`. The shell shows it in the app's tab and feeds it through its props, and **each prop names an operation**:

- A prop whose type is a value (`list: Todo[]`) gets that read's answer, live. It updates after every write, yours or the imp's. Such a read takes no params; filter and sort in the screen. A screen gets **one** such prop: each is a live stream, and the shell has room for one more (browsers allow six connections per server). Put everything the screen shows in one read's answer, as an object.
- A prop of type `action` (`setDone: action`) is that write, called with the write's params in order: `setDone(todo.id, not todo.done)`.

```text title="app.contract"
shape Todo
  id: string
  title: string
  done: bool

component Screen
  props
    list: Todo[]
    add: action
    setDone: action
  state draft = ""
  action edit(value: string)
    draft = value
  action addDraft
    if draft.trim() != ""
      add(draft.trim())
      draft = ""
  view
    column max-width="48.5rem" margin="0 auto" padding="28px 20px 32px" gap=16
      input value=draft input=edit submit=addDraft placeholder="Add a todo" aria-label="New todo"
      for todo in list key=todo.id
        row gap=12 padding="10px 0" border-bottom="1px solid line.subtle"
          button press=setDone(todo.id, not todo.done)
            text todo.done ? "Done" : "Open"
          text todo.title flex=1
```

The screen keeps its own `state`, `derive`s and `action`s, and may declare more components and `fn`s in the same file. It cannot declare resources or mutations: only the shell's root can, and the host writes the root's part for every app (`host/src/studio/shell.ts`).

Use Imp's Catalogue colours (`ink.strong`, `ink.muted`, `line.subtle`, `surface.page`, `AccentColor`, …) and fonts (`family.display`, `family.text`, `family.mono`) so the app looks like the rest of Imp.

## Wire it in

After you add or change an app by hand, rewrite the shell's wiring and rebuild the client:

```sh
node host/scripts/shell.ts
cd client && API_BASE_URL= bun exact.mjs web-build --out dist
```

When the imp changes an app, it does this for you through `preview_app`, and you see a preview with Save and Discard. See [Apps](apps.md) for how that works.
