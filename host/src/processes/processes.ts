// The programs the host runs beside itself (agentd on this computer, ssh tunnels, OpenBao, mitmproxy) and the ports
// they take on this computer's loopback. Each program is killed when the host exits: Node runs exit listeners only on
// a clean exit, so an interrupt or a termination signal exits the host cleanly first. This is the one place that
// listens for the host's exit.
import type { ChildProcess } from "node:child_process";
import { connect, createServer, type AddressInfo } from "node:net";

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

const isTcpAddress = (
  address: string | AddressInfo | null
): address is AddressInfo => typeof address === "object" && address !== null;

/** A port nothing listens on now. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        if (isTcpAddress(address)) {
          resolve(address.port);
        } else {
          reject(new Error("no port"));
        }
      });
    });
  });
}

/** Whether something accepts connections on `port`. */
export async function accepts(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
