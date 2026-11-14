// The programs the host runs beside itself, which it downloads the first time it needs them: OpenBao (the vault for
// the owner's secrets, vault.ts) and mitmproxy (which puts them on the agent's requests, egress.ts). Each is pinned to
// one release and checked against its SHA-256 before it is unpacked, so a host runs exactly these builds wherever it
// came from: a release, a checkout, or a test.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

type Platform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

interface Tool {
	readonly version: string;
	/** Per platform: where the archive is, its SHA-256, and the program's path inside it. */
	readonly builds: Readonly<Record<Platform, { url: string; sha256: string; path: string }>>;
}

const bao = (arch: string, sha256: string) => ({
	url: `https://github.com/openbao/openbao/releases/download/v2.7.2/openbao_2.7.2_${arch}.tar.gz`,
	sha256,
	path: "bao",
});
const mitm = (arch: string, sha256: string, path = "mitmdump") => ({
	url: `https://downloads.mitmproxy.org/12.3.1/mitmproxy-12.3.1-${arch}.tar.gz`,
	sha256,
	path,
});
const APP_MITMDUMP = "mitmproxy.app/Contents/MacOS/mitmdump";

export const TOOLS = {
	bao: {
		version: "2.7.2",
		builds: {
			"linux-x64": bao("linux_amd64", "582b1f3c2fdc5afd443b2d57a225ef654de75adea609fdb66731fd582a9cbc96"),
			"linux-arm64": bao("linux_arm64", "5b97bf816fa820e5e521abec1db19c6161fcca2f666cf4a84e335089c0e83edd"),
			"darwin-x64": bao("darwin_amd64", "ea62ce00b81a2170a5daa8589f8420434e72d4d4ebcd2a4cbfa9add507a2602d"),
			"darwin-arm64": bao("darwin_arm64", "2b4fc131910f4b075b2e1c9a9de67c461489491a8f03fbdc73387294d67d9547"),
		},
	},
	mitmdump: {
		version: "12.3.1",
		builds: {
			"linux-x64": mitm("linux-x86_64", "f7b4237f5702f6cd21357fe6e4680a7e905f8f9b816b872230d018ea696c34d5"),
			"linux-arm64": mitm("linux-aarch64", "97a21d57b2288f7e293e63d3b11af34f394a8bbf760e6cf101ed1d57057a1f40"),
			"darwin-x64": mitm("macos-x86_64", "f4cf5e563e7068af297a27be97686f58917760d3c0dcc6a997ca83f6f5ffb3db", APP_MITMDUMP),
			"darwin-arm64": mitm("macos-arm64", "9b7f7a8e3fd1b1544089c937c579ef1f0f503f0ea598c25bda9eab077c735b93", APP_MITMDUMP),
		},
	},
} satisfies Record<string, Tool>;

export type ToolName = keyof typeof TOOLS;

const downloads = new Map<string, Promise<string>>();

/** The path of `name`'s program under `dir`, downloading and unpacking it first if this version is not there yet. */
export function tool(dir: string, name: ToolName): Promise<string> {
	const platform = `${process.platform}-${process.arch}`;
	const { version, builds } = TOOLS[name];
	const build = builds[platform as Platform];
	if (!build) return Promise.reject(new Error(`Imp has no ${name} for ${platform}.`));
	const home = join(dir, `${name}-${version}`);
	const program = join(home, build.path);
	if (existsSync(program)) return Promise.resolve(program);
	let pending = downloads.get(home);
	if (!pending) {
		pending = install(home, build).then(
			() => program,
			(error: unknown) => {
				downloads.delete(home);
				throw new Error(`Could not get ${name} ${version}: ${error instanceof Error ? error.message : error}`);
			},
		);
		downloads.set(home, pending);
	}
	return pending;
}

async function install(home: string, build: { url: string; sha256: string }) {
	const response = await fetch(build.url, { signal: AbortSignal.timeout(10 * 60_000) });
	if (!response.ok) throw new Error(`${build.url} answered ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== build.sha256) throw new Error(`${build.url} is not the build Imp pins (SHA-256 ${digest})`);
	// Unpacked beside its final place and renamed into it, so a half-unpacked tool is never taken for a whole one.
	const staging = `${home}.partial`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const file = join(staging, "archive.tar.gz");
	writeFileSync(file, archive);
	await promisify(execFile)("tar", ["-xzf", file, "-C", staging]);
	rmSync(file);
	rmSync(home, { recursive: true, force: true });
	renameSync(staging, home);
}
