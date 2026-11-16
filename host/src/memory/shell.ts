// The person's side of the memory, in Settings: forget an entry, or one fact of it. What the imp knows rides on the
// account stream (memory.ts, `inspect`).
import { type Calls, ok, text } from "../live/live.ts";
import type { MemoryProvider } from "./memory.ts";

export function memoryCalls(memory: MemoryProvider): Calls {
  return [
    [
      "memoryForget",
      async (args) => {
        // An entry, and one of its facts ("" forgets the whole entry).
        const fact = text(args, 1);

        await memory.forget(text(args, 0), fact === "" ? undefined : fact);

        return ok;
      },
    ],
  ];
}
