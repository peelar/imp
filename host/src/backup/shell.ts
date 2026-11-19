// The person's side of the backup, in Settings under the GitHub connection: turn it on, turn it off.
import { type Calls, ok, text } from "../live/live.ts";
import type { AppBackup } from "./backup.ts";

export function backupCalls(backup: AppBackup): Calls {
  return [
    [
      "backupTurnOn",
      // Who can see the repository if it has to be made: private unless the person chose public.
      (args) => {
        backup.turnOn(text(args, 0) === "public" ? "public" : "private");

        return ok;
      },
    ],
    [
      "backupTurnOff",
      () => {
        backup.turnOff();

        return ok;
      },
    ],
  ];
}
