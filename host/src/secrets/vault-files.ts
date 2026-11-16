// What OpenBao starts from, in DATA_DIR/vault: the seal key, the host's password, the two policies, the two loopback
// ports and the configuration that names them all. Each is written once and kept, except the configuration, which is
// written again on every start.
//
//   seal.key        what OpenBao unseals itself with (the static seal)
//   host.pass       the password the host signs in with
//   imp-admin.hcl   what the host may do
//   imp-egress.hcl  what the egress proxy's token may do
//   ports.json      { api, cluster }: the loopback ports Raft needs
//   bao.hcl         the configuration, with the self-initialization that sets all of it up on the first start
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compile, int, obj } from "@earendil-works/pi-schema";
import { readKept } from "../datadir/datadir.ts";
import { freePort } from "../processes/processes.ts";

const ADMIN_POLICY = `
path "secret/data/imp/*" { capabilities = ["create", "update", "delete"] }
path "secret/metadata/imp/*" { capabilities = ["read", "list", "update", "delete"] }
path "auth/token/create/imp-egress" { capabilities = ["update"] }
path "auth/token/revoke-accessor" { capabilities = ["update"] }
`;

const EGRESS_POLICY = `
path "secret/data/imp/*" { capabilities = ["read"] }
`;

const portsJson = compile(obj({ api: int(), cluster: int() }));

type Ports = { readonly api: number; readonly cluster: number };

export type VaultFiles = ReturnType<typeof vaultFiles>;

/** The vault's files under `dir`. */
export function vaultFiles(dir: string) {
  const file = (name: string) => path.join(dir, name);

  return {
    dir,
    /** The unix socket OpenBao takes requests on, which only the host's user can open. */
    socket: file("bao.sock"),
    log: file("bao.log"),
    config: file("bao.hcl"),
    /** The password the host signs in with. */
    password: () => readFileSync(file("host.pass"), "utf-8"),
  };
}

const q = (value: string) => JSON.stringify(value);

function config(dir: string, ports: Ports): string {
  const file = (name: string) => path.join(dir, name);

  const read = (from: string) =>
    `{ eval_source = "file", eval_type = "string", path = ${q(from)} }`;

  return `
storage "raft" {
  path = ${q(file("data"))}
  node_id = "imp"
}
listener "unix" {
  address = ${q(file("bao.sock"))}
  socket_mode = "0600"
}
listener "tcp" {
  address = "127.0.0.1:${ports.api}"
  cluster_address = "127.0.0.1:${ports.cluster}"
  tls_disable = true
}
api_addr = "http://127.0.0.1:${ports.api}"
cluster_addr = "http://127.0.0.1:${ports.cluster}"
disable_mlock = true
ui = false
seal "static" {
  current_key_id = "imp-1"
  current_key = ${q(`file://${file("seal.key")}`)}
}
audit "file" "audit" {
  options = { file_path = ${q(file("audit.log"))} }
}
initialize "imp" {
  request "kv" {
    operation = "update"
    path = "sys/mounts/secret"
    data = { type = "kv", options = { version = "2" } }
  }
  request "admin-policy" {
    operation = "update"
    path = "sys/policies/acl/imp-admin"
    data = { policy = ${read(file("imp-admin.hcl"))} }
  }
  request "egress-policy" {
    operation = "update"
    path = "sys/policies/acl/imp-egress"
    data = { policy = ${read(file("imp-egress.hcl"))} }
  }
  request "egress-role" {
    operation = "update"
    path = "auth/token/roles/imp-egress"
    data = { allowed_policies = ["imp-egress"], orphan = true, token_period = "1h" }
  }
  request "userpass" {
    operation = "update"
    path = "sys/auth/userpass"
    data = { type = "userpass" }
  }
  request "host-user" {
    operation = "update"
    path = "auth/userpass/users/host"
    data = { password = ${read(file("host.pass"))}, token_policies = ["imp-admin"] }
  }
}
`;
}

/** Two different free ports. */
async function twoPorts(): Promise<Ports> {
  const api = await freePort();
  let cluster = await freePort();

  while (cluster === api) {
    // oxlint-disable-next-line no-await-in-loop -- another port is asked for only when the last answer repeats the first.
    cluster = await freePort();
  }

  return { api, cluster };
}

/** The ports OpenBao listens on. Raft keeps the node's cluster address, so they are chosen once and kept. */
async function ports(file: string): Promise<Ports> {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(await twoPorts()), { mode: 0o600 });
  }

  // New ports would not match the address Raft kept, so a damaged file stops the vault, and Settings says why.
  let problem = "";

  const kept = readKept(file, portsJson, (damaged) => {
    problem = damaged;
  });

  if (!kept) {
    throw new Error(`OpenBao's two ports are unknown: ${problem}`);
  }

  return kept;
}

/** Writes what OpenBao starts from, once: the seal key, the host's password, the policies and two ports. */
export async function prepare({ dir, config: configFile }: VaultFiles) {
  mkdirSync(path.join(dir, "data"), { recursive: true, mode: 0o700 });

  const once = (name: string, content: string | Buffer) => {
    const file = path.join(dir, name);

    if (!existsSync(file)) {
      writeFileSync(file, content, { mode: 0o600 });
    }
  };

  once("seal.key", randomBytes(32));
  // No newline: self-initialization reads the file byte for byte.
  once("host.pass", randomBytes(24).toString("hex"));
  once("imp-admin.hcl", ADMIN_POLICY);
  once("imp-egress.hcl", EGRESS_POLICY);
  writeFileSync(
    configFile,
    config(dir, await ports(path.join(dir, "ports.json"))),
    { mode: 0o600 }
  );
}
