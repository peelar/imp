// The owner's side of the feature flags, in Settings: choose whether a flag is on after the next start. The flags
// themselves ride on the account stream (flags.ts, `list`); a flag never changes while the host runs.
import { type Calls, ok, refused, text } from "../live/live.ts";
import type { Flags } from "./flags.ts";

export function flagCalls(flags: Flags): Calls {
  return [
    [
      "flagsChoose",
      (args) => {
        const key = text(args, 0);
        const flag = flags.list().find((each) => each.key === key);

        if (!flag) {
          return refused(`There is no feature flag named "${key}".`);
        }

        flags.choose(flag.key, args[1] === true);

        return ok;
      },
    ],
  ];
}
