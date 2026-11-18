// GitHub's sign-in: the GitHub CLI's device code flow, as the ChatGPT sign-in does (account/account.ts). The host runs
// its own gh, a pinned build it downloads the first time (processes/programs.ts), so nobody installs it. gh signs in to
// a folder of its own, which the host reads the token and the account's name from and then deletes: once the vault has
// the token, it is nowhere else.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { killOnExit } from "../processes/processes.ts";

/** What gh asks for beside its own scopes (repo, read:org, gist): the GitHub app reads the notifications. */
const SCOPES = "notifications";

/** What would sign gh in as someone else, or point it at another GitHub. */
const FOREIGN_SIGN_INS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

/** The GitHub CLI the sign-in runs: its path, once it is there. */
export type Gh = () => Promise<string>;

/** A finished sign-in: the token, and the name of the account it is for. */
export type GithubAccount = { readonly token: string; readonly login: string };

export type SignInEvents = {
  /** GitHub shows the code the person enters at `url`. */
  readonly onCode: (code: string, url: string) => void;
  readonly onSignedIn: (account: GithubAccount) => Promise<void>;
  /** The sign-in stopped, with what to tell the person. */
  readonly onFailed: (error: string) => void;
};

/** gh with its sign-in in `dir`, opening no browser on the host, and with no sign-in from the host's environment. */
const ghEnv = (dir: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !FOREIGN_SIGN_INS.has(name))
  ),
  GH_CONFIG_DIR: dir,
  BROWSER: "true",
  GH_NO_UPDATE_NOTIFIER: "1",
});

/** Runs gh to its end and answers what it printed; a failure says what gh said. */
const runGh = async (gh: string, dir: string, args: readonly string[]) =>
  await new Promise<string>((resolve, reject) => {
    const child = execFile(
      gh,
      args,
      { env: ghEnv(dir), timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message, { cause: error }));
        } else {
          resolve(stdout.trim());
        }
      }
    );

    killOnExit(child);
  });

/** The account gh is signed in to in `dir`: its token and its name. */
export async function readAccount(gh: Gh, dir: string): Promise<GithubAccount> {
  const program = await gh();

  const token = await runGh(program, dir, [
    "auth",
    "token",
    "--hostname",
    "github.com",
  ]);

  const login = await runGh(program, dir, ["api", "user", "--jq", ".login"]);

  if (!/^\S+$/.test(token) || !/^[\w-]+$/.test(login)) {
    throw new Error("gh did not say which GitHub account it signed in to.");
  }

  return { token, login };
}

export function githubSignIn({ gh, dir }: { gh: Gh; dir: string }) {
  /** The sign-in under way. */
  let login: ChildProcess | undefined;
  /** Counts the sign-ins started and stopped, so one still waiting for gh's download knows it was stopped. */
  let attempt = 0;

  const stop = () => {
    const child = login;

    login = undefined;
    attempt += 1;
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  };

  /** The sign-in finished: the account it is for, and gh's folder gone. */
  const finish = async (events: SignInEvents) => {
    try {
      await events.onSignedIn(await readAccount(gh, dir));
    } catch (cause) {
      events.onFailed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** Gets gh, downloading it the first time, then runs its sign-in, unless it was stopped meanwhile. */
  const begin = async (events: SignInEvents) => {
    const mine = attempt;

    try {
      const program = await gh();

      if (attempt === mine) {
        run(program, events);
      }
    } catch (cause) {
      if (attempt === mine) {
        events.onFailed(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  return {
    /** The device code sign-in: the code shows in Settings, and the person approves on any device. */
    start: (events: SignInEvents) => {
      stop();

      begin(events).catch((cause: unknown) => {
        events.onFailed(String(cause));
      });
    },
    /** Stops a sign-in under way, and forgets what gh kept of it. */
    stop,
  };

  /** Runs gh's sign-in at `program`. */
  function run(program: string, events: SignInEvents) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // --insecure-storage keeps the token in gh's folder, which the host reads it from, not in a keychain.
    // --clipboard=false: where gh can copy the code (pbcopy is on every Mac) it says so in other words, with the code
    // in brackets, and the host waited for a code forever. The person copies it from Imp's own Copy button instead.
    const child = spawn(
      program,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        "https",
        "--skip-ssh-key",
        "--insecure-storage",
        "--clipboard=false",
        "--scopes",
        SCOPES,
      ],
      { env: ghEnv(dir), stdio: ["ignore", "pipe", "pipe"] }
    );

    killOnExit(child);
    login = child;
    let output = "";

    const read = (chunk: Buffer) => {
      output += chunk.toString("utf-8");

      const [, code] =
        /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output) ?? [];

      const [url] = /https:\/\/\S+\/login\/device/.exec(output) ?? [];

      if (code && url && login === child) {
        events.onCode(code, url);
      }
    };

    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => {
      if (login === child) {
        login = undefined;
        events.onFailed(error.message);
      }
    });
    child.on("close", (exit) => {
      if (login !== child) {
        return;
      }

      login = undefined;

      if (exit === 0) {
        finish(events).catch((cause: unknown) => {
          events.onFailed(String(cause));
        });
      } else {
        const [said = ""] = output.trim().split("\n").slice(-1);

        events.onFailed(said || `GitHub's sign-in stopped (${String(exit)}).`);
      }
    });
  }
}
