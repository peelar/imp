// The program the backup runs: git, which keeps the apps' versions in DATA_DIR/backup, and pushes them to GitHub
// through the egress proxy, which puts the owner's github key on the requests (github.ts).
import { execFile } from "node:child_process";
import path from "node:path";

export type BackupCommands = ReturnType<typeof backupCommands>;

export function backupCommands({ dataDir }: { readonly dataDir: string }) {
  const repoDir = path.join(dataDir, "backup");

  /** Runs a program to its end and answers what it printed; a failure says what the program said. */
  const run = async (
    command: string,
    args: readonly string[],
    {
      cwd,
      env = {},
    }: {
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
    } = {}
  ) =>
    await new Promise<string>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
          timeout: 120_000,
        },
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

  /** Git in the backup's repository, as the host uses it whatever the machine's own git settings say. */
  const git = async (args: readonly string[], env?: Record<string, string>) =>
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
        // The egress proxy signs pushes in, so no credential the machine has set up does.
        "-c",
        "credential.helper=",
        ...args,
      ],
      { cwd: repoDir, env }
    );

  return {
    /** The git repository that keeps the apps' versions. */
    repoDir,
    run,
    git,
  };
}
