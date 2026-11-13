// The host keeps itself at the repository's latest GitHub release. An installed host (scripts/install-host.sh) runs
// from IMP_HOME/current, a link to one unpacked release under IMP_HOME/releases. Every interval it asks GitHub for the
// latest release; a newer one is downloaded, its digest checked, unpacked beside the running one and linked as
// current. Once the agent is idle the host restarts, and the service manager starts it again from the new release.
// The web client is built into the release, so the same restart updates it, and open pages reload (host.ts).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface UpdaterOptions {
  /** IMP_HOME: holds releases/ and the current link. */
  readonly home: string;
  /** The GitHub repository releases come from, such as "peelar/imp". */
  readonly repo: string;
  /** The running release's tag. */
  readonly version: string;
  readonly intervalMs: number;
  /** Whether the agent is between turns, so a restart interrupts nothing. */
  readonly idle: () => Promise<boolean>;
  /** Closes the host; the process then exits and the service manager starts the new release. */
  readonly restart: () => Promise<void>;
}

/** The asset every release carries for the host: the host, its production dependencies and the built web client. */
export const hostAsset = (tag: string) => `imp-host-${tag}.tar.gz`;

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Whether release tag `a` is newer than `b`. A tag that is not vX.Y.Z is never newer. */
export function newer(a: string, b: string): boolean {
  const x = TAG.exec(a)?.slice(1).map(Number);
  const y = TAG.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
  if (!x) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

interface Release {
  readonly tag_name: string;
  readonly assets: readonly {
    readonly name: string;
    readonly browser_download_url: string;
    readonly digest?: string | null;
  }[];
}

export function startUpdater(options: UpdaterOptions) {
  const releases = join(options.home, "releases");
  let staged: string | undefined;
  let busy = false;
  const log = (line: string) => console.log(`update: ${line}`);

  async function latest(): Promise<Release> {
    const response = await fetch(
      `https://api.github.com/repos/${options.repo}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "imp-host",
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok)
      throw new Error(
        `GitHub answered ${response.status} for the latest release`
      );
    return (await response.json()) as Release;
  }

  /** Downloads and unpacks a newer release and links it as current; returns its tag, or undefined when up to date. */
  async function stage(): Promise<string | undefined> {
    const release = await latest();
    const tag = release.tag_name;
    if (!newer(tag, options.version)) return undefined;
    const asset = release.assets.find((a) => a.name === hostAsset(tag));
    if (!asset) throw new Error(`release ${tag} has no ${hostAsset(tag)}`);
    const response = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for ${asset.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // GitHub records each asset's SHA-256 when it is uploaded: a download cut short or altered on the way is refused.
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (asset.digest && asset.digest !== digest)
      throw new Error(
        `${asset.name} is ${digest}, but GitHub lists ${asset.digest}`
      );

    mkdirSync(releases, { recursive: true });
    const target = join(releases, tag);
    const partial = join(releases, `.${tag}.partial`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial);
    const archive = join(releases, `.${tag}.tar.gz`);
    writeFileSync(archive, bytes);
    try {
      execFileSync("tar", ["-xzf", archive, "-C", partial]);
    } finally {
      rmSync(archive, { force: true });
    }
    const unpacked = readFileSync(join(partial, "VERSION"), "utf8").trim();
    if (unpacked !== tag)
      throw new Error(`${asset.name} says it is ${unpacked}`);
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);

    // The link is replaced in one rename, so a restart at any moment starts one whole release.
    const link = join(options.home, "current");
    rmSync(`${link}.next`, { force: true });
    symlinkSync(join("releases", tag), `${link}.next`);
    renameSync(`${link}.next`, link);
    // Keep the running release, for going back by hand, and the new one.
    for (const name of readdirSync(releases)) {
      if (name !== tag && name !== options.version)
        rmSync(join(releases, name), { recursive: true, force: true });
    }
    return tag;
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      if (!staged) {
        staged = await stage();
        if (staged)
          log(`${staged} is ready; restarting once the agent is idle`);
      }
      if (staged && (await options.idle())) {
        log(`restarting from ${options.version} into ${staged}`);
        await options.restart();
      }
    } catch (error) {
      log(`${error instanceof Error ? error.message : error}`);
    } finally {
      busy = false;
    }
  }

  log(
    `${options.version}, checking ${options.repo} every ${Math.round(options.intervalMs / 60_000)} min`
  );
  const first = setTimeout(check, 10_000);
  // Once a release is staged, the host looks every half minute for an idle moment to restart.
  const timer = setInterval(() => (staged ? check() : undefined), 30_000);
  const poll = setInterval(check, options.intervalMs);
  return {
    check,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(poll);
    },
  };
}

/** The running release's tag: the VERSION file a release carries, "dev" in a checkout. */
export function runningVersion(root: string): string {
  const file = join(root, "VERSION");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "dev";
}
