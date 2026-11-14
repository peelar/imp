// Chrome's DevTools protocol for the host, the part of agentd behind /chrome: the host types the owner's logins into a
// page of the site a login is for (src/chrome.ts). The browser is the one the agent drives with agent-browser, in
// its profile (agentd.ts). Chrome writes the port and path of its DevTools endpoint, on the machine's loopback, to
// DevToolsActivePort in that profile; this bridges one host connection to that browser target.
//
// The host strips this file's types and installs it beside agentd.mjs (src/machine-runtime.ts). Import only types,
// Node's own modules and ws.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type RawData, WebSocket } from "ws";

const MAX_PAYLOAD = 64 * 1024 * 1024;

/** The browser target's WebSocket URL, from the profile's DevToolsActivePort; "" when Chrome has not written one. */
async function browserTarget(profile: string) {
  let written = "";

  try {
    written = await readFile(path.join(profile, "DevToolsActivePort"), "utf-8");
  } catch {
    // Chrome has not run in this profile: no target.
  }

  const [port = "", target = ""] = written.split("\n");

  return /^\d{1,5}$/.test(port) && target.startsWith("/devtools/browser/")
    ? `ws://127.0.0.1:${port}${target}`
    : "";
}

const NOT_OPEN = "The browser is not open.";

/** Bridges the host's socket to Chrome's browser target; what the host sends before Chrome answers waits. */
export function serveChrome(ws: WebSocket, profile: string) {
  const early: RawData[] = [];
  let chrome: WebSocket | undefined;

  ws.on("message", (data) => {
    if (chrome?.readyState === WebSocket.OPEN) {
      chrome.send(data, { binary: false });
    } else {
      early.push(data);
    }
  });
  ws.on("close", () => {
    chrome?.close();
  });

  const bridge = async () => {
    const target = await browserTarget(profile);

    if (!target) {
      ws.close(1011, NOT_OPEN);

      return;
    }

    const opened = new WebSocket(target, { maxPayload: MAX_PAYLOAD });

    chrome = opened;
    opened.on("open", () => {
      for (const data of early.splice(0)) {
        opened.send(data, { binary: false });
      }
    });
    opened.on("message", (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: false });
      }
    });
    // A DevToolsActivePort left behind by a Chrome that has since closed: nothing listens on its port.
    opened.on("error", () => {
      ws.close(1011, NOT_OPEN);
    });
    opened.on("close", () => {
      ws.close(1000);
    });
  };

  bridge().catch((cause: unknown) => {
    console.error(`agentd: the Chrome bridge failed: ${String(cause)}`);
    ws.close(1011, "Chrome's DevTools did not answer.");
  });
}
