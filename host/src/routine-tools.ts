// The agent's side of the routines: the prompt section that lists them and says how they run, and the tools it saves
// and deletes one with. The person runs, pauses and deletes them in the sidebar (routines.ts).
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { hostZone } from "./routine-schedule.ts";
import type { Routines } from "./routines.ts";

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const ABOUT = `A routine is an instruction you carry out on a schedule while the person is away, in a conversation of its own that they can open and reply in. When the person asks for something to happen regularly or at a time ("every morning", "each Friday", "keep an eye on"), save it with save_routine: give the schedule as cron on the clock of their time zone, and write the instruction so it stands on its own, since each run reads only it and that routine's conversation. Prefer tricks and app actions in the instruction, which run fast. Routines run at most every 15 minutes. Say in a sentence what you saved and when it first runs.`;

function prompt(routines: Routines) {
  const listed = routines.list();
  const zone = `The host's time zone is ${hostZone()}; use the person's own when you know it.`;

  if (listed.length === 0) {
    return `${ABOUT} ${zone} There are no routines yet.`;
  }

  const lines = listed.map(
    (r) =>
      `- ${r.name}: ${r.when} (${r.schedule}, ${r.zone})${r.paused ? ", paused" : ""}. ${r.instruction}`
  );

  return `${ABOUT} ${zone} The routines:\n${lines.join("\n")}`;
}

export function routinesExtension(routines: Routines) {
  return defineExtension({
    name: "routines",
    sections: [section("routines", () => prompt(routines))],
    tools: [
      defineTool({
        name: "save_routine",
        description:
          "Save a routine, or change the one with this name: an instruction you carry out on a schedule while the person is away.",
        parameters: obj({
          name: str({
            description:
              'A short name the person reads in the sidebar, such as "Morning pull requests".',
          }),
          when: str({
            description:
              'The schedule in a few words, such as "Weekdays at 8:00".',
          }),
          schedule: str({
            description:
              'The schedule as five-field cron (minute hour day month weekday), such as "0 8 * * 1-5".',
          }),
          timezone: opt(
            str({
              description: `The IANA time zone the schedule's clock is on, such as "Europe/Warsaw". Default: ${hostZone()}.`,
            })
          ),
          instruction: str({
            description: "What to do on each run, written to stand on its own.",
          }),
        }),
        execute: async ({ name, when, schedule, timezone, instruction }) => {
          if (!name.trim() || !instruction.trim()) {
            return text("Give the routine a name and an instruction.");
          }

          try {
            const saved = await routines.save({
              name: name.trim(),
              when: when.trim(),
              schedule,
              zone: timezone?.trim() ? timezone.trim() : undefined,
              instruction: instruction.trim(),
            });

            return text(
              `Saved. It first runs ${saved.next} (${saved.zone}). The person sees it under Routines in the sidebar.`
            );
          } catch (error) {
            return text(`Not saved: ${why(error)}`);
          }
        },
      }),
      defineTool({
        name: "delete_routine",
        description: "Delete a routine by its name, when the person asks.",
        parameters: obj({ name: str({ description: "The routine's name." }) }),
        execute: async ({ name }) =>
          text(
            routines.remove(name)
              ? `Deleted ${name}.`
              : `There is no routine named ${name}.`
          ),
      }),
    ],
  });
}
