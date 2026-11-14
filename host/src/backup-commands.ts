// The programs the backup runs: git, which keeps the apps' versions in DATA_DIR/backup, and the GitHub CLI (gh),
// which signs the host in to GitHub and finds or creates its repository. Both run with the host's own GitHub sign-in,
// kept in DATA_DIR/gh beside the host's other credentials, and never with a token from the host's environment.
import { execFile } from "node:child_process";
import path from "node:path";

/** What would sign gh in as someone else, or point it at another GitHub. */
const FOREIGN_SIGN_INS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

export type BackupCommandsOptions = {
  readonly dataDir: string;
  /** The GitHub CLI to run. Default: gh on PATH. */
  readonly gh?: string | undefined;
};

export type BackupCommands = ReturnType<typeof backupCommands>;

export function backupCommands({ dataDir, gh = "gh" }: BackupCommandsOptions) {
  const ghDir = path.join(dataDir, "gh");
  const repoDir = path.join(dataDir, "backup");

  // No browser opens on the host: the person approves the sign-in on a device of theirs.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !FOREIGN_SIGN_INS.has(name)
      )
    ),
    GH_CONFIG_DIR: ghDir,
    BROWSER: "true",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  /** Runs a program to its end and answers what it printed; a failure says what the program said. */
  const run = async (command: string, args: readonly string[], cwd?: string) =>
    await new Promise<string>((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, env, timeout: 120_000 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout.trim());
          } else if (error.code === "ENOENT") {
            reject(
              new Error(`${command} is not installed on the host.`, {
                cause: error,
              })
            );
          } else {
            reject(new Error(stderr.trim() || error.message, { cause: error }));
          }
        }
      );
    });

  return {
    /** The GitHub CLI's path or name. */
    gh,
    /** Where the host's GitHub sign-in is kept. */
    ghDir,
    /** The git repository that keeps the apps' versions. */
    repoDir,
    env,
    run,
    /** Git in the backup's repository, as the host uses it whatever the machine's own git settings say. */
    git: async (...args: string[]) =>
      await run(
        "git",
        [
          "-c",
          "user.name=Imp",
          "-c",
          "user.email=imp@localhost",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          // Pushes sign in through the host's gh, and through nothing the machine has set up.
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=!'${gh}' auth git-credential`,
          ...args,
        ],
        repoDir
      ),
  };
}
