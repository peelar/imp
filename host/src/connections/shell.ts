// The person's side of the connections, in Settings: connect GitHub, cancel the sign-in, disconnect; add an MCP
// server, sign in to it and remove it. What they see of them rides on the account stream (connections.ts, `state` and
// `serverState`).
import { type Calls, ok, text } from "../live/live.ts";
import type { Connections } from "./connections.ts";

export function connectionsCalls(connections: Connections): Calls {
  return [
    [
      "connectionsConnect",
      () => {
        connections.connect();

        return ok;
      },
    ],
    [
      "connectionsCancel",
      () => {
        connections.cancel();

        return ok;
      },
    ],
    ["connectionsDisconnect", async () => await connections.disconnect()],
    [
      "connectionsAddServer",
      async (args) =>
        await connections.servers.add({
          name: text(args, 0),
          url: text(args, 1),
          key: text(args, 2),
        }),
    ],
    // The second argument is the address the person's browser reaches the host at, which the sign-in comes back to.
    [
      "connectionsSignInServer",
      (args) => connections.servers.signIn(text(args, 0), text(args, 1)),
    ],
    [
      "connectionsCancelServer",
      (args) => {
        connections.servers.cancel(text(args, 0));

        return ok;
      },
    ],
    [
      "connectionsRemoveServer",
      async (args) => await connections.servers.remove(text(args, 0)),
    ],
  ];
}
