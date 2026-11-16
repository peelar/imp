// The accounts the host connects to, for everything in Imp that uses them: GitHub, which the GitHub app reads, the
// imp's gh and git use, and the backup pushes to. Connecting signs in once (github.ts) and hands the token to the
// vault as the owner's key named github; from there the egress proxy puts it on each request, and nothing else holds
// it. A github key the owner added in Secrets connects GitHub the same way. The host keeps only the account's name, in
// DATA_DIR/connections.json.
//
// A host whose backup signed in to GitHub before connections existed kept that sign-in in DATA_DIR/gh: the first
// start moves it into the vault, unless the owner has a github key already, and deletes the folder.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compile, map, obj, str } from "@earendil-works/pi-schema";
import { readKept } from "../datadir/datadir.ts";
import type { Reply, Topics } from "../live/live.ts";
import { githubSignIn, readAccount } from "./github.ts";

export { connectionsCalls } from "./shell.ts";

export const TOPIC = "connections";

/** A connection as Settings shows it. */
export type Connection = {
  readonly id: string;
  readonly label: string;
  /** "off", "starting", "waiting" (for the person to enter `code` at `url`) or "on". */
  readonly status: string;
  readonly code: string;
  readonly url: string;
  /** The account's name, such as "peelar"; "" when the host does not know it, as for a key added in Secrets. */
  readonly login: string;
  /** Why the last sign-in failed; "" when it did not. */
  readonly error: string;
};

/** The owner's keys in the vault, which a connection keeps its token as. */
export type ConnectionKeys = {
  /** Waits for the vault; throws why it is not there. */
  readonly ready: () => Promise<void>;
  readonly has: (name: string) => boolean;
  readonly put: (name: string, value: string) => Promise<Reply>;
  readonly remove: (name: string) => Promise<Reply>;
};

export type ConnectionsOptions = {
  readonly dataDir: string;
  /** The GitHub CLI the sign-in runs. Default: gh on PATH. */
  readonly gh?: string | undefined;
  readonly topics: Topics;
  readonly keys: ConnectionKeys;
  /** A connection was disconnected, so what used it stops: the backup, for GitHub. */
  readonly disconnected: (id: string) => void;
  readonly log?: ((message: string) => void) | undefined;
};

/** The key GitHub's token is kept as. */
const GITHUB_KEY = "github";

const keptJson = compile(map(obj({ login: str() })));

const IDLE = { status: "off", code: "", url: "", error: "" };

/** The connected accounts' names, kept in DATA_DIR/connections.json. A damaged file reads as no names. */
function keptLogins(file: string, log: (line: string) => void) {
  let logins =
    readKept(file, keptJson, (problem) => {
      log(`connections: ${problem}`);
    }) ?? {};

  return {
    github: () => logins.github?.login ?? "",
    keep: (login: string) => {
      logins = login ? { github: { login } } : {};
      writeFileSync(file, JSON.stringify(logins));
    },
  };
}

/** Moves the backup's sign-in from before connections, in DATA_DIR/gh, into the vault, and deletes its folder. */
async function moveOldSignIn(
  { dataDir, gh, keys }: { dataDir: string; gh: string; keys: ConnectionKeys },
  keep: (token: string, login: string) => Promise<void>
) {
  const old = path.join(dataDir, "gh");

  if (!existsSync(path.join(old, "hosts.yml"))) {
    return false;
  }

  await keys.ready();

  if (!keys.has(GITHUB_KEY)) {
    const { token, login } = await readAccount(gh, old);

    await keep(token, login);
  }

  rmSync(old, { recursive: true, force: true });

  return true;
}

export function openConnections(options: ConnectionsOptions) {
  const { keys } = options;
  const gh = options.gh ?? "gh";

  const log =
    options.log ??
    ((line: string) => {
      console.error(line);
    });

  const logins = keptLogins(
    path.join(options.dataDir, "connections.json"),
    log
  );

  let flow = IDLE;

  const signIn = githubSignIn({
    gh,
    dir: path.join(options.dataDir, "connections", "github-sign-in"),
  });

  const changed = () => {
    options.topics.changed(TOPIC);
  };

  const setFlow = (next: Partial<typeof IDLE>) => {
    flow = { ...flow, ...next };
    changed();
  };

  /** Keeps a signed-in account's token in the vault, and its name here. */
  const keep = async (token: string, login: string) => {
    const kept = await keys.put(GITHUB_KEY, token);

    if (!kept.ok) {
      throw new Error(kept.error);
    }

    logins.keep(login);
  };

  return {
    /** What Settings shows: GitHub, connected while the vault has a github key. */
    state: (): Connection[] => {
      const on = flow.status === "off" && keys.has(GITHUB_KEY);

      return [
        {
          id: "github",
          label: "GitHub",
          ...flow,
          status: on ? "on" : flow.status,
          login: on ? logins.github() : "",
        },
      ];
    },
    start: () => {
      moveOldSignIn({ dataDir: options.dataDir, gh, keys }, keep)
        .then(changed)
        .catch((cause: unknown) => {
          log(
            `connections: the backup's GitHub sign-in stays in DATA_DIR/gh: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        });
    },
    /** GitHub's device code sign-in: the code shows in Settings, and the person approves on any device. */
    connect: () => {
      if (flow.status !== "off") {
        return;
      }

      setFlow({ ...IDLE, status: "starting" });
      signIn.start({
        onCode: (code, url) => {
          if (flow.status === "starting") {
            setFlow({ status: "waiting", code, url });
          }
        },
        onSignedIn: async ({ token, login }) => {
          try {
            await keep(token, login);
            setFlow(IDLE);
          } catch (cause) {
            setFlow({
              ...IDLE,
              error: `Signed in to GitHub, but the vault did not keep the key: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
          }
        },
        onFailed: (error) => {
          setFlow({ ...IDLE, error });
        },
      });
    },
    cancel: () => {
      signIn.stop();
      setFlow(IDLE);
    },
    /** Takes the github key out of the vault, and stops what used it. The account on GitHub is untouched. */
    disconnect: async (): Promise<Reply> => {
      signIn.stop();
      setFlow(IDLE);

      const removed = await keys.remove(GITHUB_KEY);

      if (removed.ok) {
        logins.keep("");
        options.disconnected("github");
      }

      changed();

      return removed;
    },
    close: signIn.stop,
  };
}

export type Connections = ReturnType<typeof openConnections>;
