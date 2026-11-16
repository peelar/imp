// The host's architecture as a check (npm run lint:boundaries). host/src holds one folder per bounded context; the
// files at its top put the contexts together and serve them over HTTP. docs/architecture.md draws the map this file
// enforces:
//
// 1. Outside a context, only its entry is imported: <context>/<context>.ts, what the context offers the others. The
//    rest of its folder is its own to change.
// 2. A context uses only the contexts CONTEXTS lists for it, and never the files that put the host together. A new
//    use is a change to the map, so it is made here, where review sees it. No context is open to every other one:
//    code that several contexts need is a context named for what it does, and each use of it is listed.
// 3. A package that reaches something the host keeps to one place is imported only from there (PACKAGES).
// 4. Only server.ts reads settings from the environment; every other part is handed what it needs.
// 5. host/machine/ runs on the agent's machine with its types stripped: it imports Node's own modules, `ws`, its own
//    files, and only types from the SDK and from a context's entry (machineProblems).
//
// Every folder in host/src must be a context listed here, and have its entry, so a new context is a decision too.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A context: what it owns, in the words of docs/architecture.md's table, and the contexts it may use. */
type Context = { readonly owns: string; readonly uses: readonly string[] };

/** Each context, in the order docs/architecture.md's table lists them. */
export const CONTEXTS = new Map<string, Context>([
  [
    "apps",
    {
      owns: "The app gateway: each app's code in a worker on the computer, its data in SQLite on the host, its versions, what it reads from outside and its syncs, and the two tools the agent runs apps with",
      uses: ["machine", "live", "datadir"],
    },
  ],
  [
    "studio",
    {
      owns: "Making apps: previews, Save, Discard and Undo, the code the host keeps, and the web builds with the apps in them",
      uses: ["apps", "live", "datadir", "processes"],
    },
  ],
  [
    "agent",
    {
      owns: "Who the imp is, the registry the parts install their tools and prompt sections on, and the Pi Durable harness that runs it",
      uses: [],
    },
  ],
  [
    "chats",
    {
      owns: "The conversations, and the lines the host adds to a message, such as a routine's",
      uses: ["live"],
    },
  ],
  [
    "routines",
    {
      owns: "What the imp does on a schedule, each in a conversation of its own",
      uses: ["chats", "live"],
    },
  ],
  [
    "notifications",
    {
      owns: "What the person is told while they are away: a routine's run, a key the imp asks for, a reply it finished",
      uses: ["chats", "routines", "secrets", "live"],
    },
  ],
  [
    "memory",
    {
      owns: "The memory contract and the knowledge graph behind it",
      uses: ["chats", "live"],
    },
  ],
  [
    "secrets",
    {
      owns: "The vault, the egress proxy and typing logins into Chrome",
      uses: ["machine", "live", "datadir", "processes"],
    },
  ],
  [
    "computer",
    {
      owns: "The owner's choice of computer, switching to another, their own computers on the tailnet, and the screen",
      uses: ["machine", "live", "datadir"],
    },
  ],
  [
    "machine",
    {
      owns: "The machine adapter contract, every provider's adapter, and the runtime the host installs on every machine",
      uses: ["processes"],
    },
  ],
  [
    "backup",
    {
      owns: "Every saved version of the apps' code, in git and on GitHub",
      uses: ["apps", "live", "datadir"],
    },
  ],
  [
    "account",
    {
      owns: "The model account: the ChatGPT sign-in or an API key, their credentials, and the model the person chose",
      uses: ["live", "datadir"],
    },
  ],
  [
    "tricks",
    {
      owns: "The browser tasks the imp keeps on its computer, and how it uses the web",
      uses: ["live"],
    },
  ],
  [
    "update",
    {
      owns: "The host's updates to the latest release",
      uses: [],
    },
  ],
  [
    "flags",
    {
      owns: "The feature flags: each one's default, deciding them from the owner's `flags.json` or Vercel Flags, and keeping the choice Settings makes for the next start",
      uses: ["datadir", "live"],
    },
  ],
  [
    "live",
    {
      owns: "Live answers: the topics a change names, and the streams that answer again when one changes",
      uses: [],
    },
  ],
  [
    "datadir",
    {
      owns: "Reading back the JSON files the host keeps in its data directory, so a damaged one never stops the host",
      uses: [],
    },
  ],
  [
    "processes",
    {
      owns: "The programs the host runs beside itself, killed when it exits, and the ports they take on its loopback",
      uses: [],
    },
  ],
]);

/** Packages only some files may import, by the rule in AGENTS.md that keeps each one there. */
export const PACKAGES = new Map<string, readonly string[]>([
  // Only the E2B adapter talks to E2B: nothing else knows which provider runs the agent's computer.
  ["e2b", ["machine/e2b.ts"]],
  // Only apps/data.ts opens an app's data; the model's sign-ins are the host's one other database.
  ["node:sqlite", ["apps/data.ts", "account/credentials.ts"]],
  // Only flags/flags.ts decides a feature flag, so the owner's flags.json is always the first word on it.
  ["flags", ["flags/flags.ts"]],
  ["flags/next", ["flags/flags.ts"]],
  ["@flags-sdk/vercel", ["flags/flags.ts"]],
]);

// The specifiers of a file's import and export statements, static and dynamic.
const STATEMENT = /^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gms;
const BARE = /^import\s*"([^"]+)"/gm;
const DYNAMIC = /\bimport\(\s*"([^"]+)"\s*\)/g;

const specifiers = (source: string) =>
  [STATEMENT, BARE, DYNAMIC].flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => match[1] ?? [])
  );

/** The context a file is in, or "" for the files at the top of host/src. Paths are relative to host/src. */
const contextOf = (file: string) =>
  file.includes("/") ? file.slice(0, file.indexOf("/")) : "";

const entryOf = (context: string) => `${context}/${context}.ts`;

/** What is wrong with one file's import of another file in host/src. */
function importProblem(file: string, target: string) {
  const from = contextOf(file);
  const to = contextOf(target);

  if (from === to) {
    return "";
  }

  if (to === "") {
    return `${file} imports ${target}: a context never uses the files that put the host together.`;
  }

  if (from !== "" && !CONTEXTS.get(from)?.uses.includes(to)) {
    return `${file} uses ${to}/, which ${from}/ may not. If it should, add "${to}" to ${from}'s list in scripts/boundaries.ts and to the map in docs/architecture.md.`;
  }

  if (target !== entryOf(to)) {
    return `${file} imports ${target}: from outside ${to}/, import ${entryOf(to)}, and export what it needs from there.`;
  }

  return "";
}

// A setting read from the environment: process.env.NAME or process.env[...]. Handing a program the whole environment
// (`...process.env`) and its PATH is not reading a setting.
const SETTING = /\bprocess\.env(?:\.(\w+)|\[)/g;

/** The settings a file reads from the environment, which only server.ts may. */
const settingProblems = (file: string, source: string) =>
  file === "server.ts"
    ? []
    : [...source.matchAll(SETTING)].flatMap(([, name]) =>
        name === "PATH"
          ? []
          : [
              `${file} reads ${name ? `process.env.${name}` : "process.env[…]"}: only server.ts reads settings from the environment. Add it to HostOptions there, and hand it to the part that needs it.`,
            ]
      );

/** What is wrong with one file's imports. */
function fileProblems(file: string, source: string) {
  return specifiers(source).flatMap((specifier) => {
    if (!specifier.startsWith(".")) {
      const allowed = PACKAGES.get(specifier);

      return allowed && !allowed.includes(file)
        ? [
            `${file} imports ${specifier}, which only ${allowed.join(" and ")} may.`,
          ]
        : [];
    }

    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier)
    );

    // Outside host/src, such as the SDK: not a context.
    if (target.startsWith("../")) {
      return [];
    }

    return importProblem(file, target) || [];
  });
}

/** Every way the files break the map, given each file's source by its path relative to host/src. */
export function violations(files: ReadonlyMap<string, string>): string[] {
  const folders = new Set(
    [...files.keys()].flatMap((file) => contextOf(file) || [])
  );

  const unknown = [...folders].flatMap((folder) =>
    CONTEXTS.has(folder)
      ? []
      : [
          `host/src/${folder}/ is not a context. Read "Where code goes" in AGENTS.md: if it is one, add it to CONTEXTS in scripts/boundaries.ts and to the map in docs/architecture.md, with what it owns and what it may use.`,
        ]
  );

  const entries = [...CONTEXTS.keys()].flatMap((context) =>
    files.has(entryOf(context))
      ? []
      : [
          `${context}/ has no entry: ${entryOf(context)} is what the other parts import.`,
        ]
  );

  const imports = [...files].flatMap(([file, source]) => [
    ...fileProblems(file, source),
    ...settingProblems(file, source),
  ]);

  return [...unknown, ...entries, ...imports];
}

// An import or export statement, and whether it brings only types.
const MACHINE_STATEMENT =
  /^(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*"([^"]+)"/gms;

/** What is wrong with one import of a file in host/machine/, by its path relative to the repository. */
function machineImportProblem(
  file: string,
  specifier: string,
  typeOnly: boolean
) {
  if (!specifier.startsWith(".")) {
    return specifier === "ws" || specifier.startsWith("node:")
      ? ""
      : `host/${file} imports ${specifier}: code on the agent's machine may use ws and Node's own modules, nothing else.`;
  }

  const target = path.posix.normalize(
    path.posix.join("host", path.posix.dirname(file), specifier)
  );

  if (target.startsWith("host/machine/")) {
    return "";
  }

  const context = /^host\/src\/([a-z-]+)\//.exec(target)?.[1];

  const shared =
    target === "sdk/app.ts" ||
    (context !== undefined &&
      CONTEXTS.has(context) &&
      target === `host/src/${entryOf(context)}`);

  if (!shared) {
    return `host/${file} imports ${target}: from the agent's machine, import types from the SDK or a context's entry, <context>/<context>.ts, and export them from there.`;
  }

  return typeOnly
    ? ""
    : `host/${file} imports ${target} for more than its types: the machine gets only host/machine/'s own files, so import it with \`import type\`.`;
}

/** Every way the files in host/machine/ break its rule, given each file's source by its path relative to host/. */
export function machineProblems(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([file, source]) => [
    ...[...source.matchAll(MACHINE_STATEMENT)].flatMap(
      ([, type, specifier = ""]) =>
        machineImportProblem(file, specifier, type !== undefined) || []
    ),
    ...[...source.matchAll(BARE), ...source.matchAll(DYNAMIC)].flatMap(
      ([, specifier = ""]) => machineImportProblem(file, specifier, false) || []
    ),
  ]);
}

// A row of docs/architecture.md's map: | `<context>/` | what it owns | `<context>`, `<context>` |
const ROW = /^\| `([a-z-]+)\/` \| (.*?) \| (.*?) \|$/gm;
const NAME = /`([a-z-]+)`/g;

/** Where docs/architecture.md's map, given as its Markdown, differs from CONTEXTS. */
export function mapProblems(markdown: string): string[] {
  const rows = new Map(
    [...markdown.matchAll(ROW)].map(([, name = "", owns = "", uses = ""]) => [
      name,
      {
        owns,
        uses: [...uses.matchAll(NAME)].flatMap((match) => match[1] ?? []),
      },
    ])
  );

  const missing = [...CONTEXTS.keys()].flatMap((name) =>
    rows.has(name)
      ? []
      : [`docs/architecture.md's map has no row for ${name}/.`]
  );

  const differing = [...rows].flatMap(([name, row]) => {
    const context = CONTEXTS.get(name);

    if (!context) {
      return [
        `docs/architecture.md's map lists ${name}/, which is not in CONTEXTS in scripts/boundaries.ts.`,
      ];
    }

    const problems = [];

    if (row.owns !== context.owns) {
      problems.push(
        `docs/architecture.md says ${name}/ owns "${row.owns}"; scripts/boundaries.ts says "${context.owns}".`
      );
    }

    if ([...row.uses].sort().join(",") !== [...context.uses].sort().join(",")) {
      problems.push(
        `docs/architecture.md says ${name}/ may use ${row.uses.join(", ") || "nothing"}; scripts/boundaries.ts says ${context.uses.join(", ") || "nothing"}.`
      );
    }

    return problems;
  });

  return [...missing, ...differing];
}

/** A folder's TypeScript files by their path relative to it, without the lint policy's probe folders. */
function readSources(root: string) {
  const files = new Map<string, string>();

  for (const entry of readdirSync(root, {
    recursive: true,
    encoding: "utf-8",
  })) {
    const file = entry.split(path.sep).join("/");

    if (
      file.endsWith(".ts") &&
      !file.split("/").some((part) => part.startsWith("."))
    ) {
      files.set(file, readFileSync(path.join(root, entry), "utf-8"));
    }
  }

  return files;
}

if (import.meta.main) {
  const files = readSources(
    path.join(import.meta.dirname, "..", "host", "src")
  );

  const machine = readSources(
    path.join(import.meta.dirname, "..", "host", "machine")
  );

  const found = [
    ...violations(files),
    ...machineProblems(
      new Map([...machine].map(([file, source]) => [`machine/${file}`, source]))
    ),
    ...mapProblems(
      readFileSync(
        path.join(import.meta.dirname, "..", "docs", "architecture.md"),
        "utf-8"
      )
    ),
  ];

  for (const problem of found) {
    console.error(problem);
  }

  if (found.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `host/src's ${files.size} files keep to the context map, host/machine's ${machine.size} keep to its rule, and docs/architecture.md draws the map as it is.`
    );
  }
}
