// The owner's side of other assistants, in Settings → Assistants: share an app with them, or stop. What Settings shows
// rides on the account stream (assistants.ts, `state`).
import { type Calls, ok, refused, text } from "../live/live.ts";
import type { Assistants } from "./assistants.ts";

export function assistantsCalls(assistants: Assistants): Calls {
  return [
    [
      "assistantsShare",
      (args) => {
        const id = text(args, 0);

        return assistants.share(id, args[1] === true)
          ? ok
          : refused(`There is no ${id} app.`);
      },
    ],
  ];
}
