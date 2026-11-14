// The programs the host runs beside itself and must not leave behind (agentd on this computer, ssh tunnels, OpenBao,
// mitmproxy): each is killed when the host exits. Node runs exit listeners only on a clean exit, so an interrupt or a
// termination signal exits the host cleanly first. This is the one place that listens for the host's exit.
import type { ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();

process.once("exit", () => {
  for (const child of children) {
    child.kill();
  }
});

for (const [signal, code] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
] as const) {
  process.once(signal, () => process.exit(128 + code));
}

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
