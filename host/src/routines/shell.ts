// The person's side of the routines, from the sidebar: open one's conversation, run it now, pause or resume it,
// delete it. The imp saves them with its tools (tools.ts).
import type { Json } from "../../../sdk/app.ts";
import { type Call, type Calls, ok, refused, text, why } from "../live/live.ts";
import type { Routines } from "./routines.ts";

export function routineCalls(routines: Routines): Calls {
  const onRoutine =
    (
      change: (id: string, args: readonly Json[]) => Promise<void> | void
    ): Call =>
    async (args) => {
      try {
        await change(text(args, 0), args);

        return ok;
      } catch (error) {
        return refused(why(error));
      }
    };

  return [
    [
      "routinesOpen",
      onRoutine(async (id) => {
        await routines.open(id);
      }),
    ],
    [
      "routinesRun",
      onRoutine((id) => {
        routines.runNow(id);
      }),
    ],
    // The second argument is whether to pause (true) or resume (false).
    [
      "routinesPause",
      onRoutine((id, args) => {
        routines.pause(id, args[1] === true);
      }),
    ],
    [
      "routinesDelete",
      onRoutine((id) => {
        routines.delete(id);
      }),
    ],
  ];
}
