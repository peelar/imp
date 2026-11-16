// The host's architecture as a check (npm run lint:boundaries). host/src holds one folder per bounded context; the
// files at its top put the contexts together and serve them over HTTP. docs/architecture.md draws the map this file
// enforces:
//
// 1. Outside a context, only its entry is imported: <context>/<context>.ts, what the context offers the others. The
//    rest of its folder is its own to change. kernel/ is code every part shares, so any of its files may be imported.
// 2. A context uses only the contexts CONTEXTS lists for it, and never the files that put the host together. A new
//    use is a change to the map, so it is made here, where review sees it.
// 3. A package that reaches something the host keeps to one place is imported only from there (PACKAGES).
//
// Every folder in host/src must be a context listed here, and have its entry, so a new context is a decision too.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Each context, and the contexts it may use besides kernel/. */
export const CONTEXTS = new Map<string, readonly string[]>([
  ["kernel", []],
  ["machine", []],
  ["account", []],
  ["update", []],
  ["flags", []],
  ["tricks", []],
  ["chats", []],
  ["routines", ["chats"]],
  ["notices", ["chats", "routines", "secrets"]],
  ["memory", ["chats"]],
  ["apps", ["machine"]],
  ["studio", ["apps"]],
  ["backup", ["apps"]],
  ["secrets", ["machine"]],
  ["computer", ["machine"]],
]);

/** Packages only some files may import, by the rule in AGENTS.md that keeps each one there. */
export const PACKAGES = new Map<string, readonly string[]>([
  // Only the E2B adapter talks to E2B: nothing else knows which provider runs the agent's computer.
  ["e2b", ["computer/e2b.ts"]],
  // Only apps/data.ts opens an app's data; the model's sign-ins are the host's one other database.
  ["node:sqlite", ["apps/data.ts", "account/credentials.ts"]],
  // Only flags/flags.ts decides a feature flag, so the owner's flags.json is always the first word on it.
  ["flags", ["flags/flags.ts"]],
  ["flags/next", ["flags/flags.ts"]],
  ["@flags-sdk/vercel", ["flags/flags.ts"]],
]);

const SHARED = "kernel";

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

  if (from !== "" && to !== SHARED && !CONTEXTS.get(from)?.includes(to)) {
    return `${file} uses ${to}/, which ${from}/ may not. If it should, add "${to}" to ${from}'s list in scripts/boundaries.ts and to the map in docs/architecture.md.`;
  }

  if (to !== SHARED && target !== entryOf(to)) {
    return `${file} imports ${target}: from outside ${to}/, import ${entryOf(to)}, and export what it needs from there.`;
  }

  return "";
}

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
          `host/src/${folder}/ is not a context: add it to CONTEXTS in scripts/boundaries.ts with what it may use.`,
        ]
  );

  const entries = [...CONTEXTS.keys()].flatMap((context) =>
    context === SHARED || files.has(entryOf(context))
      ? []
      : [
          `${context}/ has no entry: ${entryOf(context)} is what the other parts import.`,
        ]
  );

  const imports = [...files].flatMap(([file, source]) =>
    fileProblems(file, source)
  );

  return [...unknown, ...entries, ...imports];
}

/** host/src's TypeScript files by their path relative to it, without the lint policy's probe folders. */
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

  const found = violations(files);

  for (const problem of found) {
    console.error(problem);
  }

  if (found.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`host/src's ${files.size} files keep to the context map.`);
  }
}
