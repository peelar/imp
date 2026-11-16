// The person's side of the connections, in Settings: connect GitHub, cancel the sign-in, disconnect. What they see of
// them rides on the account stream (connections.ts, `state`).
import { type Calls, ok } from "../live/live.ts";
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
  ];
}
