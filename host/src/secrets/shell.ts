// The owner's side of the secrets, in Settings: keys and logins added, replaced and deleted there, never through the
// chat, and a request from the imp turned down. What Settings shows of them is view.ts.
import { type Calls, text } from "../live/live.ts";
import type { Secrets } from "./secrets.ts";

export function secretsCalls(secrets: Secrets): Calls {
  return [
    [
      "secretsPut",
      async (args) =>
        await secrets.put({
          name: text(args, 0),
          service: text(args, 1),
          value: text(args, 2),
          hosts: text(args, 3),
          header: text(args, 4),
          prefix: text(args, 5),
          envName: text(args, 6),
        }),
    ],
    [
      "secretsPutLogin",
      async (args) =>
        await secrets.putLogin({
          name: text(args, 0),
          site: text(args, 1),
          username: text(args, 2),
          password: text(args, 3),
          otp: text(args, 4),
        }),
    ],
    ["secretsDelete", async (args) => await secrets.remove(text(args, 0))],
    // The owner turns down a key the imp asked for.
    ["secretsDismiss", (args) => secrets.dismiss(text(args, 0))],
  ];
}
