// Proves the lint configuration still rejects what it is there to reject, not only that today's code passes: each
// probe is a small file that breaks one rule, and oxlint must report that rule for it. A rule turned off or loosened
// in oxlint.config.ts fails here. Run: npm run lint:policy (adapted from peelar/cli).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONTEXTS, mapProblems, violations } from "./boundaries.ts";

const branches = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `if (x === ${index}) return ${index};`
  ).join("\n");

const probes = [
  {
    rule: "sonarjs(cognitive-complexity)",
    code: `export const choose = (x: number) => { ${branches(16)} return -1; };`,
  },
  {
    rule: "eslint(complexity)",
    code: `export const choose = (x: number) => { ${branches(21)} return -1; };`,
  },
  {
    rule: "eslint(max-depth)",
    code: "export const nested = (x: number[]) => { for (const a of x) { if (a) { for (const b of x) { if (b) { console.log(a, b); } } } } };",
  },
  {
    rule: "eslint(max-params)",
    code: "export const sum = (a: number, b: number, c: number, d: number) => a + b + c + d;",
  },
  {
    rule: "eslint(max-lines)",
    code: Array.from(
      { length: 501 },
      (_, index) => `export const value${index} = ${index};`
    ).join("\n"),
  },
  {
    rule: "eslint(max-lines-per-function)",
    code: `export const long = () => {\n${"console.log('line');\n".repeat(101)}};`,
  },
  {
    rule: "eslint(no-nested-ternary)",
    code: "declare const n: number;\nexport const s = n > 1 ? 'a' : n > 0 ? 'b' : 'c';",
  },
  {
    rule: "typescript(no-floating-promises)",
    code: "void Promise.resolve(1);",
  },
  {
    rule: "typescript(no-misused-promises)",
    code: "[1].forEach(async (item) => { await Promise.resolve(item); });",
  },
  {
    rule: "typescript(await-thenable)",
    code: "export const value = await 42;",
  },
  {
    rule: "typescript(no-unsafe-type-assertion)",
    code: "declare const value: unknown;\nexport const text = value as string;",
  },
  {
    rule: "typescript(no-unsafe-assignment)",
    code: "declare const value: any;\nexport const count: number = value;",
  },
  {
    rule: "typescript(no-non-null-assertion)",
    code: "declare const names: string[];\nexport const first = names[0]!;",
  },
  {
    rule: "typescript(consistent-type-definitions)",
    code: "export interface Named { name: string }",
  },
  {
    rule: "import(no-default-export)",
    code: "export default 1;",
  },
  {
    rule: "anti-slop(require-safety-comment-for-type-assertion)",
    code: "declare const value: unknown;\nexport const text = value as string;",
  },
  {
    rule: "anti-slop(no-unknown-parameters)",
    code: "export const show = (value: unknown) => String(value);",
  },
  {
    rule: "anti-slop(no-runtime-typeof)",
    code: 'declare const value: string | number;\nexport const text = typeof value === "string" ? value : "";',
  },
] as const;

// The context map (boundaries.ts) must refuse each of these too: host/src's folders are the architecture only while a
// file that crosses one the wrong way is refused. Each crossing is a set of files by their path in host/src.
const crossings = [
  {
    crosses: "an import of another context's inner file",
    files: [
      ["studio/studio.ts", 'import { openAppData } from "../apps/data.ts";'],
    ],
    says: "from outside apps/, import apps/apps.ts",
  },
  {
    crosses: "an import of an inner file split over lines",
    files: [
      [
        "studio/studio.ts",
        'import type {\n  AppData,\n} from "../apps/data.ts";',
      ],
    ],
    says: "studio/studio.ts imports apps/data.ts",
  },
  {
    crosses: "an inner file imported at run time",
    files: [
      ["studio/studio.ts", 'const data = await import("../apps/data.ts");'],
    ],
    says: "studio/studio.ts imports apps/data.ts",
  },
  {
    crosses: "a use of a context the map does not list",
    files: [["apps/apps.ts", 'import { studio } from "../studio/studio.ts";']],
    says: "uses studio/, which apps/ may not",
  },
  {
    crosses: "a context the notices watch, using the notices",
    files: [
      [
        "routines/routines.ts",
        'import type { Notices } from "../notices/notices.ts";',
      ],
    ],
    says: "uses notices/, which routines/ may not",
  },
  {
    crosses: "a context reading a flag instead of being handed what it changes",
    files: [["apps/apps.ts", 'import { openFlags } from "../flags/flags.ts";']],
    says: "uses flags/, which apps/ may not",
  },
  {
    crosses:
      "a context using code others share, which the map does not list for it",
    files: [
      ["memory/memory.ts", 'import type { Topics } from "../live/live.ts";'],
    ],
    says: "uses live/, which memory/ may not",
  },
  {
    crosses: "a context using the files that put the host together",
    files: [["apps/apps.ts", 'import { startHost } from "../host.ts";']],
    says: "a context never uses the files that put the host together",
  },
  {
    crosses: "a folder that is not a context",
    files: [["notes/notes.ts", ""]],
    says: "host/src/notes/ is not a context",
  },
  {
    crosses: "a context without its entry",
    files: [["studio/preview.ts", ""]],
    says: "studio/ has no entry",
  },
  {
    crosses: "a package kept to one file",
    files: [["computer/computer.ts", 'import { Sandbox } from "e2b";']],
    says: "imports e2b, which only computer/e2b.ts may",
  },
  {
    crosses: "a feature flag decided outside flags/flags.ts",
    files: [["apps/apps.ts", 'import { flag } from "flags/next";']],
    says: "imports flags/next, which only flags/flags.ts may",
  },
] as const;

for (const { crosses, files, says } of crossings) {
  assert.ok(
    violations(new Map(files)).some((problem) => problem.includes(says)),
    `The context map did not refuse ${crosses}`
  );
}

console.log(`The context map refuses all ${crossings.length} crossings.`);

// docs/architecture.md must draw the map as boundaries.ts has it: a row that drifts from it is refused.
const row = (name: string, owns: string, uses: readonly string[]) =>
  `| \`${name}/\` | ${owns} | ${uses.map((use) => `\`${use}\``).join(", ")} |`;

const drawn = [...CONTEXTS].map(([name, { owns, uses }]) =>
  row(name, owns, uses)
);

assert.deepEqual(mapProblems(drawn.join("\n")), []);

for (const { drifts, rows, says } of [
  {
    drifts: "a row that lists a use the map does not have",
    rows: drawn.map((line) =>
      line.startsWith("| `memory/`")
        ? row("memory", CONTEXTS.get("memory")?.owns ?? "", ["chats", "apps"])
        : line
    ),
    says: "says memory/ may use chats, apps",
  },
  {
    drifts: "a context the map has no row for",
    rows: drawn.filter((line) => !line.startsWith("| `flags/`")),
    says: "has no row for flags/",
  },
  {
    drifts: "a row for a folder that is not a context",
    rows: [...drawn, row("notes", "Notes", [])],
    says: "lists notes/, which is not in CONTEXTS",
  },
]) {
  assert.ok(
    mapProblems(rows.join("\n")).some((problem) => problem.includes(says)),
    `The context map did not refuse ${drifts}`
  );
}

console.log("The context map refuses a drawing that drifts from it.");

// Inside host/src, so the probes are linted and type-checked as the host's own files are.
const folder = mkdtempSync(path.resolve("host/src/.lint-policy-"));

try {
  const files = probes.map((probe, index) => {
    const file = path.join(folder, `probe-${index}.ts`);

    writeFileSync(file, probe.code);

    return path.relative(process.cwd(), file);
  });

  const result = spawnSync(
    "npx",
    ["oxlint", "--type-aware", "--format", "unix", ...files],
    { encoding: "utf-8", timeout: 60_000 }
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);

  // One line per diagnostic: `<file>:<line>:<column>: <message> [Error/<rule>]`.
  const reported = result.stdout.split("\n");

  for (const [index, probe] of probes.entries()) {
    assert.ok(
      reported.some(
        (line) =>
          line.startsWith(`${files[index] ?? ""}:`) &&
          line.endsWith(`/${probe.rule}]`)
      ),
      `The lint policy did not reject ${probe.rule}`
    );
  }

  console.log(`The lint policy rejects all ${probes.length} probes.`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
