// Writes the shell's part for the apps in client/apps into client/app.contract and client/app.ts, built as "repo":
// the client the repository builds and tests on its own. The host writes the same parts for the apps it holds when it
// builds (src/shell.ts). Run it after changing an app's Screen props or operations: `node scripts/shell.ts`.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  arr,
  bool,
  compile,
  lit,
  map,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import { readAppFiles, readApps } from "../src/app-folders.ts";
import { generate, type ShellApp } from "../src/shell.ts";

const description = opt(str());
const optional = opt(bool());

const param = union([
  obj({
    type: oneOf(["string", "number", "integer", "boolean"]),
    description,
    optional,
  }),
  obj({ type: lit("enum"), values: arr(str()), description, optional }),
]);

// What the shell needs of an app's server.ts (sdk/app.ts says what the whole of it is): each operation's kind and
// params. The rest of the module, such as the functions the operations run, is the app's own.
const serverModule = compile(
  obj(
    {
      default: obj(
        {
          operations: opt(
            map(
              obj(
                { kind: oneOf(["read", "write"]), params: map(param) },
                { open: true }
              )
            )
          ),
        },
        { open: true }
      ),
    },
    { open: true }
  )
);

const client = path.join(import.meta.dirname, "..", "..", "client");

/** An app of the repository as the shell wires it: its files, and the operations its server.ts declares. */
async function shellApp(id: string): Promise<ShellApp> {
  const folder = path.join(client, "apps", id);
  const file = path.join(folder, "server.ts");
  const server: unknown = await import(pathToFileURL(file).href);

  if (!serverModule.check(server)) {
    throw new Error(
      `${file} must export default an app's server code, with a kind and params for each operation (see sdk/app.ts).`
    );
  }

  const operations = Object.entries(server.default.operations ?? {}).map(
    ([name, { kind, params }]) => ({ name, kind, params })
  );

  return { id, files: readAppFiles(folder), operations };
}

const apps = await Promise.all(
  readApps(path.join(client, "apps")).map(async (app) => await shellApp(app.id))
);

const contract = path.join(client, "app.contract");
const ts = path.join(client, "app.ts");

const out = generate(
  { contract: readFileSync(contract, "utf-8"), ts: readFileSync(ts, "utf-8") },
  apps,
  "repo"
);

writeFileSync(contract, out.contract);

writeFileSync(ts, out.ts);

console.log(`wrote the shell's part for ${apps.map((a) => a.id).join(", ")}`);
