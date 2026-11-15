// The GitHub app's server code, which Imp ships and keeps (app.json says "server": "imp"): the screen is the person's
// to change, and this file is Imp's. Its sync brings in what needs the person on GitHub: pull requests waiting for
// their review, their own open pull requests, the issues and pull requests assigned to them, and their unread
// notifications, merged into one item per issue or pull request. The host asks GitHub about the notifications every
// minute or so, cheaply, and runs the sync when they change (sync.watch).
//
// Triage is the app's own and stays on the host: Done and Snooze never change anything on GitHub, and a sync never
// touches them. An item marked done comes back when it changes on GitHub again; a snoozed one when its snooze ends.
// Acting on GitHub (a review, a reply, a merge, marking a notification read) is the imp's, with `gh`.
import type { AppContext, AppServer, Json } from "../../../sdk/app.ts";

const API = "https://api.github.com";

/** One issue, pull request or notification, as the sync writes it. */
type Item = {
  key: string;
  kind: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updated: string;
  review: boolean;
  mine: boolean;
  assigned: boolean;
  reason: string;
  unread: boolean;
};

type Row = Omit<Item, "draft" | "review" | "mine" | "assigned" | "unread"> & {
  draft: number;
  review: number;
  mine: number;
  assigned: number;
  notified: number;
  unread: number;
  triage: string | null;
  until: string | null;
  seen: string | null;
};

type Source = "review" | "mine" | "assigned";

/** What each search finds, by the flag it sets on the items. */
const SEARCHES: readonly (readonly [Source, string])[] = [
  ["review", "is:open is:pr review-requested:@me archived:false"],
  ["mine", "is:open is:pr author:@me archived:false"],
  ["assigned", "is:open is:issue assignee:@me archived:false"],
  ["assigned", "is:open is:pr assignee:@me archived:false"],
];

/** A notification's reason, in words. */
const REASONS = new Map([
  ["review_requested", "Review requested"],
  ["mention", "Mentioned"],
  ["team_mention", "Team mentioned"],
  ["assign", "Assigned"],
  ["author", "You opened it"],
  ["comment", "New comment"],
  ["state_change", "State changed"],
  ["ci_activity", "CI"],
  ["subscribed", "Watching"],
  ["manual", "Subscribed"],
  ["security_alert", "Security alert"],
  ["invitation", "Invitation"],
  ["approval_requested", "Approval requested"],
]);

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// GitHub's answers, read field by field: a field that is missing or of another kind reads as empty.
type Rec = { readonly [key: string]: Json };

const isRec = (value: Json | undefined): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: Json | undefined): value is string =>
  typeof value === "string";

const isCount = (value: Json | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value);

const rec = (value: Json | undefined): Rec => (isRec(value) ? value : {});

const text = (value: Json | undefined) => (isText(value) ? value : "");

const count = (value: Json | undefined) => (isCount(value) ? value : 0);

const list = (value: Json | undefined): Json[] =>
  Array.isArray(value) ? value : [];

/** "owner/repo" from an API URL such as https://api.github.com/repos/owner/repo/pulls/7. */
const repoOf = (apiUrl: string) =>
  /\/repos\/([^/]+\/[^/]+)/.exec(apiUrl)?.[1] ?? "";

/** "14 Nov", the day an ISO time falls on. */
function dayOf(iso: string) {
  const at = new Date(iso);

  return Number.isNaN(at.getTime())
    ? ""
    : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ""}`;
}

/** Fetches a GitHub API path and answers its JSON, or throws what GitHub said. */
async function get(app: AppContext, pathAndQuery: string) {
  const answer = await app.fetch(`${API}${pathAndQuery}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (answer.status !== 200) {
    const message = text(rec(safeJson(answer.body)).message);

    throw new Error(
      `GitHub answered ${answer.status} to ${pathAndQuery.split("?")[0] ?? ""}${message ? `: ${message}` : ""}`
    );
  }

  return safeJson(answer.body);
}

function safeJson(body: string): Json {
  try {
    // SAFETY: what JSON.parse answers is JSON, and every field is checked where it is read.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is typed `any`.
    return JSON.parse(body) as Json;
  } catch {
    return null;
  }
}

/** An issue or pull request from a search. */
function fromSearch(found: Rec): Item {
  const repo = repoOf(text(found.repository_url));
  const number = count(found.number);

  return {
    key: `${repo}#${number}`,
    kind: isRec(found.pull_request) ? "pr" : "issue",
    repo,
    number,
    title: text(found.title),
    url: text(found.html_url),
    author: text(rec(found.user).login),
    draft: found.draft === true,
    updated: text(found.updated_at),
    review: false,
    mine: false,
    assigned: false,
    reason: "",
    unread: false,
  };
}

/** Where a notification's subject is on github.com, and its number when it is an issue or a pull request. */
function subjectOf(repo: string, subject: Rec) {
  const type = text(subject.type);

  const number = Number(
    /\/(?:issues|pulls)\/(\d+)$/.exec(text(subject.url))?.[1] ?? 0
  );

  const site = `https://github.com/${repo}`;

  if (type === "PullRequest" && number > 0) {
    return { kind: "pr", number, url: `${site}/pull/${number}` };
  }

  if (type === "Issue" && number > 0) {
    return { kind: "issue", number, url: `${site}/issues/${number}` };
  }

  const elsewhere = new Map([
    ["Release", { kind: "release", url: `${site}/releases` }],
    ["Discussion", { kind: "discussion", url: `${site}/discussions` }],
    ["CheckSuite", { kind: "ci", url: `${site}/actions` }],
  ]);

  return {
    number: 0,
    ...(elsewhere.get(type) ?? { kind: "other", url: site }),
  };
}

/** A notification, as an item of its own; merged into its issue's or pull request's item when there is one. */
function fromNotification(notification: Rec): Item {
  const repo = text(rec(notification.repository).full_name);
  const subject = rec(notification.subject);
  const { kind, number, url } = subjectOf(repo, subject);

  return {
    key: number > 0 ? `${repo}#${number}` : `n:${text(notification.id)}`,
    kind,
    repo,
    number,
    title: text(subject.title),
    url,
    author: "",
    draft: false,
    updated: text(notification.updated_at),
    review: false,
    mine: false,
    assigned: false,
    reason: text(notification.reason),
    unread: notification.unread === true,
  };
}

/**
 * The person's unread notifications, or why they cannot be read: GitHub gives them only to a classic token with the
 * notifications scope, and the rest of the app works without them.
 */
async function notifications(app: AppContext) {
  try {
    return {
      items: list(await get(app, "/notifications?per_page=50")),
      note: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/answered 40[34]/.test(message)) {
      return {
        items: [],
        note: "Your github key can't read notifications. GitHub gives them only to a classic token with the notifications scope.",
      };
    }

    throw error;
  }
}

/** Everything the sync brings in, merged into one item per issue or pull request. */
async function gather(app: AppContext) {
  const items = new Map<string, Item>();

  const found = await Promise.all(
    SEARCHES.map(async ([source, q]) => {
      const answer = await get(
        app,
        `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=50`
      );

      return { source, results: list(rec(answer).items) };
    })
  );

  for (const { source, results } of found) {
    for (const result of results) {
      const item = fromSearch(rec(result));
      const known = items.get(item.key) ?? item;

      items.set(item.key, { ...known, [source]: true });
    }
  }

  const { items: notified, note } = await notifications(app);

  for (const entry of notified) {
    const notice = fromNotification(rec(entry));
    const known = items.get(notice.key);

    items.set(
      notice.key,
      known
        ? {
            ...known,
            reason: notice.reason,
            unread: notice.unread,
            updated:
              notice.updated > known.updated ? notice.updated : known.updated,
          }
        : notice
    );
  }

  return { items: [...items.values()], note };
}

const COLUMNS =
  "key, kind, repo, number, title, url, author, draft, updated, review, mine, assigned, notified, reason, unread";

/** Whether an item is in the inbox, done or snoozed, now: a done item that changed since comes back, as does a snooze that ended. */
function statusOf(row: Row, now: string) {
  if (row.triage === "done" && row.seen !== null && row.updated <= row.seen) {
    return "done";
  }

  if (row.triage === "snoozed" && row.until !== null && row.until > now) {
    return "snoozed";
  }

  return "inbox";
}

/** Why an item is here, in words: "Review requested · Mentioned". */
function whyOf(row: Row) {
  const words = [
    row.review ? "Review requested" : "",
    row.mine ? "Your pull request" : "",
    row.assigned ? "Assigned" : "",
    row.notified
      ? (REASONS.get(row.reason) ?? row.reason.replaceAll("_", " "))
      : "",
  ];

  return [...new Set(words.filter((word) => word !== ""))].join(" · ");
}

/** Every item with its triage now, newest first, as the screen and the imp read them. */
async function listItems(app: AppContext) {
  const rows = await app.db.all<Row>(
    `SELECT ${COLUMNS.split(", ")
      .map((c) => `items.${c}`)
      .join(", ")}, triage.state AS triage, triage.until, triage.seen
     FROM items LEFT JOIN triage ON triage.key = items.key ORDER BY items.updated DESC`
  );

  const now = new Date().toISOString();

  return rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    draft: row.draft === 1,
    day: dayOf(row.updated),
    why: whyOf(row),
    review: row.review === 1,
    mine: row.mine === 1,
    assigned: row.assigned === 1,
    notified: row.notified === 1,
    unread: row.unread === 1,
    status: statusOf(row, now),
    until: row.triage === "snoozed" && row.until ? dayOf(row.until) : "",
  }));
}

/** Whether the app has synced yet, and what it could not read. */
async function syncState(app: AppContext) {
  const meta = await app.db.all<{ name: string; value: string }>(
    "SELECT name, value FROM meta"
  );

  const value = (name: string) =>
    meta.find((entry) => entry.name === name)?.value ?? "";

  return { synced: value("synced") !== "", note: value("note") };
}

const done = { ok: true, error: "" };

/** Sets an item's triage; refuses a key the app does not have. */
async function triage(
  app: AppContext,
  key: string,
  { state, until = "" }: { state: "done" | "snoozed" | ""; until?: string }
) {
  const item = await app.db.get<{ updated: string }>(
    "SELECT updated FROM items WHERE key = ?",
    key
  );

  if (!item) {
    return { ok: false, error: `No GitHub item ${key}.` };
  }

  await (state === ""
    ? app.db.run("DELETE FROM triage WHERE key = ?", key)
    : app.db.run(
        "INSERT OR REPLACE INTO triage (key, state, until, seen) VALUES (?, ?, ?, ?)",
        key,
        state,
        until,
        item.updated
      ));

  return done;
}

const keyParam = {
  key: {
    type: "string",
    description: 'The item\'s key from `items`, such as "owner/repo#12".',
  },
} as const;

export default {
  schema: [
    `CREATE TABLE items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL, draft INTEGER NOT NULL, updated TEXT NOT NULL,
      review INTEGER NOT NULL, mine INTEGER NOT NULL, assigned INTEGER NOT NULL, notified INTEGER NOT NULL,
      reason TEXT NOT NULL, unread INTEGER NOT NULL)`,
    "CREATE TABLE triage (key TEXT PRIMARY KEY, state TEXT NOT NULL, until TEXT NOT NULL, seen TEXT NOT NULL)",
    "CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ],
  connections: [{ host: "api.github.com", secret: "github" }],
  sync: {
    every: "15m",
    watch: [`${API}/notifications`],
    run: async (app) => {
      const { items, note } = await gather(app);

      await app.db.batch([
        { sql: "DELETE FROM items" },
        ...items.map((item) => ({
          sql: `INSERT INTO items (${COLUMNS}) VALUES (${COLUMNS.split(",")
            .map(() => "?")
            .join(", ")})`,
          params: [
            item.key,
            item.kind,
            item.repo,
            item.number,
            item.title,
            item.url,
            item.author,
            item.draft ? 1 : 0,
            item.updated,
            item.review ? 1 : 0,
            item.mine ? 1 : 0,
            item.assigned ? 1 : 0,
            item.reason === "" ? 0 : 1,
            item.reason,
            item.unread ? 1 : 0,
          ],
        })),
        // Triage of an item GitHub no longer shows is forgotten: if it comes back, it is new.
        { sql: "DELETE FROM triage WHERE key NOT IN (SELECT key FROM items)" },
        {
          sql: "INSERT OR REPLACE INTO meta (name, value) VALUES ('synced', ?), ('note', ?)",
          params: [new Date().toISOString(), note],
        },
      ]);
    },
  },
  operations: {
    inbox: {
      kind: "read",
      description:
        "What needs the user on GitHub, newest first: pull requests waiting for their review, their own open pull requests, issues and pull requests assigned to them, and their unread notifications. `items` each have a key, kind (pr, issue, release, discussion, ci, other), repo, number, title, url, why it is here, and status: inbox, done or snoozed. `synced` says whether the app has read GitHub yet, and `note` what it can't read, such as notifications the user's key can't reach. To act on an item on GitHub (review, comment, merge, close, mark read), use gh with its url, then mark it done here.",
      params: {},
      run: async (_args, app) => ({
        ...(await syncState(app)),
        items: await listItems(app),
      }),
    },
    done: {
      kind: "write",
      description:
        "Mark a GitHub item done in this app, out of the inbox until it changes on GitHub again. It changes nothing on GitHub.",
      params: keyParam,
      run: async ({ key }, app) =>
        await triage(app, text(key), { state: "done" }),
    },
    snooze: {
      kind: "write",
      description:
        "Snooze a GitHub item for some days: out of the inbox until then. It changes nothing on GitHub.",
      params: {
        ...keyParam,
        days: { type: "integer", description: "How many days, 1 or more." },
      },
      run: async ({ key, days }, app) => {
        const span = count(days);

        if (span < 1) {
          return { ok: false, error: "Snooze for a day or more." };
        }

        const until = new Date(Date.now() + span * 86_400_000).toISOString();

        return await triage(app, text(key), { state: "snoozed", until });
      },
    },
    restore: {
      kind: "write",
      description: "Bring a done or snoozed GitHub item back to the inbox.",
      params: keyParam,
      run: async ({ key }, app) => await triage(app, text(key), { state: "" }),
    },
  },
} satisfies AppServer;
