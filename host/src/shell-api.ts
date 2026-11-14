// What the shell reads and changes, by name. Each read is a live source (live.ts) and each change answers a Reply,
// `{ ok, error }`. The shell's own names start with one of a few words (account, chat, apps, build, version,
// computer, memory), which no app may take as its id (app-folders.ts); every other name goes to the app that owns
// it, such as `todosSetDone` to the todos app's `setDone`.
import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Json } from "../../sdk/app.ts";
import type { AppGateway } from "./apps.ts";
import { TOPIC as CHAT, type HomeChat, withAppContext } from "./chat.ts";
import { TOPIC as COMPUTER, type Computer } from "./computer.ts";
import type { Answer, LiveSource } from "./live.ts";
import { TOPIC as MEMORY, type MemoryProvider } from "./memory.ts";
import { TOPIC as ACCOUNT, type ChatGPTAccount } from "./signin.ts";
import { APPS_TOPIC, BUILD_TOPIC, type studio } from "./studio.ts";
import { appTopic } from "./app-folders.ts";

export type ShellApiOptions = {
  readonly account: ChatGPTAccount;
  readonly chat: HomeChat;
  readonly computer: Computer;
  readonly memory: MemoryProvider;
  /** The app studio: drafts, saved versions and the shell's builds. */
  readonly studio: ReturnType<typeof studio>;
  readonly gateway: AppGateway;
  /** The home conversation, which the person's messages go to. */
  readonly home: Conversation;
  readonly context: Context;
  /** The running release's tag; "dev" in a checkout. */
  readonly version: string;
};

export type Reply = { readonly ok: boolean; readonly error: string };

/** A change the shell asks for, with its arguments in order. */
type Call = (args: readonly Json[]) => Promise<Answer> | Answer;

type Calls = readonly (readonly [name: string, call: Call])[];

export type ShellApi = ReturnType<typeof shellApi>;

const ok: Reply = { ok: true, error: "" };
const refused = (error: string): Reply => ({ ok: false, error });

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const isText = (value: Json | undefined): value is string =>
  typeof value === "string";

/** The text argument at a position; "" when the shell sent none there. */
const text = (args: readonly Json[], at: number) => {
  const value = args[at];

  return isText(value) ? value : "";
};

export function shellApi(options: ShellApiOptions) {
  const { gateway } = options;
  const sources = shellSources(options);

  const calls = new Map<string, Call>([
    ...accountCalls(options),
    ...chatCalls(options),
    ...studioCalls(options),
    ...computerCalls(options),
    ...memoryCalls(options),
  ]);

  /** The change an app owns under the shell's name, if any; a write that fails says why. */
  const appCall = (source: string): Call | undefined => {
    const route = gateway.route(source);

    return route
      ? async (args) => {
          try {
            return await gateway.fromShell({ ...route, kind: "write", args });
          } catch (error) {
            return refused(why(error));
          }
        }
      : undefined;
  };

  return {
    /** What the shell reads under `source`, if anything; an app's reads take their arguments in order. */
    live(source: string, args: readonly Json[]): LiveSource | undefined {
      const route = gateway.route(source);

      if (sources.has(source) || !route) {
        return sources.get(source);
      }

      return {
        topics: [appTopic(route.app)],
        load: async () =>
          await gateway.fromShell({ ...route, kind: "read", args }),
      };
    },
    /** Makes the change the shell names; answers nothing when nobody owns the name. */
    async mutate(source: string, args: readonly Json[]) {
      const call = calls.get(source) ?? appCall(source);

      return call ? await call(args) : undefined;
    },
  };
}

/**
 * The shell's own live sources. The shell opens few of them on purpose (a browser opens only six connections to one
 * host), so what Settings shows comes with the account.
 */
function shellSources(options: ShellApiOptions) {
  const { account, chat, computer, memory, studio, version } = options;

  const whole = async (): Promise<Answer> => ({
    ...account.state(),
    computer: await computer.load(),
    memory: {
      name: memory.name,
      location: memory.location,
      entries: await memory.inspect(),
    },
  });

  return new Map<string, LiveSource>([
    ["account", { topics: [ACCOUNT, COMPUTER, MEMORY], load: whole }],
    ["chat", { topics: [CHAT], load: async () => await chat.state() }],
    ["apps", { topics: [APPS_TOPIC], load: async () => studio.state() }],
    [
      "build",
      { topics: [BUILD_TOPIC], load: async () => ({ id: studio.buildId() }) },
    ],
    // The computer's screen is a page of its own (screen.html), which shows the computer's state above it.
    [
      "computer",
      { topics: [COMPUTER], load: async () => await computer.load() },
    ],
    // Never changes while the host runs: an open page compares it with its own after the host restarts (static.ts).
    ["version", { topics: [], load: async () => ({ version }) }],
  ]);
}

function accountCalls({ account }: ShellApiOptions): Calls {
  return [
    [
      "accountSignIn",
      () => {
        account.start();

        return ok;
      },
    ],
    [
      "accountCancel",
      () => {
        account.cancel();

        return ok;
      },
    ],
    [
      "accountSignOut",
      async () => {
        await account.signOut();

        return ok;
      },
    ],
  ];
}

function chatCalls(options: ShellApiOptions): Calls {
  const { account, gateway, home, context } = options;

  return [
    [
      "chatSend",
      async (args) => {
        const message = text(args, 0).trim();

        if (!message) {
          return refused("Write a message first.");
        }

        if (!(await account.usable())) {
          return refused("Sign in with ChatGPT first.");
        }

        // The second argument is the app open beside the chat, "" from the chat tab.
        const open = gateway.apps().find((app) => app.id === args[1]);

        await home.submit(
          {
            type: "input",
            content: withAppContext(message, open),
            whenBusy: "steer",
          },
          context
        );

        return ok;
      },
    ],
    [
      "chatStop",
      async () => {
        await home.abort(context);

        return ok;
      },
    ],
  ];
}

/** The person's decisions on an app's draft and its saved versions; a decision that cannot be made says why. */
function studioCalls({ studio }: ShellApiOptions): Calls {
  const decision =
    (decide: (id: string) => Promise<void>): Call =>
    async (args) => {
      try {
        await decide(text(args, 0));

        return ok;
      } catch (error) {
        return refused(why(error));
      }
    };

  return [
    [
      "appsSave",
      decision(async (id) => {
        await studio.save(id);
      }),
    ],
    [
      "appsDiscard",
      decision(async (id) => {
        await studio.discard(id);
      }),
    ],
    [
      "appsUndo",
      decision(async (id) => {
        await studio.undo(id);
      }),
    ],
  ];
}

function computerCalls({ computer, chat }: ShellApiOptions): Calls {
  // A switch mid-turn would cut the agent's tools off from the machine they started on.
  const betweenTurns =
    (change: (value: string) => Promise<Reply>): Call =>
    async (args) =>
      (await chat.busy())
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
      "computerUseOwn",
      betweenTurns(async (device) => await computer.useOwn(device)),
    ],
  ];
}

function memoryCalls({ memory }: ShellApiOptions): Calls {
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
