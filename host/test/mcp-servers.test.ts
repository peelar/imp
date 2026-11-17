// Settings' MCP servers, as the client uses them: the owner adds a server by its HTTPS address, with a key or for a
// sign-in, and removes it. A key goes to the vault for the host's own requests to that server only: Settings → Secrets
// does not list it, the imp's secrets don't name it, and the owner cannot replace it there. A sign-in page that sends
// the person back with a sign-in the host is not waiting for is turned away, in plain text.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  base,
  call,
  done,
  first,
  isRow,
  refused,
  rows,
  type Row,
  startTestHost,
  stopTestHost,
  until,
  vaultReady,
} from "./harness.ts";

/** The MCP server `id` as Settings shows it, once `accept` takes it. */
const serverWhen =
  (id: string, accept: (server: Row) => boolean) => (answer: Json) => {
    const server = isRow(answer)
      ? rows(answer.mcpServers).find((known) => known.id === id)
      : undefined;

    return server && accept(server) ? server : undefined;
  };

const secretNames = (answer: Json) => {
  const secrets = isRow(answer) ? answer.secrets : undefined;

  return isRow(secrets) ? rows(secrets.secrets).map(({ name }) => name) : [];
};

before(async () => {
  await startTestHost();
  await vaultReady();
});

after(async () => {
  await stopTestHost();
});

test("a server needs a name and an HTTPS address", async () => {
  assert.deepEqual(
    await call("connectionsAddServer", [
      "Linear",
      "http://mcp.linear.app/mcp",
      "",
    ]),
    refused(
      "Give the server's HTTPS address, such as https://mcp.linear.app/mcp."
    )
  );
  assert.deepEqual(
    await call("connectionsAddServer", [
      "!!",
      "https://mcp.linear.app/mcp",
      "",
    ]),
    refused("Name it with a letter first, such as Linear.")
  );
});

test("a server added with a key is on, and its key is no secret the owner or the imp sees", async () => {
  assert.deepEqual(
    await call("connectionsAddServer", [
      "Sentry",
      "https://mcp.sentry.dev/mcp",
      "sntrys_test",
    ]),
    done
  );

  const server = await until(
    "account",
    serverWhen("sentry", ({ status }) => status === "on")
  );

  assert.equal(server.url, "https://mcp.sentry.dev/mcp");
  assert.ok(!secretNames(await first("account")).includes("mcp-sentry"));
  // The owner cannot replace a connection's key from Settings → Secrets.
  assert.deepEqual(
    await call("secretsPut", [
      "mcp-sentry",
      "other",
      "stolen",
      "evil.example.com",
      "",
      "",
      "",
    ]),
    refused("A connection keeps mcp-sentry itself.")
  );
  assert.deepEqual(
    await call("connectionsAddServer", [
      "Sentry",
      "https://mcp.sentry.dev/mcp",
      "",
    ]),
    refused("There is a server named Sentry already.")
  );
});

test("a server added without a key waits for a sign-in, and removing it forgets it", async () => {
  assert.deepEqual(
    await call("connectionsAddServer", [
      "Notion",
      "https://mcp.notion.com/mcp",
      "",
    ]),
    done
  );
  await until(
    "account",
    serverWhen("notion", ({ status }) => status === "off")
  );
  assert.deepEqual(await call("connectionsRemoveServer", ["notion"]), done);
  assert.deepEqual(await call("connectionsRemoveServer", ["sentry"]), done);
  await until("account", (answer) =>
    isRow(answer) && rows(answer.mcpServers).length === 0 ? true : undefined
  );
  assert.deepEqual(
    await call("connectionsRemoveServer", ["notion"]),
    refused("There is no server notion.")
  );
});

test("a sign-in the host is not waiting for is turned away, as text", async () => {
  const response = await fetch(
    `${base}/api/connections/callback?code=abc&state=forged`
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(
    await response.text(),
    "This sign-in is not one Imp is waiting for. Sign in again from Settings → Connections."
  );
});
