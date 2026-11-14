// The small JSON files the host keeps in its data directory (which build it serves, where the backup pushes, the
// owner's choice of computer, the secrets' records), read back. The host wrote each one, but a crash mid-write, a full
// disk or a hand edit can leave it damaged, and a damaged file must never stop the host: it reads as nothing, and
// `damaged` hears why so the host can say so in its log.
import { existsSync, readFileSync } from "node:fs";
import type { Validator } from "@earendil-works/pi-schema";

/** What `file` holds when it is what the host writes; undefined when it is missing, is not JSON or holds else. */
export function readKept<T>(
  file: string,
  expected: Validator<T>,
  damaged: (problem: string) => void
): T | undefined {
  if (!existsSync(file)) {
    return undefined;
  }

  let value: unknown;

  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch (cause) {
    damaged(
      `${file} is not JSON (${cause instanceof Error ? cause.message : String(cause)}), so the host reads it as empty.`
    );

    return undefined;
  }

  const answer = expected.validate(value);

  if (answer.ok) {
    return answer.value;
  }

  const problems = answer.errors.map(
    (error) => `${error.path || "the file"}: ${error.message}`
  );

  damaged(
    `${file} does not hold what the host writes there (${problems.join("; ")}), so the host reads it as empty.`
  );

  return undefined;
}
