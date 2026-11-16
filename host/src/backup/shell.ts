// The person's side of the backup, in Settings: connect GitHub, cancel the sign-in, disconnect.
import { type Calls, ok } from "../live/live.ts";
import type { AppBackup } from "./backup.ts";

export function backupCalls(backup: AppBackup): Calls {
  return [
    [
      "backupConnect",
      () => {
        backup.connect();

        return ok;
      },
    ],
    [
      "backupCancel",
      () => {
        backup.cancel();

        return ok;
      },
    ],
    [
      "backupDisconnect",
      async () => {
        await backup.disconnect();

        return ok;
      },
    ],
  ];
}
