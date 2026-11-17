// The programs the host runs beside itself, which it downloads the first time it needs them: OpenBao (the vault for
// the owner's secrets, secrets/vault.ts), mitmproxy (which puts them on the agent's requests, secrets/egress.ts) and
// the GitHub CLI (which Connect GitHub signs in with, connections/github.ts). The host runs each from where it put it,
// so none depends on the PATH a service manager starts the host with. Each is pinned to
// one release and checked against its SHA-256 before it is unpacked, so a host runs exactly these builds wherever it
// came from: a release, a checkout, or a test.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;

type Platform = (typeof PLATFORMS)[number];

/** Where a tool's archive is, its SHA-256, and the program's path inside it. */
type Build = {
  readonly url: string;
  readonly sha256: string;
  readonly path: string;
};

type Tool = {
  readonly version: string;
  readonly builds: Readonly<Record<Platform, Build>>;
};

const isPlatform = (name: string): name is Platform =>
  PLATFORMS.some((platform) => platform === name);

const bao = (arch: string, sha256: string): Build => ({
  url: `https://github.com/openbao/openbao/releases/download/v2.7.2/openbao_2.7.2_${arch}.tar.gz`,
  sha256,
  path: "bao",
});

const mitm = (arch: string, sha256: string, path = "mitmdump"): Build => ({
  url: `https://downloads.mitmproxy.org/12.3.1/mitmproxy-12.3.1-${arch}.tar.gz`,
  sha256,
  path,
});

// gh's macOS builds are zip files, which macOS's tar (bsdtar) unpacks as it does a tarball.
const gh = (build: string, sha256: string): Build => ({
  url: `https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_${build}`,
  sha256,
  path: `gh_2.104.0_${build.replace(/\.(tar\.gz|zip)$/, "")}/bin/gh`,
});

const APP_MITMDUMP = "mitmproxy.app/Contents/MacOS/mitmdump";

const TOOLS = {
  bao: {
    version: "2.7.2",
    builds: {
      "linux-x64": bao(
        "linux_amd64",
        "582b1f3c2fdc5afd443b2d57a225ef654de75adea609fdb66731fd582a9cbc96"
      ),
      "linux-arm64": bao(
        "linux_arm64",
        "5b97bf816fa820e5e521abec1db19c6161fcca2f666cf4a84e335089c0e83edd"
      ),
      "darwin-x64": bao(
        "darwin_amd64",
        "ea62ce00b81a2170a5daa8589f8420434e72d4d4ebcd2a4cbfa9add507a2602d"
      ),
      "darwin-arm64": bao(
        "darwin_arm64",
        "2b4fc131910f4b075b2e1c9a9de67c461489491a8f03fbdc73387294d67d9547"
      ),
    },
  },
  mitmdump: {
    version: "12.3.1",
    builds: {
      "linux-x64": mitm(
        "linux-x86_64",
        "f7b4237f5702f6cd21357fe6e4680a7e905f8f9b816b872230d018ea696c34d5"
      ),
      "linux-arm64": mitm(
        "linux-aarch64",
        "97a21d57b2288f7e293e63d3b11af34f394a8bbf760e6cf101ed1d57057a1f40"
      ),
      "darwin-x64": mitm(
        "macos-x86_64",
        "f4cf5e563e7068af297a27be97686f58917760d3c0dcc6a997ca83f6f5ffb3db",
        APP_MITMDUMP
      ),
      "darwin-arm64": mitm(
        "macos-arm64",
        "9b7f7a8e3fd1b1544089c937c579ef1f0f503f0ea598c25bda9eab077c735b93",
        APP_MITMDUMP
      ),
    },
  },
  gh: {
    version: "2.104.0",
    builds: {
      "linux-x64": gh(
        "linux_amd64.tar.gz",
        "98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e"
      ),
      "linux-arm64": gh(
        "linux_arm64.tar.gz",
        "cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3"
      ),
      "darwin-x64": gh(
        "macOS_amd64.zip",
        "a8c2a708dbae89dc7c05ba7b0beafc95bd8d09ab4a3505467b77d32ebf364dc6"
      ),
      "darwin-arm64": gh(
        "macOS_arm64.zip",
        "23b12706219b9892e44236f988444a24adcf29284e16b35e03ba5b863fb6eb8e"
      ),
    },
  },
} satisfies Record<string, Tool>;

export type ToolName = keyof typeof TOOLS;

/** A tool's folder -> its download, so two callers that need it at once share one. */
const downloads = new Map<string, Promise<string>>();

/** The path of `name`'s program under `dir`, downloading and unpacking it first if this version is not there yet. */
export async function tool(dir: string, name: ToolName): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const { version, builds } = TOOLS[name];

  if (!isPlatform(platform)) {
    throw new Error(`Imp has no ${name} for ${platform}.`);
  }

  const build = builds[platform];
  const home = path.join(dir, `${name}-${version}`);
  const program = path.join(home, build.path);

  if (existsSync(program)) {
    return program;
  }

  const fetched = async () => {
    try {
      await install(home, build);

      return program;
    } catch (cause) {
      // The next caller tries again.
      downloads.delete(home);

      throw new Error(
        `Could not get ${name} ${version}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      );
    }
  };

  const pending = downloads.get(home) ?? fetched();

  downloads.set(home, pending);

  return await pending;
}

async function install(home: string, build: Build) {
  const response = await fetch(build.url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!response.ok) {
    throw new Error(`${build.url} answered ${response.status}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");

  if (digest !== build.sha256) {
    throw new Error(
      `${build.url} is not the build Imp pins (SHA-256 ${digest})`
    );
  }

  // Unpacked beside its final place and renamed into it, so a half-unpacked tool is never taken for a whole one. Each
  // download stages in a folder of its own: another host process may be fetching the same tool into the same folder.
  const staging = `${home}.partial-${randomUUID()}`;

  mkdirSync(staging, { recursive: true });
  const file = path.join(staging, "archive");

  try {
    writeFileSync(file, archive);
    await unpack(file, staging);
    rmSync(file);
    settle(staging, home, path.join(home, build.path));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Moves an unpacked tool into its place, unless another process put the same tool there first. */
function settle(staging: string, home: string, program: string) {
  try {
    renameSync(staging, home);
  } catch (cause) {
    if (!existsSync(program)) {
      throw cause;
    }
  }
}

async function unpack(archive: string, into: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xzf", archive, "-C", into], (error) => {
      if (error) {
        // Node's own description of the failure, which names the command and carries what it printed.
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve();
      }
    });
  });
}
