// The GitHub app Imp ships (client/apps/github): its sync merges GitHub's searches and notifications into one item per
// issue or pull request, and its triage stays the person's across syncs. The app runs here against a GitHub that
// answers from fixtures, with its database in memory.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AppContext, FetchAnswer, Json } from "../../sdk/app.ts";
import github from "../../client/apps/github/server.ts";

const json = (body: Json, status = 200): FetchAnswer => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});

/** A pull request as GitHub's search answers it. */
const pr = (number: number, updated: string) => ({
  number,
  title: `Pull request ${number}`,
  html_url: `https://github.com/o/r/pull/${number}`,
  repository_url: "https://api.github.com/repos/o/r",
  user: { login: "ada" },
  pull_request: {},
  draft: false,
  updated_at: updated,
});

/** A notification as GitHub answers it. */
const notice = ({
  id,
  type,
  url,
  updated,
}: {
  id: string;
  type: string;
  url: string;
  updated: string;
}) => ({
  id,
  reason: "mention",
  unread: true,
  updated_at: updated,
  repository: { full_name: "o/r" },
  subject: { title: `${type} ${id}`, url, type },
});

/** A GitHub whose answers the test changes as it goes. */
function fakeGitHub() {
  const answers = {
    review: [pr(7, "2026-11-10T10:00:00Z")],
    notifications: json([
      notice({
        id: "1",
        type: "PullRequest",
        url: "https://api.github.com/repos/o/r/pulls/7",
        updated: "2026-11-11T10:00:00Z",
      }),
      notice({
        id: "2",
        type: "Release",
        url: "https://api.github.com/repos/o/r/releases/5",
        updated: "2026-11-09T10:00:00Z",
      }),
    ]),
  };

  const fetch = async (url: string) => {
    const { pathname, searchParams } = new URL(url);

    if (pathname === "/notifications") {
      return answers.notifications;
    }

    const q = searchParams.get("q") ?? "";

    return json({
      items: q.includes("review-requested") ? answers.review : [],
    });
  };

  return { answers, fetch };
}

function appWith(fetch: AppContext["fetch"]): AppContext {
  const sql = new DatabaseSync(":memory:");

  for (const migration of github.schema) {
    sql.exec(migration);
  }

  const run = (query: string, params: readonly (string | number | null)[]) => {
    const { changes, lastInsertRowid } = sql.prepare(query).run(...params);

    return {
      changes: Number(changes),
      lastInsertRowid: Number(lastInsertRowid),
    };
  };

  return {
    id: "github",
    fetch,
    db: {
      all: async <T>(query: string, ...params: (string | number | null)[]) =>
        // SAFETY: each query's columns are the row type the app names.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:sqlite types rows as records of values.
        sql.prepare(query).all(...params) as T[],
      get: async <T>(query: string, ...params: (string | number | null)[]) =>
        // SAFETY: as for `all`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:sqlite types rows as records of values.
        (sql.prepare(query).get(...params) ?? null) as T | null,
      run: async (query, ...params) => run(query, params),
      batch: async (statements) => {
        sql.exec("BEGIN");

        const done = statements.map(({ sql: query, params = [] }) =>
          run(query, params)
        );

        sql.exec("COMMIT");

        return done;
      },
    },
  };
}

const inbox = async (app: AppContext) =>
  await github.operations.inbox.run({}, app);

const items = async (app: AppContext) => (await inbox(app)).items;

test("a notification joins its pull request's item, and Done holds until the item changes on GitHub", async () => {
  const { answers: state, fetch } = fakeGitHub();
  const app = appWith(fetch);

  await github.sync.run(app);

  assert.deepEqual(
    (await items(app)).map((item) => [
      item.key,
      item.kind,
      item.url,
      item.why,
      item.unread,
      item.status,
    ]),
    [
      [
        "o/r#7",
        "pr",
        "https://github.com/o/r/pull/7",
        "Review requested · Mentioned",
        true,
        "inbox",
      ],
      [
        "n:2",
        "release",
        "https://github.com/o/r/releases",
        "Mentioned",
        true,
        "inbox",
      ],
    ]
  );

  assert.deepEqual(await github.operations.done.run({ key: "o/r#7" }, app), {
    ok: true,
    error: "",
  });
  await github.sync.run(app);
  assert.equal((await items(app))[0]?.status, "done");

  // Something new on the pull request brings it back.
  state.review = [pr(7, "2026-11-12T10:00:00Z")];
  await github.sync.run(app);
  assert.equal((await items(app))[0]?.status, "inbox");

  assert.deepEqual(
    await github.operations.snooze.run({ key: "o/r#8", days: 1 }, app),
    {
      ok: false,
      error: "No GitHub item o/r#8.",
    }
  );
});

test("saved filters hide items by owner and repository, and outlast a sync", async () => {
  const { answers: state, fetch } = fakeGitHub();
  const app = appWith(fetch);
  const { showOrg, unshowOrg, hideRepo, unhideRepo } = github.operations;

  state.review = [
    pr(7, "2026-11-10T10:00:00Z"),
    {
      ...pr(9, "2026-11-10T09:00:00Z"),
      repository_url: "https://api.github.com/repos/Acme/Web",
    },
  ];
  await github.sync.run(app);

  const hidden = async () =>
    (await items(app)).flatMap((item) => (item.hidden ? [item.key] : []));

  assert.deepEqual(await showOrg.run({ org: "ACME" }, app), {
    ok: true,
    error: "",
  });
  assert.deepEqual(await hidden(), ["o/r#7", "n:2"]);
  assert.deepEqual((await inbox(app)).orgs, ["acme"]);

  await hideRepo.run({ repo: "acme/web" }, app);
  await unshowOrg.run({ org: "acme" }, app);
  await github.sync.run(app);
  assert.deepEqual(await hidden(), ["Acme/Web#9"]);
  assert.deepEqual((await inbox(app)).hiddenRepos, ["acme/web"]);

  await unhideRepo.run({ repo: "acme/web" }, app);
  assert.deepEqual(await hidden(), []);

  assert.equal((await hideRepo.run({ repo: "web" }, app)).ok, false);
  assert.equal((await showOrg.run({ org: "a/b" }, app)).ok, false);
});

test("a key that can't read notifications still brings in the rest, and says why", async () => {
  const { answers: state, fetch } = fakeGitHub();
  const app = appWith(fetch);

  state.notifications = json(
    { message: "Resource not accessible by integration" },
    403
  );
  await github.sync.run(app);

  assert.deepEqual(
    (await items(app)).map((item) => item.key),
    ["o/r#7"]
  );
  assert.match(
    (await inbox(app)).note,
    /classic token with the notifications scope/
  );
});
