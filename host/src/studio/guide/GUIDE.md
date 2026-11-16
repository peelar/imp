# Building an Imp app

An app is a folder, `apps/<id>/`, with three files. `<id>` is lowercase letters and digits, such as `calendar`.

- `app.json`: `{ "id": "<id>", "name": "Calendar", "description": "…", "symbol": "symbol:calendar" }`. The description tells you, later, what the app is for.
- `server.ts`: the app's data and operations (below). It runs in a worker with no packages; it may only `import type` from `../sdk.ts`.
- `app.contract`: the app's screen, in Exact's Contract language (below).

## The loop

1. `app_code(app)` writes the app's current code into `apps/<id>/` (a working starter for a new app), with this guide, `apps/sdk.ts` and Contract's docs in `apps/docs/`.
2. Edit the three files.
3. `preview_app(app)` checks everything: server.ts loads, its migrations apply to a copy of the user's data, and the screen compiles. If something fails it says what and where; fix it and call `preview_app` again.
4. When it passes, the user sees the new version in the app's tab, on a copy of their data, with Save and Discard. Only the user saves. Ask them to try it, and keep improving it with each `preview_app` until they save.

To change an app that exists, start with `app_code` too: `apps/<id>/` in your workspace may be gone or old.

An app whose `app.json` says `"server": "imp"` comes with Imp: its `server.ts` and `app.json` are Imp's, and `preview_app` refuses a version that changes them. Change only its `app.contract`. If the screen the user wants needs data the operations do not give, tell them what is missing.

## server.ts

```ts
import type { AppServer } from "../sdk.ts";

export default {
  // Migrations, in order. Never edit or remove one the user's data has had: add new ones at the end.
  schema: [
    "CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, day TEXT NOT NULL)",
  ],
  operations: {
    events: {
      kind: "read",
      description: "Every event, with its id, title and day (YYYY-MM-DD).",
      params: {},
      run: async (_args, app) => {
        const rows = await app.db.all<{
          id: number;
          title: string;
          day: string;
        }>("SELECT id, title, day FROM events ORDER BY day");
        return rows.map((row) => ({
          id: String(row.id),
          title: row.title,
          day: row.day,
        }));
      },
    },
    addEvent: {
      kind: "write",
      description: "Add an event on a day.",
      params: {
        title: { type: "string" },
        day: { type: "string", description: "YYYY-MM-DD" },
      },
      run: async ({ title, day }, app) => {
        await app.db.run(
          "INSERT INTO events (title, day) VALUES (?, ?)",
          String(title),
          String(day)
        );
        return { ok: true, error: "" };
      },
    },
  },
} satisfies AppServer;
```

- Operation names are camelCase. Every operation needs a description and `params` (`{}` for none). Param types: `string`, `number`, `integer`, `boolean`, `enum` (with `values`); `optional: true` makes one optional.
- `app.db` is SQLite: `all`, `get`, `run`, `batch` (one transaction). Its data is the user's and stays across versions.
- A write may return `{ ok: false, error: "why" }` to refuse; anything else counts as done.
- The main agent (you, later, in chat) finds every operation with `find_app_actions` and runs it with `run_app_action`, so give each one a description that says what it does. Add operations only an agent needs, such as a calculation, freely. `agent: false` hides one from the agent; use it only for what must stay the user's.
- An answer the screen reads must match the screen's shape exactly: return only the fields the shape declares.

## Reading a service: connections and sync

An app can read the user's services, such as their GitHub pull requests, and keep a copy current. It only reads: it cannot write to a service.

```ts
export default {
  schema: [
    "CREATE TABLE prs (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL)",
  ],
  // Every host the app reads. `secret` names the user's key that goes on its requests; `query` is the one path it may
  // POST a read to, for a GraphQL API. The user sees this list before they save.
  connections: [
    { host: "api.github.com", secret: "github", query: "/graphql" },
  ],
  sync: {
    every: "15m", // or "1h", "6h", "1d"
    // Optional, at most 5: URLs that say when there is something new. The host asks them about once a minute, cheaply,
    // and runs the sync when one's answer changed.
    watch: ["https://api.github.com/notifications"],
    run: async (app) => {
      const answer = await app.fetch(
        "https://api.github.com/search/issues?q=is:pr+is:open+author:@me"
      );
      if (answer.status !== 200)
        throw new Error(`GitHub answered ${answer.status}`);
      const { items } = JSON.parse(answer.body);
      await app.db.batch([
        { sql: "DELETE FROM prs" },
        ...items.map((pr) => ({
          sql: "INSERT INTO prs (id, title, url) VALUES (?, ?, ?)",
          params: [String(pr.id), pr.title, pr.html_url],
        })),
      ]);
    },
  },
  operations: {/* reads that answer from app.db, as usual */},
} satisfies AppServer;
```

- `app.fetch(url, { method, headers, body })` answers `{ status, headers, body }`, the body as text. It reaches only the hosts in `connections`, over HTTPS, with GET or HEAD, or POST to a connection's `query` path. The host puts the user's key on the request; you never see it. It throws when a request breaks a rule, and `needs secret <name>` when the user has no such key: then call request_secret.
- The host runs `sync` on the live version: when its tab opens and the copy is due, on Sync now, on schedule while the user's computer is awake, and when a `watch` URL's answer changed. Never in a preview, so the preview shows the live data's copy. Fetch everything first, then write it in one `app.db.batch`, so a failure halfway keeps the last copy whole. Throw when something fails: the app's bar shows the error.
- Operations answer from `app.db`, not from `app.fetch`: a read runs again after every write.

## app.contract

The file declares its shapes and one `component Screen`. The shell shows the Screen in the app's tab, below its own bar and inside a scroll, and feeds it through its props. **Each prop names an operation in server.ts:**

- a prop whose type is a value (`events: Event[]`) gets that read's answer, live: it updates after every write, by the user or by the agent. Such a read must take no params; filter and sort in the screen. **Give the screen one such prop**: each is a live stream, and the shell has room for one more. With two, the screen's writes hang. Put everything the screen shows in one read's answer, as an object.
- a prop of type `action` (`addEvent: action`) is that write; the screen calls it with the write's params in order: `addEvent(title, day)`.

The screen cannot declare `resource`, `mutation` or `task` (only the shell's root can). It keeps its own `state`, `derive`s and `action`s, and may declare more components and `fn`s in the same file.

```contract
shape Event
  id: string
  title: string
  day: string

component Screen
  props
    events: Event[]
    addEvent: action
  state title = ""
  action edit(value: string)
    title = value
  action add
    if title.trim() != ""
      addEvent(title.trim(), "2026-11-13")
      title = ""
  view
    column max-width="48.5rem" margin="0 auto" padding="28px 20px 32px" gap=16 box-sizing="border-box" width="100%"
      row gap=8
        input value=title input=edit submit=add placeholder="New event" aria-label="New event" flex=1
        button press=add disabled=(title.trim() == "") testId="event-add"
          text "Add"
      for e in events key=e.id
        row gap=12 padding="10px 0" border-bottom="1px solid line.subtle"
          text e.day font-family="family.mono" color="ink.muted"
          text e.title flex=1
```

Look: Imp's "Catalogue" style. White paper, black ink, square corners, one cobalt accent. Use these colour names: `ink.strong`, `ink.muted`, `ink.faint`, `ink.on-fill`, `line.subtle`, `line.strong`, `surface.page`, `surface.soft`, `AccentColor`; fonts `family.display` (headlines), `family.text`, `family.mono`. The shell's styles are not the app's: declare a `style` in app.contract to use one (the starter declares `Label`, the small mono capitals), and import nothing from outside the app's folder. Icons are `image "symbol:<name>" width=16 height=16`, and app.json's `symbol` is one too, from this set: back close compose add microphone send search copy select-text more delete forward home person messages notifications settings repeat activity bookmark bookmark-fill document select select-fill reorder list cart sort filter heart heart-fill reply share ellipsis home-fill notifications-fill person-fill photo play play-fill pause pause-fill moon pin link checkmark forward-chevron at hashtag follow sign-out quote feeds calendar book layers lock people stop stop-fill circle alert minus-circle pencil waveform info camera star star-fill minus chart sparkles refresh menu adjust alert-fill info-fill chooser download install open-app package mail emoji translate bag bag-fill phone smartphone article radio.

Contract is strict and its compiler explains what it refuses; read the message and fix that line. The language: `apps/docs/start-here.md` first, then search `apps/docs/contract-for-agents.md` (grep a word, such as `input`, `for `, `match`, `fn `). The Todos app (`app_code("todos")`) is a complete example.
