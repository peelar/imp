// Proves the lint configuration still rejects what it is there to reject, not only that today's code passes: each
// probe is a small file that breaks one rule, and oxlint must report that rule for it. A rule turned off or loosened
// in oxlint.config.ts fails here. Run: npm run lint:policy (adapted from peelar/cli).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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
