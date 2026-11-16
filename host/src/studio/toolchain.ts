// What the shell builds with: Exact at the commit client/exact-rev pins, with Bun and the Rust toolchains its web build
// reads. A checkout's developer installs them with scripts/setup.sh. An installed host installs them itself with the
// same script's `exact` part, from its release, and again when an update moves the pin. The pin it last installed is
// kept in DATA_DIR/exact-ready, so a setup cut short is run again.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { compile, str } from "@earendil-works/pi-schema";
import { killOnExit, lastLines } from "../kernel/children.ts";

const commit = compile(str({ pattern: "^[0-9a-f]{40}$" }));

/**
 * The environment the setup and the shell's build run in. A service manager starts the host with a short PATH, so it
 * adds where Node, Bun and Rust are: Node beside the host's own, Bun and rustup where their installers put them.
 */
export const toolEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [
    path.dirname(process.execPath),
    path.join(homedir(), ".bun", "bin"),
    path.join(homedir(), ".cargo", "bin"),
    process.env.PATH ?? "/usr/bin:/bin",
  ].join(path.delimiter),
});

export type ToolchainOptions = {
  readonly dataDir: string;
  /** The shell's source (client/), whose exact-rev pins Exact. */
  readonly clientDir: string;
  /** Where Exact is installed. */
  readonly exact: string;
  /** scripts/setup.sh, on a host that installs Exact itself. Absent: a checkout, whose developer installs it. */
  readonly setup?: string | undefined;
  readonly log: (message: string) => void;
};

export type Toolchain = ReturnType<typeof exactToolchain>;

export function exactToolchain(options: ToolchainOptions) {
  const { log } = options;
  const marker = path.join(options.dataDir, "exact-ready");

  let installing: Promise<void> | undefined;
  let failure: string | undefined;

  /** The commit the release pins. */
  const pinned = () => {
    const rev = commit.validate(
      readFileSync(path.join(options.clientDir, "exact-rev"), "utf-8").trim()
    );

    if (!rev.ok) {
      throw new Error(`client/exact-rev does not name a commit`);
    }

    return rev.value;
  };

  const installed = () =>
    existsSync(marker) && readFileSync(marker, "utf-8").trim() === pinned();

  /** Runs the setup; one at a time. */
  async function install(setup: string): Promise<void> {
    installing ??= new Promise<void>((resolve, reject) => {
      const rev = pinned();
      const started = Date.now();

      log(`studio: installing Exact ${rev.slice(0, 12)} in ${options.exact}`);

      const child = spawn("sh", [setup, "exact"], {
        cwd: path.dirname(path.dirname(setup)),
        env: { ...toolEnv(), EXACT: options.exact },
        stdio: ["ignore", "pipe", "pipe"],
      });

      killOnExit(child);

      let output = "";

      const printed = (chunk: Buffer) => {
        output += chunk.toString();
      };

      child.stdout.on("data", printed);
      child.stderr.on("data", printed);

      const failed = (why: string) => {
        failure = why;
        log(`studio: installing Exact failed: ${why}`);
        reject(new Error(why));
      };

      child.on("error", (error) => {
        failed(error.message);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          failed(lastLines(output, 8));

          return;
        }

        writeFileSync(marker, rev);
        failure = undefined;
        log(
          `studio: installed Exact in ${Math.round((Date.now() - started) / 1000)} s`
        );
        resolve();
      });
    }).finally(() => {
      installing = undefined;
    });

    await installing;
  }

  return {
    /** Resolves once Exact is installed at the pin, installing it first on a host that installs its own. */
    async ready() {
      if (options.setup && (installing || !installed())) {
        await install(options.setup);
      }
    },
    /**
     * Throws, on a host that installs its own Exact, while Exact is not installed at the pin, and starts installing it,
     * so a build fails at once with what to do instead of waiting minutes.
     */
    require() {
      const { setup } = options;

      if (!setup || (!installing && installed())) {
        return;
      }

      const before = failure;

      // Whoever waits on it hears the failure; this only starts it.
      install(setup).catch(() => null);

      throw new Error(
        before
          ? `Imp could not install the tools it builds apps with, and is trying again. Preview again in a few minutes. Last time it said:\n${before}`
          : "Imp is installing the tools it builds apps with, once, which takes a few minutes. Preview again when it is done."
      );
    },
  };
}
