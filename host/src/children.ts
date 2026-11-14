// The programs the host runs beside itself and must not leave behind (OpenBao, mitmproxy): each is killed when the
// host exits.
import type { ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();

process.once("exit", () => {
  for (const child of children) {
    child.kill();
  }
});

/** Kills `child` when the host exits, unless it has exited by then. */
export function killOnExit(child: ChildProcess) {
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
  });
}

/** The last lines of a program's log, for the error that says it did not start. */
export const lastLines = (text: string, count = 5) =>
  text.trim().split("\n").slice(-count).join("\n");
