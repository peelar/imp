// The egress proxy's addon (egress/inject.py), in the real mitmproxy the host downloads: it puts a secret on a request
// and keeps the value out of what comes back, however the response is sent. The vault is a stand-in on a unix socket,
// and the service a local server that echoes the header the addon set; plain HTTP, so no CA is needed. An app's
// request, which the host sends itself (src/secrets/app-fetch.ts), goes the same way over HTTPS, to a service with a
// certificate of its own, which this mitmproxy is told not to check.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { compile, map, obj, opt, str } from "@earendil-works/pi-schema";
import { freePort } from "../src/kernel/ports.ts";
import { sendAppRequest } from "../src/secrets/app-fetch.ts";
import { tool } from "../src/secrets/programs.ts";
import { repo } from "./harness.ts";

const VALUE = "ghp_REALVALUE_abcdef123456";
const STAND_IN = "imp-secret-gh";
const dir = mkdtempSync(path.join(tmpdir(), "imp-egress-"));
const filler = "x".repeat(1_000_000);

/** What the service answers: its body holds the header the addon set, twice, between a megabyte of filler. */
const body = (auth: string) => `${filler}${auth}${filler}${auth}tail`;

const vault = createServer((_req, res) => {
  res.end(JSON.stringify({ data: { data: { value: VALUE } } }));
});

const service = createServer((req, res) => {
  const text =
    req.url === "/small"
      ? `small ${req.headers.authorization}`
      : body(req.headers.authorization ?? "");

  if (req.url === "/chunked") {
    // No Content-Length: the body goes out in chunks.
    for (let at = 0; at < text.length; at += 4093) {
      res.write(text.slice(at, at + 4093));
    }

    res.end();
  } else {
    res.setHeader("content-length", Buffer.byteLength(text));
    res.end(text);
  }
});

const HOST_TOKEN = "host-token-for-the-test";

// The HTTPS service an app reads: it answers the headers it got.
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    path.join(dir, "service.key"),
    "-out",
    path.join(dir, "service.pem"),
  ],
  { stdio: "ignore" }
);

const secure = createHttpsServer(
  {
    key: readFileSync(path.join(dir, "service.key")),
    cert: readFileSync(path.join(dir, "service.pem")),
  },
  (req, res) => {
    res.end(JSON.stringify(req.headers));
  }
);

let proxy: ChildProcess | undefined;
let proxyPort = 0;
let servicePort = 0;
let securePort = 0;

/** What mitmproxy printed: the addon's IMP-USE lines among it. */
let printed = "";

before(async () => {
  const socket = path.join(dir, "vault.sock");

  [servicePort, proxyPort, securePort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  vault.listen(socket);
  service.listen(servicePort, "127.0.0.1");
  secure.listen(securePort, "127.0.0.1");
  await Promise.all([
    once(vault, "listening"),
    once(service, "listening"),
    once(secure, "listening"),
  ]);
  writeFileSync(
    path.join(dir, "rules.json"),
    JSON.stringify({
      hosts: {
        "127.0.0.1": [
          { secret: "gh", header: "Authorization", prefix: "Bearer " },
        ],
      },
      standIns: { gh: STAND_IN },
    })
  );
  writeFileSync(path.join(dir, "token"), "token");
  writeFileSync(path.join(dir, "host-token"), HOST_TOKEN);
  // The same options egress-proxy.ts starts mitmproxy with.
  proxy = spawn(
    await tool(path.join(tmpdir(), "imp-tools"), "mitmdump"),
    [
      "--mode",
      `regular@127.0.0.1:${proxyPort}`,
      "--set",
      "stream_large_bodies=1m",
      "--set",
      "termlog_verbosity=warn",
      // The app's HTTPS service signs its own certificate.
      "--set",
      "ssl_insecure=true",
      "-s",
      path.join(repo, "host", "egress", "inject.py"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        IMP_EGRESS_DIR: dir,
        IMP_VAULT_SOCKET: socket,
      },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );

  proxy.stdout?.on("data", (chunk: Buffer) => {
    printed += chunk.toString("utf-8");
  });

  for (let tries = 0; tries < 100; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each try waits for the one before it.
    if (await reachable()) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries.
    await sleep(200);
  }

  throw new Error("mitmproxy did not start");
});

after(() => {
  proxy?.kill();
  vault.close();
  service.close();
  secure.close();
});

/** A GET through the proxy, as a command on the agent's machine sends it: with the stand-in. */
async function viaProxy(route: string) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${servicePort}${route}`,
        headers: { authorization: `Bearer ${STAND_IN}` },
      },
      resolve
    )
      .on("error", reject)
      .end();
  });

  let text = "";

  response.setEncoding("utf-8");
  response.on("data", (chunk: string) => {
    text += chunk;
  });
  await once(response, "end");

  return { status: response.statusCode, text };
}

async function reachable() {
  try {
    await viaProxy("/small");

    return true;
  } catch {
    return false;
  }
}

test("a small answer has the value replaced by the stand-in", async () => {
  assert.deepEqual(await viaProxy("/small"), {
    status: 200,
    text: `small Bearer ${STAND_IN}`,
  });
});

test("a large answer with a length streams through with the value masked, and keeps its length", async () => {
  const { status, text } = await viaProxy("/length");
  const masked = `Bearer ${"*".repeat(VALUE.length)}`;

  assert.equal(status, 200);
  assert.equal(text.length, body(`Bearer ${VALUE}`).length);
  assert.ok(!text.includes(VALUE));
  assert.equal(text, body(masked));
});

test("a chunked answer, whose size is unknown, streams through with the value replaced by the stand-in", async () => {
  const { status, text } = await viaProxy("/chunked");

  assert.equal(status, 200);
  assert.ok(!text.includes(VALUE));
  assert.equal(text, body(`Bearer ${STAND_IN}`));
});

/** An app's request for the secure service, as the gateway hands it over: checked, with the key named. */
const appRequest = async (app: string, token: string) =>
  await sendAppRequest(
    {
      app,
      url: `https://127.0.0.1:${securePort}/echo?x=1`,
      method: "GET",
      // An app cannot name itself, nor reach the proxy's own headers.
      headers: { "x-imp-app": "forged", accept: "application/json" },
      body: "",
      secret: "gh",
      address: "127.0.0.1",
    },
    async () => ({
      port: proxyPort,
      ca: readFileSync(
        path.join(dir, ".mitmproxy", "mitmproxy-ca-cert.pem"),
        "utf-8"
      ),
      token,
    })
  );

const useLine = compile(obj({ app: opt(str()) }, { open: true }));
const headersSeen = compile(map(str()));

/** The apps the addon recorded uses for, newest last. */
const usedBy = () =>
  printed
    .split("\n")
    .filter((line) => line.startsWith("IMP-USE "))
    .map((line) => {
      const use: unknown = JSON.parse(line.slice("IMP-USE ".length));

      return useLine.check(use) ? use.app : undefined;
    });

test("an app's request gets the key on its way, and the answer comes back without it, with the use named for the app", async () => {
  const answer = await appRequest("reader", HOST_TOKEN);
  const seen: unknown = JSON.parse(answer.body);

  assert.equal(answer.status, 200);
  assert.ok(!answer.body.includes(VALUE));
  assert.ok(headersSeen.check(seen));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(seen).filter(([name]) =>
        ["authorization", "accept", "x-imp-app", "x-imp-host"].includes(name)
      )
    ),
    // The service got the value; the answer says the stand-in in its place.
    { authorization: `Bearer ${STAND_IN}`, accept: "application/json" }
  );
  assert.equal(usedBy().at(-1), "reader");
});

test("a request without the host's token names no app", async () => {
  const answer = await appRequest("reader", "not-the-host");

  assert.equal(answer.status, 200);
  assert.equal(usedBy().at(-1), "");
});
