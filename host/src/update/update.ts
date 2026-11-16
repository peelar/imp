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
import path from "node:path";
import {
  arr,
  compile,
  nullable,
  obj,
  opt,
  type Static,
  str,
} from "@earendil-works/pi-schema";

export type UpdaterOptions = {
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
};

/** The asset every release carries for the host: the host, its production dependencies and the built web client. */
const hostAsset = (tag: string) => `imp-host-${tag}.tar.gz`;

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const numbers = (tag: string) => TAG.exec(tag)?.slice(1).map(Number);

/** Whether release tag `a` is newer than `b`. A tag that is not vX.Y.Z is never newer. */
function newer(a: string, b: string): boolean {
  const x = numbers(a);
  const y = numbers(b) ?? [0, 0, 0];

  if (!x) {
    return false;
  }

  for (const [i, part] of x.entries()) {
    const other = y[i] ?? 0;

    if (part !== other) {
      return part > other;
    }
  }

  return false;
}

/**
 * What the updater reads of GitHub's answer for a release. GitHub sends much more, so the objects are open; an asset
 * uploaded before GitHub recorded digests has none, or null.
 */
const releaseAsset = obj(
  {
    name: str(),
    browser_download_url: str(),
    digest: opt(nullable(str())),
  },
  { open: true }
);

const release = compile(
  obj({ tag_name: str(), assets: arr(releaseAsset) }, { open: true })
);

type Asset = Static<typeof releaseAsset>;

type Staging = Pick<UpdaterOptions, "home" | "repo" | "version">;

export function startUpdater(options: UpdaterOptions) {
  let staged: string | undefined;
  let busy = false;

  const log = (line: string) => {
    console.log(`update: ${line}`);
  };

  const report = (cause: unknown) => {
    log(cause instanceof Error ? cause.message : String(cause));
  };

  /** Stages a newer release when there is one, and restarts into a staged one once the agent is idle. */
  async function update() {
    if (busy) {
      return;
    }

    busy = true;

    try {
      if (!staged) {
        staged = await stage(options);

        if (staged) {
          log(`${staged} is ready; restarting once the agent is idle`);
        }
      }

      if (staged && (await options.idle())) {
        log(`restarting from ${options.version} into ${staged}`);
        await options.restart();
      }
    } finally {
      busy = false;
    }
  }

  /** One round of the updater. A failure is logged, and the next round tries again. */
  const check = async () => {
    try {
      await update();
    } catch (error) {
      report(error);
    }
  };

  // A timer does not wait for its callback, so each round reports its own failure.
  const round = () => {
    update().catch(report);
  };

  log(
    `${options.version}, checking ${options.repo} every ${Math.round(options.intervalMs / 60_000)} min`
  );

  const first = setTimeout(round, 10_000);

  // Once a release is staged, the host looks every half minute for an idle moment to restart.
  const timer = setInterval(() => {
    if (staged) {
      round();
    }
  }, 30_000);

  const poll = setInterval(round, options.intervalMs);

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
  const file = path.join(root, "VERSION");

  return existsSync(file) ? readFileSync(file, "utf-8").trim() : "dev";
}

/** The repository's latest release, as GitHub lists it. An answer that is not a release fails like a refused request. */
async function latest(repo: string) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "imp-host",
      },
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} for the latest release`
    );
  }

  const answer = release.validate(await response.json());

  if (!answer.ok) {
    const problems = answer.errors.map(
      (error) => `${error.path || "the answer"}: ${error.message}`
    );

    throw new Error(
      `GitHub's answer for the latest release is not a release: ${problems.join("; ")}`
    );
  }

  return answer.value;
}

/** Downloads and unpacks a newer release and links it as current; returns its tag, or undefined when up to date. */
async function stage(options: Staging): Promise<string | undefined> {
  const { tag_name: tag, assets } = await latest(options.repo);

  if (!newer(tag, options.version)) {
    return undefined;
  }

  const asset = assets.find((a) => a.name === hostAsset(tag));

  if (!asset) {
    throw new Error(`release ${tag} has no ${hostAsset(tag)}`);
  }

  const releases = path.join(options.home, "releases");

  unpack({ releases, tag, name: asset.name, bytes: await download(asset) });

  // The link is replaced in one rename, so a restart at any moment starts one whole release.
  const link = path.join(options.home, "current");

  rmSync(`${link}.next`, { force: true });
  symlinkSync(path.join("releases", tag), `${link}.next`);
  renameSync(`${link}.next`, link);

  // Keep the running release, for going back by hand, and the new one.
  for (const name of readdirSync(releases)) {
    if (name !== tag && name !== options.version) {
      rmSync(path.join(releases, name), { recursive: true, force: true });
    }
  }

  return tag;
}

/** The asset's bytes, refused when they are not the ones GitHub lists. */
async function download(asset: Asset): Promise<Buffer> {
  const response = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${asset.name}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  // GitHub records each asset's SHA-256 when it is uploaded: a download cut short or altered on the way is refused.
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  if (asset.digest && asset.digest !== digest) {
    throw new Error(
      `${asset.name} is ${digest}, but GitHub lists ${asset.digest}`
    );
  }

  return bytes;
}

/** Unpacks a downloaded release as releases/<tag>, through a partial folder, so a release is there whole or not at all. */
function unpack(download: {
  readonly releases: string;
  readonly tag: string;
  /** The asset's name, for the error. */
  readonly name: string;
  readonly bytes: Buffer;
}) {
  const { releases, tag } = download;

  mkdirSync(releases, { recursive: true });

  const target = path.join(releases, tag);
  const partial = path.join(releases, `.${tag}.partial`);

  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial);

  const archive = path.join(releases, `.${tag}.tar.gz`);

  writeFileSync(archive, download.bytes);

  try {
    execFileSync("tar", ["-xzf", archive, "-C", partial]);
  } finally {
    rmSync(archive, { force: true });
  }

  const unpacked = readFileSync(path.join(partial, "VERSION"), "utf-8").trim();

  if (unpacked !== tag) {
    throw new Error(`${download.name} says it is ${unpacked}`);
  }

  rmSync(target, { recursive: true, force: true });
  renameSync(partial, target);
}
