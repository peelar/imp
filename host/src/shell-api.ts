// What the shell reads and changes, by name. Each read is a live source (live/live.ts) and each change answers a Reply,
// `{ ok, error }`. The shell's own names start with one of a few words (account, chat, routines, apps, build,
// version, computer, memory, secrets, backup, flags), which no app may take as its id (apps/folders.ts); every other name goes to the
// app that owns it, such as `todosSetDone` to the todos app's `setDone`.
import type { Json } from "../../sdk/app.ts";
import { type AppGateway, appTopic, SYNC_TOPIC } from "./apps/apps.ts";
import { TOPIC as CHAT, type Chats } from "./chats/chats.ts";
import { TOPIC as COMPUTER, type Computer } from "./computer/computer.ts";
import type { Answer, LiveSource } from "./live/live.ts";
import { type AppBackup, TOPIC as BACKUP } from "./backup/backup.ts";
import { TOPIC as MEMORY, type MemoryProvider } from "./memory/memory.ts";
import { TOPIC as SECRETS, type Secrets } from "./secrets/secrets.ts";
import { TOPIC as ACCOUNT, type ModelAccount } from "./account/account.ts";
import { TOPIC as FLAGS, type Flags, isFlagKey } from "./flags/flags.ts";
import { TOPIC as ROUTINES, type Routines } from "./routines/routines.ts";
import { TOPIC as NOTICES, type Notices } from "./notices/notices.ts";
import { TOPIC as TRICKS, type Tricks } from "./tricks/tricks.ts";
import { APPS_TOPIC, BUILD_TOPIC, type studio } from "./studio/studio.ts";

export type ShellApiOptions = {
  readonly account: ModelAccount;
  /** The person's conversations: the open one, which their messages go to, and the rest. */
  readonly chats: Chats;
  /** What the imp does on a schedule. */
  readonly routines: Routines;
  /** What the person is told while they are away, which every open shell shows as a notification. */
  readonly notices: Notices;
  /** What the imp learned to do in the browser. */
  readonly tricks: Tricks;
  readonly computer: Computer;
  readonly memory: MemoryProvider;
  readonly secrets: Secrets;
  /** The apps' code, kept in git and pushed to GitHub. */
  readonly backup: AppBackup;
  /** The feature flags, for Settings: each one's state and the owner's choice for the next start. */
  readonly flags: Flags;
  /** The app studio: drafts, saved versions and the shell's builds. */
  readonly studio: ReturnType<typeof studio>;
  readonly gateway: AppGateway;
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
    ...routineCalls(options),
    ...studioCalls(options),
    ...computerCalls(options),
    ...memoryCalls(options),
    ...secretsCalls(options),
    ...backupCalls(options),
    ...flagCalls(options),
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
  const {
    account,
    backup,
    chats,
    computer,
    flags,
    memory,
    notices,
    routines,
    secrets,
    studio,
    tricks,
    version,
  } = options;

  const whole = async (): Promise<Answer> => ({
    ...account.state(),
    computer: await computer.load(),
    memory: {
      name: memory.name,
      location: memory.location,
      entries: await memory.inspect(),
    },
    secrets: secrets.state(),
    backup: backup.state(),
    tricks: tricks.list(),
    routines: routines.state(),
    notices: notices.state(),
    flags: flags.list(),
  });

  return new Map<string, LiveSource>([
    [
      "account",
      {
        topics: [
          ACCOUNT,
          COMPUTER,
          MEMORY,
          SECRETS,
          BACKUP,
          TRICKS,
          ROUTINES,
          NOTICES,
          FLAGS,
        ],
        load: whole,
      },
    ],
    ["chat", { topics: [CHAT], load: async () => await chats.state() }],
    [
      "apps",
      { topics: [APPS_TOPIC, SYNC_TOPIC], load: async () => studio.state() },
    ],
    [
      "build",
      { topics: [BUILD_TOPIC], load: async () => ({ id: studio.buildId() }) },
    ],
    // The computer's screen is a page of its own (computer/screen.html), which shows the computer's state above it.
    [
      "computer",
      { topics: [COMPUTER], load: async () => await computer.load() },
    ],
    // Never changes while the host runs: an open page compares it with its own after the host restarts (static.ts).
    ["version", { topics: [], load: async () => ({ version }) }],
  ]);
}

function flagCalls({ flags }: ShellApiOptions): Calls {
  return [
    [
      "flagsChoose",
      (args) => {
        const key = text(args, 0);

        if (!isFlagKey(key)) {
          return refused(`There is no feature flag named "${key}".`);
        }

        flags.choose(key, args[1] === true);

        return ok;
      },
    ],
  ];
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
      "accountUseKey",
      async (args) => {
        const error = await account.useKey({
          baseUrl: text(args, 0),
          key: text(args, 1),
          model: text(args, 2),
        });

        return error ? refused(error) : ok;
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
  const { account, gateway, chats } = options;

  return [
    [
      "chatSend",
      async (args) => {
        const message = text(args, 0).trim();

        if (!message) {
          return refused("Write a message first.");
        }

        if (!(await account.usable())) {
          return refused("Sign in first.");
        }

        // The second argument is the app open beside the chat, "" from the chat tab.
        const open = gateway.apps().find((app) => app.id === args[1]);

        await chats.submit(message, open);

        return ok;
      },
    ],
    [
      "chatStop",
      async () => {
        await chats.stop();

        return ok;
      },
    ],
    [
      "chatNew",
      async () => {
        await chats.fresh();

        return ok;
      },
    ],
    [
      "chatShow",
      async (args) => {
        try {
          await chats.show(text(args, 0));

          return ok;
        } catch (error) {
          return refused(why(error));
        }
      },
    ],
  ];
}

/** The person's routines, from the sidebar: open one's conversation, run it now, pause or resume it, delete it. */
function routineCalls({ routines }: ShellApiOptions): Calls {
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

/** The person's decisions on an app's draft and its saved versions; a decision that cannot be made says why. */
function studioCalls({ studio, gateway }: ShellApiOptions): Calls {
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
    [
      "appsSync",
      async (args) => {
        const failed = await gateway.syncNow(text(args, 0));

        return failed === undefined ? ok : refused(failed);
      },
    ],
  ];
}

function computerCalls({ computer, chats }: ShellApiOptions): Calls {
  // A switch mid-turn would cut the agent's tools off from the machine they started on.
  const betweenTurns =
    (change: (value: string) => Promise<Reply>): Call =>
    async (args) =>
      (await chats.busy())
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

/** The owner's keys and logins: added, replaced and deleted in Settings, never through the chat. */
function secretsCalls({ secrets }: ShellApiOptions): Calls {
  return [
    [
      "secretsPut",
      async (args) =>
        await secrets.put({
          name: text(args, 0),
          service: text(args, 1),
          value: text(args, 2),
          hosts: text(args, 3),
          header: text(args, 4),
          prefix: text(args, 5),
          envName: text(args, 6),
        }),
    ],
    [
      "secretsPutLogin",
      async (args) =>
        await secrets.putLogin({
          name: text(args, 0),
          site: text(args, 1),
          username: text(args, 2),
          password: text(args, 3),
          otp: text(args, 4),
        }),
    ],
    ["secretsDelete", async (args) => await secrets.remove(text(args, 0))],
    // The owner turns down a key the imp asked for.
    ["secretsDismiss", (args) => secrets.dismiss(text(args, 0))],
  ];
}

/** The backup's GitHub connection, made and dropped in Settings. */
function backupCalls({ backup }: ShellApiOptions): Calls {
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
