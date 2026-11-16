// The person's side of the backup, in Settings under the GitHub connection: turn it on, turn it off.
import { type Calls, ok } from "../live/live.ts";
import type { AppBackup } from "./backup.ts";

export function backupCalls(backup: AppBackup): Calls {
  return [
    [
      "backupTurnOn",
      () => {
        backup.turnOn();

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
