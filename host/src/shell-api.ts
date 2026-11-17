// What the shell reads and changes, by name. Each read is a live source and each change a call (live/live.ts); every
// context names its own in its shell.ts, and this file puts them together. The shell's own names start with one of a
// few words (account, chat, routines, apps, build, version, computer, memory, secrets, backup, connections, flags,
// assistants), which no app
// may take as its id (apps/folders.ts); every other name goes to the app that owns it, such as `todosSetDone` to the
// todos app's `setDone`.
import type { Json } from "../../sdk/app.ts";
import { type AppGateway, appCall, appSource, appsCalls } from "./apps/apps.ts";
import {
  type Assistants,
  assistantsCalls,
  TOPIC as ASSISTANTS,
} from "./assistants/assistants.ts";
import { type Chats, chatCalls, chatSource } from "./chats/chats.ts";
import {
  TOPIC as COMPUTER,
  type Computer,
  computerCalls,
  computerSource,
} from "./computer/computer.ts";
import type { Answer, Call, LiveSource } from "./live/live.ts";
import {
  type AppBackup,
  backupCalls,
  TOPIC as BACKUP,
} from "./backup/backup.ts";
import {
  type Connections,
  connectionsCalls,
  TOPIC as CONNECTIONS,
} from "./connections/connections.ts";
import {
  TOPIC as MEMORY,
  type MemoryProvider,
  memoryCalls,
} from "./memory/memory.ts";
import {
  TOPIC as SECRETS,
  type Secrets,
  secretsCalls,
} from "./secrets/secrets.ts";
import {
  TOPIC as ACCOUNT,
  accountCalls,
  type ModelAccount,
} from "./account/account.ts";
import { flagCalls, type Flags, TOPIC as FLAGS } from "./flags/flags.ts";
import {
  TOPIC as ROUTINES,
  routineCalls,
  type Routines,
} from "./routines/routines.ts";
import {
  TOPIC as NOTICES,
  type Notifications,
} from "./notifications/notifications.ts";
import { TOPIC as TRICKS, type Tricks } from "./tricks/tricks.ts";
import {
  APPS_TOPIC,
  appsSource,
  buildSource,
  type Studio,
  studioCalls,
} from "./studio/studio.ts";

export type ShellApiOptions = {
  readonly account: ModelAccount;
  /** The person's conversations: the open one, which their messages go to, and the rest. */
  readonly chats: Chats;
  /** What the imp does on a schedule. */
  readonly routines: Routines;
  /** What the person is told while they are away, which every open shell shows as a notification. */
  readonly notifications: Notifications;
  /** What the imp learned to do in the browser. */
  readonly tricks: Tricks;
  readonly computer: Computer;
  readonly memory: MemoryProvider;
  readonly secrets: Secrets;
  /** The apps' code, kept in git and pushed to GitHub. */
  readonly backup: AppBackup;
  /** The accounts the host connects to, such as GitHub. */
  readonly connections: Connections;
  /** The feature flags, for Settings: each one's state and the owner's choice for the next start. */
  readonly flags: Flags;
  /** The apps the owner shares with other assistants over MCP, for Settings → Assistants. */
  readonly assistants: Assistants;
  /** The app studio: drafts, saved versions and the shell's builds. */
  readonly studio: Studio;
  readonly gateway: AppGateway;
  /** The running release's tag; "dev" in a checkout. */
  readonly version: string;
};

export type ShellApi = ReturnType<typeof shellApi>;

export function shellApi(options: ShellApiOptions) {
  const { account, chats, computer, gateway, studio } = options;
  const sources = shellSources(options);

  const calls = new Map<string, Call>([
    ...accountCalls(account),
    ...chatCalls(chats, {
      usable: async () => await account.usable(),
      apps: gateway.apps,
    }),
    ...routineCalls(options.routines),
    ...studioCalls(studio),
    ...appsCalls(gateway),
    ...computerCalls(computer, async () => await chats.busy()),
    ...memoryCalls(options.memory),
    ...secretsCalls(options.secrets),
    ...backupCalls(options.backup),
    ...connectionsCalls(options.connections),
    ...flagCalls(options.flags),
    ...assistantsCalls(options.assistants),
  ]);

  return {
    /** What the shell reads under `source`, if anything; an app's reads take their arguments in order. */
    live(source: string, args: readonly Json[]): LiveSource | undefined {
      return sources.get(source) ?? appSource(gateway, source, args);
    },
    /** Makes the change the shell names; answers nothing when nobody owns the name. */
    async mutate(source: string, args: readonly Json[]) {
      const call = calls.get(source) ?? appCall(gateway, source);

      return call ? await call(args) : undefined;
    },
    /** An image the person sent in a chat, by the path its transcript row names (chats' `imagePath`). */
    image: async (conversation: string, entry: number, nth: number) =>
      await chats.image(conversation, entry, nth),
  };
}

/**
 * The shell's own live sources. The shell opens few of them on purpose (a browser opens only six connections to one
 * host), so what Settings shows comes with the account.
 */
function shellSources(options: ShellApiOptions) {
  const {
    account,
    assistants,
    backup,
    chats,
    connections,
    computer,
    flags,
    memory,
    notifications,
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
    connections: connections.state(),
    mcpServers: connections.serverState(),
    tricks: tricks.list(),
    routines: routines.state(),
    notices: notifications.state(),
    flags: flags.list(),
    assistants: assistants.state(),
    introduceApps: studio.introduceApps(),
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
          CONNECTIONS,
          TRICKS,
          ROUTINES,
          NOTICES,
          FLAGS,
          ASSISTANTS,
          APPS_TOPIC,
        ],
        load: whole,
      },
    ],
    ["chat", chatSource(chats)],
    ["apps", appsSource(studio)],
    ["build", buildSource(studio)],
    // The computer's screen is a page of its own (computer/screen.html), which shows the computer's state above it.
    ["computer", computerSource(computer)],
    // Never changes while the host runs: an open page compares it with its own after the host restarts (static.ts).
    ["version", { topics: [], load: async () => ({ version }) }],
  ]);
}
