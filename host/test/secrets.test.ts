// The owner's secrets, as the client uses them: the imp asks for a key it lacks, and the owner adds, deletes or turns
// it down in Settings. They ride on the account stream. The vault is a real OpenBao, which the host downloads the
// first time (src/tools.ts). What a command then does with a key is the smoke script's part (scripts/smoke-machine.ts).
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
