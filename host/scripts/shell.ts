// Writes the shell's part for the apps in client/apps into client/app.contract and client/app.ts, built as "repo":
// the client the repository builds and tests on its own. The host writes the same parts for the apps it holds when it
// builds (src/shell.ts). Run it after changing an app's Screen props or operations: `node scripts/shell.ts`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAppFiles, readApps } from "../src/apps.ts";
import { generate, type ShellApp } from "../src/shell.ts";

const client = join(import.meta.dirname, "..", "..", "client");
const apps: ShellApp[] = [];
for (const app of readApps(join(client, "apps"))) {
  const folder = join(client, "apps", app.id);
  const server = (await import(pathToFileURL(join(folder, "server.ts")).href))
    .default as {
    operations?: Record<
      string,
      { kind: "read" | "write"; params: Record<string, never> }
    >;
  };
  const operations = Object.entries(server.operations ?? {}).map(
    ([name, { kind, params }]) => ({ name, kind, params })
  );
  apps.push({ id: app.id, files: readAppFiles(folder), operations });
}
const contract = join(client, "app.contract");
const ts = join(client, "app.ts");
const out = generate(
  { contract: readFileSync(contract, "utf8"), ts: readFileSync(ts, "utf8") },
  apps,
  "repo"
);
writeFileSync(contract, out.contract);
writeFileSync(ts, out.ts);
console.log(`wrote the shell's part for ${apps.map((a) => a.id).join(", ")}`);
