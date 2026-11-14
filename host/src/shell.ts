// The shell's wiring for the apps, and the web build that ships it.
//
// Contract lets only the root component declare resources and mutations, so each app's screen is a component the root
// feeds: the app's app.contract exports `component Screen`, and each of its props names one of the app's operations.
// A prop of type `action` is a write the screen calls with the write's params in order; any other prop is a read
// without params, streamed live. From those props this file writes the root's part for every app between the
// `// <apps:…>` and `// </apps:…>` markers of client/app.contract and client/app.ts. The agent never writes the root.
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AppFiles } from "./app-folders.ts";
import type { Operation } from "./protocol.ts";

export type ShellApp = {
  readonly id: string;
  readonly files: AppFiles;
  readonly operations: readonly Pick<Operation, "name" | "kind" | "params">[];
};

/** The shell's own folder, without what a build writes or the apps, which are generated in. */
const SKIP = new Set([
  "dist",
  "target",
  ".exact",
  "apps",
  "node_modules",
  "app.contract.d.ts",
]);

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const CONTRACT_TYPE = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "bool",
  enum: "string",
} as const;

type ScreenProp = { readonly name: string; readonly type: string };

/** The prop a line of a `props` block declares, as `name: type`; none when the line is something else. */
const propIn = (line: string): ScreenProp[] => {
  const [, name, type] = /^(\w+)\s*:\s*(.+)$/.exec(line.trim()) ?? [];

  return name === undefined || type === undefined ? [] : [{ name, type }];
};

/** The props of the app's `component Screen`, in order. */
export function screenProps(id: string, contract: string): ScreenProp[] {
  const lines = contract.split("\n");
  const start = lines.findIndex((line) => /^component Screen\s*$/.test(line));

  if (start === -1) {
    throw new Error(
      `apps/${id}/app.contract must declare \`component Screen\`: the shell shows it in the app's tab.`
    );
  }

  const props: ScreenProp[] = [];
  let inProps = false;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("//")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      break;
    }

    if (indent <= 2) {
      if (inProps) {
        break;
      }

      inProps = line.trim() === "props";
      continue;
    }

    if (!inProps) {
      continue;
    }

    props.push(...propIn(line));
  }

  return props;
}

type ShellOperation = ShellApp["operations"][number];

/** What one prop of an app's Screen adds to the root. */
type PropWiring = {
  readonly members: readonly string[];
  readonly refresh: readonly string[];
  readonly mutations: readonly string[];
  /** The prop, bound to what the root feeds it. */
  readonly binding: string;
  /** The app's Contract types the prop's type names, which the root imports under the app's name. */
  readonly typeNames: readonly string[];
};

type Wired =
  | { readonly ok: true; readonly wiring: PropWiring }
  | { readonly ok: false; readonly problem: string };

/** A prop of type `action`: a write the screen calls with the write's params in order. */
function wireAction(
  id: string,
  prop: ScreenProp,
  operation: ShellOperation
): Wired {
  if (operation.kind !== "write") {
    return {
      ok: false,
      problem: `Screen's prop ${prop.name} is an action, but ${operation.name} is a read: give the prop its answer's type, such as Item[]`,
    };
  }

  const call = `${id}${pascal(operation.name)}`;

  const params = Object.values(operation.params).map(
    (param, i) => `arg${i + 1}: ${CONTRACT_TYPE[param.type]}`
  );

  const args = params.map((_, i) => `arg${i + 1}`).join(", ");
  const action = `${id}Do${pascal(operation.name)}`;

  return {
    ok: true,
    wiring: {
      members: [
        `  mutation ${id}Wrote${pascal(operation.name)} as shape Reply queue`,
        `  action ${action}${params.length > 0 ? `(${params.join(", ")})` : ""}`,
        `    send ${id}Wrote${pascal(operation.name)} = ${call}(${args})`,
      ],
      refresh: [],
      mutations: [`  ${call}: true,`],
      binding: `${prop.name}=${action}`,
      typeNames: [],
    },
  };
}

/** Any other prop: a read without params, streamed live. */
function wireRead(
  id: string,
  prop: ScreenProp,
  operation: ShellOperation
): Wired {
  if (operation.kind !== "read") {
    return {
      ok: false,
      problem: `Screen's prop ${prop.name} is a value, but ${operation.name} is a write: make the prop an action`,
    };
  }

  if (Object.keys(operation.params).length > 0) {
    return {
      ok: false,
      problem: `Screen's prop ${prop.name}: ${operation.name} takes params, and the screen can only use reads without params (filter in the screen)`,
    };
  }

  // The app's types, named for the root by the app: Item is TodosItem there.
  const exported = /\b[A-Z]\w*\b/g;
  const type = prop.type.replaceAll(exported, (name) => `${pascal(id)}${name}`);
  const resource = `${id}Read${pascal(operation.name)}`;

  return {
    ok: true,
    wiring: {
      members: [
        `  resource ${resource} = ${id}${pascal(operation.name)}() when signedIn as shape ${type} else empty()`,
        `  derive ${resource}Lost = match failure(${resource}) { case some(f) => true, case none => false }`,
      ],
      refresh: [`    if ${resource}Lost`, `      refresh ${resource}`],
      mutations: [],
      binding: `${prop.name}=${resource}`,
      typeNames: prop.type.match(exported) ?? [],
    },
  };
}

function wireProp(app: ShellApp, prop: ScreenProp): Wired {
  const operation = app.operations.find((o) => o.name === prop.name);

  if (!operation) {
    return {
      ok: false,
      problem: `Screen's prop ${prop.name} names no operation in server.ts (${app.operations.map((o) => o.name).join(", ") || "it has none"})`,
    };
  }

  return prop.type === "action"
    ? wireAction(app.id, prop, operation)
    : wireRead(app.id, prop, operation);
}

/** One app's part of the root, or every problem with its Screen's props. */
function wire(app: ShellApp) {
  const { id } = app;
  const cap = pascal(id);

  const wired = screenProps(id, app.files["app.contract"]).map((prop) =>
    wireProp(app, prop)
  );

  const problems = wired.flatMap((prop) => (prop.ok ? [] : [prop.problem]));

  if (problems.length > 0) {
    throw new Error(`apps/${id}/app.contract: ${problems.join("; ")}.`);
  }

  const props = wired.flatMap((prop) => (prop.ok ? [prop.wiring] : []));
  // Each type once, in the order the props name them.
  const typeNames = [...new Set(props.flatMap((prop) => prop.typeNames))];

  return {
    use: `use Screen as ${cap}Screen${typeNames.map((name) => `, ${name} as ${cap}${name}`).join("")} from "./apps/${id}/app.contract"`,
    tab: `  tab ${id} "/${id}"`,
    members: props.flatMap((prop) => prop.members),
    refresh: props.flatMap((prop) => prop.refresh),
    screen: [
      `                  if e.name == "${id}"`,
      `                    AppPage(id="${id}", draft=hasDraft("${id}", apps), undo=undoKind("${id}", apps), save=saveApp, discard=discardApp, undoSave=undoApp)`,
      `                      ${cap}Screen(${props.map((prop) => prop.binding).join(", ")})`,
    ],
    mutations: props.flatMap((prop) => prop.mutations),
  };
}

/** `text` with the lines between `// <apps:name>` and `// </apps:name>` replaced by `lines`. */
function fill(text: string, name: string, lines: readonly string[]) {
  const pattern = new RegExp(
    `(// <apps:${name}>[^\\n]*)[\\s\\S]*?(\\n[ \\t]*// </apps:${name}>)`
  );

  if (!pattern.test(text)) {
    throw new Error(`the shell has no <apps:${name}> block`);
  }

  return text.replace(
    pattern,
    (_, open: string, close: string) => [open, ...lines].join("\n") + close
  );
}

/** The shell's root files with every app wired in, built as `version`. */
export function generate(
  shell: { contract: string; ts: string },
  apps: readonly ShellApp[],
  version: string
) {
  const parts = [...apps].sort((a, b) => a.id.localeCompare(b.id)).map(wire);
  let { contract } = shell;
  contract = fill(
    contract,
    "use",
    parts.map((p) => p.use)
  );
  contract = fill(contract, "version", [
    `fn builtVersion(): string = ${JSON.stringify(version)}`,
  ]);
  contract = fill(
    contract,
    "tabs",
    parts.map((p) => p.tab)
  );
  contract = fill(
    contract,
    "members",
    parts.flatMap((p) => p.members)
  );
  contract = fill(
    contract,
    "refresh",
    parts.flatMap((p) => p.refresh)
  );
  contract = fill(
    contract,
    "screens",
    parts.flatMap((p) => p.screen)
  );

  const ts = fill(
    shell.ts,
    "mutations",
    parts.flatMap((p) => p.mutations)
  );

  return { contract, ts };
}

export type BuildOptions = {
  /** The shell's source: the repository's client/. */
  readonly clientDir: string;
  /** The Exact checkout. */
  readonly exact: string;
  /** Where the shell is assembled; replaced. */
  readonly workDir: string;
  /** Where the web build goes. */
  readonly outDir: string;
  readonly apps: readonly ShellApp[];
  readonly version: string;
};

/** Assembles the shell's source in the work directory: the client's own files, each app's folder, and the root's parts. */
function assemble(options: BuildOptions) {
  rmSync(options.workDir, { recursive: true, force: true });
  cpSync(options.clientDir, options.workDir, {
    recursive: true,
    filter: (source) =>
      !SKIP.has(
        path.relative(options.clientDir, source).split(/[\\/]/)[0] ?? ""
      ),
  });

  for (const app of options.apps) {
    const dir = path.join(options.workDir, "apps", app.id);

    mkdirSync(dir, { recursive: true });

    for (const [name, content] of Object.entries(app.files)) {
      writeFileSync(path.join(dir, name), content);
    }
  }

  const read = (name: string) =>
    readFileSync(path.join(options.workDir, name), "utf-8");

  const { contract, ts } = generate(
    { contract: read("app.contract"), ts: read("app.ts") },
    options.apps,
    options.version
  );

  writeFileSync(path.join(options.workDir, "app.contract"), contract);
  writeFileSync(path.join(options.workDir, "app.ts"), ts);
  linkExactModules(options.workDir, options.exact, contract);
}

/**
 * Links the Exact modules the shell uses (`use … from "@exact/<name>"`) into its node_modules from the Exact checkout,
 * where the Contract compiler finds them, as scripts/link-exact.sh does for client/.
 */
function linkExactModules(workDir: string, exact: string, contract: string) {
  const names = new Set(
    [...contract.matchAll(/^use .* from "@exact\/([a-z0-9-]+)"$/gmu)].map(
      (match) => match[1] ?? ""
    )
  );

  const modules = path.join(workDir, "node_modules", "@exact");

  for (const name of names) {
    mkdirSync(modules, { recursive: true });
    symlinkSync(
      path.resolve(exact, "packages", name),
      path.join(modules, name),
      "dir"
    );
  }
}

/** Runs Exact's web build on the assembled shell; answers its exit code and everything it printed. */
async function webBuild(options: BuildOptions) {
  return await new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      // API_BASE_URL empty: the page asks the origin it was served from (see client/app.ts).
      const child = spawn(
        "sh",
        ["exact.mjs", "web-build", "--out", options.outDir],
        {
          cwd: options.workDir,
          env: { ...process.env, EXACT: options.exact, API_BASE_URL: "" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let output = "";

      const printed = (chunk: Buffer) => {
        output += chunk.toString();
      };

      child.stdout.on("data", printed);
      child.stderr.on("data", printed);
      child.on("close", (code) => {
        resolve({ code, output });
      });
      child.on("error", (error) => {
        resolve({ code: -1, output: String(error) });
      });
    }
  );
}

/** Assembles the shell with these apps and builds it for the web; a failure names what the compiler said. */
export async function buildShell(
  options: BuildOptions
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    assemble(options);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  rmSync(options.outDir, { recursive: true, force: true });

  const { code, output } = await webBuild(options);

  if (code === 0) {
    return { ok: true };
  }

  // What the compiler said, quoting the line it refuses, without the build's chatter and the shell's own warnings.
  const noise =
    /^warning: patch|exact\.mjs feedback|^app\.contract:\d+:\d+ warning|^compiler: \d+ warning|^import\.meta\.env|^\(node:|trace-warnings/;

  // Paths as the agent knows them: apps/<id>/app.contract, not the host's copy of the shell.
  const said = output
    .replaceAll(`${options.workDir}/`, "")
    .split("\n")
    .filter((line) => line.trim() && !noise.test(line));

  return { ok: false, error: said.slice(-40).join("\n").slice(0, 6000) };
}
