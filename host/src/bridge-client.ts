// Runs on the host, started by pi-env's Connection as the "command" that reaches the daemon:
//   node bridge-client.ts <bridge-url> <headers-json> serve --token <hex>
// It forwards the arguments to the machine's bridge, then pipes this process's stdin and stdout over the WebSocket.
import { compile, map, str } from "@earendil-works/pi-schema";
import { type RawData, WebSocket } from "ws";

const [bridgeUrl, headersJson, ...args] = process.argv.slice(2);
const headers = compile(map(str())).validate(JSON.parse(headersJson ?? "{}"));

if (!bridgeUrl || !headers.ok) {
  throw new Error(
    "usage: bridge-client.ts <bridge-url> <headers-json> <daemon arguments>"
  );
}

const url = new URL(bridgeUrl);

url.searchParams.set("args", JSON.stringify(args));

const ws = new WebSocket(url, { headers: headers.value });

/** The daemon's stdin from before the socket opened. */
const early: Buffer[] = [];

const bytes = (data: RawData) => {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
};

ws.on("open", () => {
  for (const chunk of early.splice(0)) {
    ws.send(chunk);
  }
});

process.stdin.on("data", (chunk: Buffer) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(chunk);
  } else {
    early.push(chunk);
  }
});

process.stdin.on("end", () => {
  ws.close();
});

ws.on("message", (data) => {
  const frame = bytes(data);

  (frame[0] === 2 ? process.stderr : process.stdout).write(frame.subarray(1));
});

ws.on("close", () => {
  process.exit(0);
});

ws.on("error", (error) => {
  process.stderr.write(`bridge: ${error.message}\n`);
  process.exit(1);
});
