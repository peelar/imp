// Who a message in a conversation is from, written into its text. The model reads the message as it is, so the host
// says there what the person did not: that a routine started the run, or which app the person had open. The
// transcript shows only the person's own words, and memory's reflection learns nothing from a routine's run. Every
// line the host adds, and every reader of one, is in this file: a new kind of message changes only here.

// A message sent from the chat beside an app starts with a line naming that app, so the agent knows what "this" is.
// The transcript drops the line again: the person never wrote it.
const CONTEXT = /^\[Sent from the chat beside the [^\]\n]+ app\.\]\n\n/;

/** The message the agent receives when the person writes beside an open app. */
export const withAppContext = (
  text: string,
  app: { readonly name: string } | undefined
) =>
  app ? `[Sent from the chat beside the ${app.name} app.]\n\n${text}` : text;

// A routine's run starts with a line naming the routine and saying the person is away. The transcript shows only the
// routine's instruction, and memory's reflection skips the run, since the person said nothing in it.
const ROUTINE = /^\[Routine: [^\]\n]*\]\n\n/;

/** The message that starts a run of a routine. */
export const routineRun = (name: string, instruction: string) =>
  `[Routine: ${name.replaceAll(/[\]\n]/g, " ")}. It runs on its schedule while the person is away: do it, then answer with what they should know in a few lines, or say there is nothing new. If it needs them (a key, a choice, anything destructive or irreversible), stop and say what you need.]\n\n${instruction}`;

/** Whether the person's side of a message is a routine's run, which they did not write. */
export const isRoutineRun = (text: string) => ROUTINE.test(text);

/** What the person reads of a message: without the lines the host added to it. */
export const personText = (text: string) =>
  text.replace(CONTEXT, "").replace(ROUTINE, "");
