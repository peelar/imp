// Runs on the host, started by pi-env's Connection as the "command" that reaches the daemon:
//   node bridge-client.mjs <bridge-url> <headers-json> serve --token <hex>
// It forwards the arguments to the machine's bridge, then pipes this process's stdin and stdout over the WebSocket.
import WebSocket from "ws";

const [bridgeUrl, headersJson, ...args] = process.argv.slice(2);
const url = new URL(bridgeUrl);
url.searchParams.set("args", JSON.stringify(args));

const ws = new WebSocket(url, { headers: JSON.parse(headersJson) });
const pending = [];
ws.on("open", () => {
	for (const chunk of pending.splice(0)) ws.send(chunk);
});
process.stdin.on("data", (chunk) => (ws.readyState === WebSocket.OPEN ? ws.send(chunk) : pending.push(chunk)));
process.stdin.on("end", () => ws.close());
ws.on("message", (data) => {
	const bytes = Buffer.from(data);
	(bytes[0] === 2 ? process.stderr : process.stdout).write(bytes.subarray(1));
});
ws.on("close", () => process.exit(0));
ws.on("error", (error) => {
	process.stderr.write(`bridge: ${error.message}\n`);
	process.exit(1);
});
