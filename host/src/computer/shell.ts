// The owner's side of the agent's computer, in Settings and the onboarding: look again, try again, and switch to Imp
// cloud, a container on this machine or a computer of theirs. Its state streams on its own source and on the account
// stream (computer.ts, `load`).
import {
  type Call,
  type Calls,
  type LiveSource,
  type Reply,
  refused,
  text,
} from "../live/live.ts";
import type { Computer } from "./computer.ts";

/** What the open views listen on for a change of the computer. */
export const TOPIC = "computer";

/** The computer's state on its own, for its screen's page (screen.html), which shows it above the screen. */
export const computerSource = (computer: Computer): LiveSource => ({
  topics: [TOPIC],
  load: async () => await computer.load(),
});

export function computerCalls(
  computer: Computer,
  /** Whether the imp is in the middle of a turn. */
  busy: () => Promise<boolean>
): Calls {
  // A switch mid-turn would cut the agent's tools off from the machine they started on.
  const betweenTurns =
    (change: (value: string) => Promise<Reply>): Call =>
    async (args) =>
      (await busy())
        ? refused("Wait until your imp finishes, or stop it, then switch.")
        : await change(text(args, 0));

  return [
    ["computerRefresh", () => computer.refresh()],
    ["computerRetry", () => computer.retry()],
    [
      "computerSetCloudKey",
      betweenTurns(async (key) => await computer.setCloudKey(key)),
    ],
    [
      "computerUseCloud",
      betweenTurns(async (size) => await computer.useCloud(size)),
    ],
    [
      "computerUseContainer",
      betweenTurns(async () => await computer.useContainer()),
    ],
    [
      "computerUseOwn",
      betweenTurns(async (device) => await computer.useOwn(device)),
    ],
  ];
}
