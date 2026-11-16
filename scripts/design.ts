// The shell's design system as a check (pnpm lint:design). The shell's look is its tokens in client/app.forma, the
// text styles in client/look.contract and the controls in client/controls.contract (docs/design.md). Every other
// screen of the shell names them, and writes none of its own:
//
// 1. No font, size, line height or weight: a text takes a text style with `class=`.
// 2. No colour of its own (a hex, rgb(), light-dark() or a system colour): a colour is a token.
// 3. No gap, padding or margin in pixels: spacing is a space.* token. A hairline (1px) and a negative margin, which
//    aligns a control with the text beside it, are not spacing and stay.
//
// The apps under client/apps/ keep their own looks, and the tests theirs, so neither is checked.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The files that make the design system, the only ones that may write what the rules refuse. */
const SYSTEM = new Set(["look.contract", "controls.contract"]);

const RULES = [
  {
    pattern: /\bfont-size=(?:"[\d.]+(?:rem|px)"|\()/u,
    says: "sets a font size: use a text style from look.contract",
  },
  {
    pattern: /\b(?:font-family|line-height|font-weight)=/u,
    says: "sets a font: use a text style from look.contract",
  },
  {
    pattern: /#[\da-f]{3,8}\b|\brgba?\(|light-dark\(|-exact-system-/iu,
    says: "writes a colour: use a token from app.forma",
  },
  {
    pattern:
      /\b(?:gap|padding|margin)[\w-]*=(?:"[^"]*(?<![-\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px[^"]*"|\([^\n]*?"[^"]*(?<![-\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px[^"]*"|[1-9]\d*\b)/u,
    says: "spaces in pixels: use a space.* token from app.forma",
  },
] as const;

/** What one line of `file` breaks, as `<file>:<line>: <what>`; none for a comment. */
const lineProblems = (file: string, line: string, index: number) =>
  line.trimStart().startsWith("//")
    ? []
    : RULES.flatMap(({ pattern, says }) =>
        pattern.test(line) ? [`client/${file}:${index + 1}: ${says}`] : []
      );

/** What breaks the design system, as `<file>:<line>: <what>`, for the shell's contracts by their path in client/. */
export function designProblems(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([file]) => !SYSTEM.has(file))
    .flatMap(([file, source]) =>
      source
        .split("\n")
        .flatMap((line, index) => lineProblems(file, line, index))
    );
}

/** The shell's own contracts: client/ and client/settings/, without the tests. */
function readShell(root: string) {
  const files = new Map<string, string>();

  for (const folder of ["", "settings"]) {
    for (const name of readdirSync(path.join(root, folder))) {
      if (name.endsWith(".contract") && !name.endsWith(".test.contract")) {
        const file = path.join(folder, name);

        files.set(file, readFileSync(path.join(root, file), "utf-8"));
      }
    }
  }

  return files;
}

if (import.meta.main) {
  const files = readShell(path.join(import.meta.dirname, "..", "client"));
  const found = designProblems(files);

  for (const problem of found) {
    console.error(problem);
  }

  if (found.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `The shell's ${files.size} contracts keep to the design system.`
    );
  }
}
