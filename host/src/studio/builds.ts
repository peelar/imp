// The web builds of the shell with the host's apps in it, and which of them the host serves.
//
//   builds/<build id>/      a web build; the three newest are kept
//   builds/current.json     { id: the build the host serves }
//   shell/                  where a build is assembled (shell.ts)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { compile, obj, str } from "@earendil-works/pi-schema";
import type { AppGateway } from "../apps/apps.ts";
import { readKept } from "../kernel/kept.ts";
import { buildShell, type ShellApp } from "./shell.ts";
import type { Toolchain } from "./toolchain.ts";

const KEPT_BUILDS = 3;

const currentJson = compile(obj({ id: str() }));

export type ShellBuildsOptions = {
  readonly dataDir: string;
  /** The shell's source (client/). */
  readonly clientDir: string;
  /** The Exact checkout the shell builds with. */
  readonly exact: string;
  readonly toolchain: Toolchain;
  readonly gateway: AppGateway;
  /** Tells the open pages that the host serves another build. */
  readonly served: () => void;
  readonly log: (message: string) => void;
};

export type ShellBuilds = ReturnType<typeof shellBuilds>;

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The build current.json names, if that build is still there. A file that is damaged names no build, as a missing one
 * does: the host then serves the repository's build until it builds its own.
 */
function servedBuild(
  builds: string,
  log: (message: string) => void
): string | undefined {
  const current = readKept(
    path.join(builds, "current.json"),
    currentJson,
    (problem) => {
      log(`studio: ${problem}`);
    }
  );

  return current && existsSync(path.join(builds, current.id, "index.html"))
    ? current.id
    : undefined;
}

export function shellBuilds(options: ShellBuildsOptions) {
  const { gateway, log } = options;
  const builds = path.join(options.dataDir, "builds");

  mkdirSync(builds, { recursive: true });

  let current = servedBuild(builds, log);

  /** An app as the shell shows it: its draft while it has one. None while its server code fails to start. */
  async function screen(id: string): Promise<ShellApp[]> {
    const which = gateway.draft(id) ? "draft" : "live";
    const app = which === "draft" ? gateway.draft(id) : gateway.live(id);

    if (!app) {
      return [];
    }

    try {
      const { operations } = await gateway.manifest(id, which);

      return [{ id, files: app.files, operations }];
    } catch (error) {
      // An app whose server code fails to start has no screen until it is fixed; the others still build.
      log(`studio: ${id} left out of the shell: ${why(error)}`);

      return [];
    }
  }

  /** The apps as the shell shows them. `override` stands in for one app. */
  async function shown(override?: ShellApp): Promise<ShellApp[]> {
    const others = gateway.apps().filter(({ id }) => id !== override?.id);

    const apps = await Promise.all(
      others.map(async ({ id }) => await screen(id))
    );

    return override ? [...apps.flat(), override] : apps.flat();
  }

  /** Builds the shell with these apps; answers the build's id, or throws what the compiler said. */
  async function build(apps: readonly ShellApp[]): Promise<string> {
    options.toolchain.require();

    const id = `b${Date.now().toString(36)}`;
    const started = Date.now();

    const result = await buildShell({
      clientDir: options.clientDir,
      exact: options.exact,
      workDir: path.join(options.dataDir, "shell"),
      outDir: path.join(builds, id),
      apps,
      version: id,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    log(
      `studio: built the shell ${id} with ${apps.map((a) => a.id).join(", ") || "no apps"} in ${Date.now() - started} ms`
    );

    return id;
  }

  /** Serves a build: open pages see a new build id and relaunch into it. */
  function serve(id: string) {
    current = id;
    writeFileSync(path.join(builds, "current.json"), JSON.stringify({ id }));

    const all = readdirSync(builds, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const name of all.slice(0, -KEPT_BUILDS)) {
      if (name !== id) {
        rmSync(path.join(builds, name), { recursive: true, force: true });
        rmSync(path.join(builds, `${name}.lock`), { force: true });
      }
    }

    options.served();
  }

  return {
    /** The build the host serves, undefined while it serves the repository's own. */
    current: () => current,
    /** Where that build is, undefined for the repository's. */
    dir: () => (current === undefined ? undefined : path.join(builds, current)),
    shown,
    build,
    serve,
    /** Builds the shell with the apps as they are now, and serves it. */
    rebuild: async () => {
      serve(await build(await shown()));
    },
  };
}
