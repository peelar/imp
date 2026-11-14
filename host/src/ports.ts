// Ports on this computer's loopback, as the machine adapters use them: finding a free one, and asking whether
// something listens on one and whether that is the agentd the host expects.
import { connect, createServer, type AddressInfo } from "node:net";

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

/**
 * Whether the agentd reached through `port` answers /health with `expected` (see `healthFor` in machine-runtime.ts).
 * No answer, another answer, and `signal` aborting first all count as not healthy.
 */
export async function healthy(
  port: number,
  expected: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: signal ?? null,
    });

    return (await response.text()) === expected;
  } catch {
    return false;
  }
}
