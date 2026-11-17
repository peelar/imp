// The owner's secrets, as the client uses them: the imp asks for a key or a login it lacks, and the owner adds, deletes
// or turns it down in Settings. They ride on the account stream. The vault is a real OpenBao, which the host downloads the
// first time (src/processes/programs.ts). What a command then does with a key is the smoke script's part (scripts/smoke-machine.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  call,
  done,
  isRow,
  refused,
  type Row,
  rows,
  startTestHost,
  stopTestHost,
  toolRow,
  until,
} from "./harness.ts";

/** The secrets as Settings shows them, once `accept` takes them. */
const secretsWhen =
  (accept: (secrets: Row) => boolean = () => true) =>
  (answer: Json) => {
    const secrets = isRow(answer) ? answer.secrets : undefined;

    return isRow(secrets) && accept(secrets) ? secrets : undefined;
  };

/** A key for a known service, as the form in Settings sends it: the service says where it goes. */
const key = (name: string, service: string, value: string) => [
  name,
  service,
  value,
  "",
  "",
  "",
  "",
];

before(async () => {
  await startTestHost();
  assert.deepEqual(await call("accountSignIn", []), done);
  await until("account", (answer) =>
    isRow(answer) && answer.status === "signedIn" ? answer : undefined
  );
});

after(async () => {
  await stopTestHost();
});

test("the imp asks for a key it lacks, and the owner sees the request", async () => {
  const asked = await toolRow("Please ask for a key: linear");

  assert.match(
    JSON.stringify(asked.text),
    /your request for linear in Settings/
  );

  const { requests } = await until(
    "account",
    secretsWhen((secrets) => rows(secrets.requests).length > 0)
  );

  assert.deepEqual(
    rows(requests).map(({ id: _id, ...request }) => request),
    [
      {
        name: "linear",
        service: "linear",
        why: "To read your issues.",
        host: "",
      },
    ]
  );
});

test("a key that cannot be added is refused with the reason", async () => {
  assert.deepEqual(
    await call("secretsPut", key("Linear!", "linear", "lin_api_test")),
    refused(
      "Name it with lowercase letters, digits and dashes, such as github."
    )
  );
  assert.deepEqual(
    await call("secretsPut", key("linear", "linear", "")),
    refused("Paste the key first.")
  );
  assert.deepEqual(
    await call("secretsPut", [
      "wiki",
      "other",
      "key",
      "not a host",
      "",
      "",
      "",
    ]),
    refused("Name the hosts the key is for, such as api.example.com.")
  );
  assert.deepEqual(
    await call("secretsPut", key("wiki", "confluence", "key")),
    refused("There is no service confluence.")
  );
});

test("a key the owner adds answers the request and is never shown again; another key cannot take its variable", async () => {
  // The vault starts with the host, which downloads OpenBao the first time.
  await until(
    "account",
    secretsWhen(({ status }) => status === "ready"),
    120_000
  );
  assert.deepEqual(
    await call("secretsPut", key("linear", "linear", "lin_api_test")),
    done
  );

  const account = await until("account", (answer) => answer);
  const added = secretsWhen()(account);

  assert.ok(added);
  assert.ok(!JSON.stringify(account).includes("lin_api_test"));
  assert.deepEqual(added.requests, []);
  assert.deepEqual(
    rows(added.secrets).map(({ name, hosts, env, standIn }) => ({
      name,
      hosts,
      env,
      standIn,
    })),
    [
      {
        name: "linear",
        hosts: "api.linear.app",
        env: "$LINEAR_API_KEY",
        standIn: "imp-secret-linear",
      },
    ]
  );
  assert.deepEqual(
    await call("secretsPut", key("tracker", "linear", "lin_api_other")),
    refused("linear already uses LINEAR_API_KEY.")
  );
});

test("the imp does not ask for a key the owner has; a deleted key is gone, and a request can be turned down", async () => {
  const asked = await toolRow("Please ask for a key: linear (again)");

  assert.match(JSON.stringify(asked.text), /The user already has linear\./);
  assert.deepEqual(await call("secretsDelete", ["linear"]), done);
  assert.deepEqual((await until("account", secretsWhen())).secrets, []);
  await toolRow("Please ask for a key: github");

  const { requests } = await until(
    "account",
    secretsWhen((secrets) => rows(secrets.requests).length > 0)
  );

  const [request] = rows(requests);

  assert.equal(request?.name, "github");
  assert.deepEqual(await call("secretsDismiss", [request.id ?? ""]), done);
  assert.deepEqual((await until("account", secretsWhen())).requests, []);
});

/** A login as the form in Settings sends it: name ("" for one from the site), site, username, password, one-time key. */
const login = (
  site: string,
  username: string,
  [password, otp = ""]: readonly [string, string?]
) => ["", site, username, password, otp];

test("the imp asks for a login by its site, and a login that cannot be added is refused with the reason", async () => {
  await toolRow("Please ask for a login: github.com");

  const { requests } = await until(
    "account",
    secretsWhen((secrets) =>
      rows(secrets.requests).some((request) => request.service === "login")
    )
  );

  assert.deepEqual(
    rows(requests).map(({ name, host }) => ({ name, host })),
    [{ name: "github-login", host: "github.com" }]
  );
  assert.deepEqual(
    await call("secretsPutLogin", login("not a site", "adrian", ["pw"])),
    refused("Name the site, such as github.com.")
  );
  assert.deepEqual(
    await call("secretsPutLogin", login("github.com", "adrian", [""])),
    refused("Write the password first.")
  );
  assert.deepEqual(
    await call(
      "secretsPutLogin",
      login("github.com", "adrian", [
        "pw",
        "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP",
      ])
    ),
    refused("Only time-based one-time codes (TOTP) work.")
  );
});

test("a login the owner adds answers the request, shows its site and username, and never its password or code key", async () => {
  await until(
    "account",
    secretsWhen(({ status }) => status === "ready"),
    120_000
  );
  assert.deepEqual(
    await call(
      "secretsPutLogin",
      login("https://github.com/login", "adrian", [
        "hunter2-secret",
        "otpauth://totp/GitHub:adrian?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      ])
    ),
    done
  );

  const account = await until(
    "account",
    secretsWhen((secrets) => rows(secrets.secrets).length > 0)
  );

  assert.deepEqual(account.requests, []);
  assert.deepEqual(
    rows(account.secrets).map(({ name, kind, detail }) => ({
      name,
      kind,
      detail,
    })),
    [
      {
        name: "github-login",
        kind: "login",
        detail: "github.com · adrian · one-time codes",
      },
    ]
  );

  const shown = JSON.stringify(await until("account", (answer) => answer));

  assert.ok(!shown.includes("hunter2-secret"));
  assert.ok(!shown.includes("JBSWY3DPEHPK3PXP"));
  // A login is no API key: it takes no key's place, and no command gets a stand-in for it.
  assert.deepEqual(
    await call("secretsPut", key("github-login", "github", "ghp_x")),
    refused("github-login is a login.")
  );
});

test("sign_in names the logins there are, and asks for the page first while Chrome is not open", async () => {
  const unknown = await toolRow("Please sign in: gitlab-login");

  assert.match(
    JSON.stringify(unknown.text),
    /There is no login gitlab-login\. The logins are github-login\./
  );

  const closed = await toolRow("Please sign in: github-login");

  assert.equal(closed.title, "Signed in");
  assert.match(
    JSON.stringify(closed.text),
    /Open the site's sign-in page first/
  );

  const { uses } = await until(
    "account",
    secretsWhen((secrets) => rows(secrets.uses).length > 0)
  );

  assert.deepEqual(
    rows(uses).map(({ secret, what, result, failed }) => ({
      secret,
      what,
      result,
      failed,
    })),
    [
      {
        secret: "github-login",
        what: "sign in on github.com",
        result: "failed",
        failed: true,
      },
    ]
  );
});
