// The backup's GitHub side: the host signs in with the GitHub CLI's device code flow, as the ChatGPT sign-in does
// (account/account.ts), and finds or creates the person's private imp-apps repository. The sign-in is the host's own
// (commands.ts), kept in DATA_DIR/gh.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import type { BackupCommands } from "./commands.ts";

/** The repository the apps go to, under the person's GitHub account. */
const REPO_NAME = "imp-apps";

/** Where the versions are pushed: "owner/imp-apps" and its address. */
export type Remote = { readonly repo: string; readonly url: string };

export type SignInEvents = {
  /** GitHub shows the code the person enters at `url`. */
  readonly onCode: (code: string, url: string) => void;
  readonly onSignedIn: () => void;
  /** The sign-in stopped, with what to tell the person. */
  readonly onFailed: (error: string) => void;
};

const isSystemError = (error: Error): error is NodeJS.ErrnoException =>
  "code" in error;

export type GithubSignIn = ReturnType<typeof githubSignIn>;

export function githubSignIn({ gh, ghDir, env, run }: BackupCommands) {
  /** The sign-in under way. */
  let login: ChildProcess | undefined;

  const stop = () => {
    const child = login;

    login = undefined;
    child?.kill();
  };

  return {
    /** GitHub's device code sign-in: the code shows in Settings, and the person approves on any device. */
    start: ({ onCode, onSignedIn, onFailed }: SignInEvents) => {
      mkdirSync(ghDir, { recursive: true, mode: 0o700 });

      // --insecure-storage keeps the token in DATA_DIR/gh, as the ChatGPT one is in DATA_DIR, not in a keychain
      // that a background service may not reach.
      const child = spawn(
        gh,
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
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );

      login = child;
      let output = "";

      const read = (chunk: Buffer) => {
        output += chunk.toString("utf-8");

        const [, code] =
          /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output) ?? [];

        const [url] = /https:\/\/\S+\/login\/device/.exec(output) ?? [];

        if (code && url && login === child) {
          onCode(code, url);
        }
      };

      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("error", (error) => {
        if (login !== child) {
          return;
        }

        login = undefined;
        onFailed(
          isSystemError(error) && error.code === "ENOENT"
            ? "The host needs the GitHub CLI: install gh (cli.github.com) on it, then connect again."
            : error.message
        );
      });
      child.on("close", (exit) => {
        if (login !== child) {
          return;
        }

        login = undefined;

        const [said = ""] = output.trim().split("\n").slice(-1);

        if (exit === 0) {
          onSignedIn();
        } else {
          onFailed(said || `GitHub's sign-in stopped (${String(exit)}).`);
        }
      });
    },
    /** Stops a sign-in under way. */
    stop,
    /** After the sign-in: the person's imp-apps repository, made private if it is not there yet. */
    repository: async (): Promise<Remote> => {
      const owner = await run(gh, ["api", "user", "--jq", ".login"]);
      const repo = `${owner}/${REPO_NAME}`;

      const view = async () =>
        await run(gh, ["repo", "view", repo, "--json", "url", "--jq", ".url"]);

      try {
        return { repo, url: await view() };
      } catch {
        // Not there yet.
        await run(gh, [
          "repo",
          "create",
          repo,
          "--private",
          "--description",
          "My Imp apps' code, backed up by my Imp host.",
        ]);

        return { repo, url: await view() };
      }
    },
    /** Signs the host out of GitHub and forgets its sign-in. The repository on GitHub stays. */
    signOut: async () => {
      stop();

      try {
        await run(gh, ["auth", "logout", "--hostname", "github.com"]);
      } catch {
        // Signed out already, or no gh: the sign-in's folder goes either way.
      }

      rmSync(ghDir, { recursive: true, force: true });
    },
  };
}
