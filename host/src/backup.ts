// A copy of the apps' code away from the host's own folders. Every save and undo commits the live apps' code to a git
// repository in DATA_DIR/backup, a folder per app, so every version is kept for good (Undo's history, which also holds
// the data, lasts 48 hours). Connected in Settings, the host also pushes each commit to a private GitHub repository of
// the person's, imp-apps. It signs in with the GitHub CLI's device code flow, as the ChatGPT sign-in does (signin.ts),
// and keeps that sign-in in DATA_DIR/gh beside the host's other credentials. Only code is backed up: the apps' data
// stays on the host.
//
// The host needs git for the history and the GitHub CLI (gh) for GitHub; Settings says which one is missing.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_FILES, type AppInfo } from "./apps.ts";
import type { Topics } from "./live.ts";

export const TOPIC = "backup";
/** The repository the apps go to, under the person's GitHub account. */
const REPO_NAME = "imp-apps";

export interface Backup {
	/** Whether the host has git, which keeps the versions. */
	git: boolean;
	/** GitHub: "off", "starting", "waiting" (for the person to enter `code` at `url`) or "on" (pushing to `repo`). */
	status: string;
	code: string;
	url: string;
	/** "owner/imp-apps" while on. */
	repo: string;
	/** Why connecting or the last push failed; "" when neither did. */
	error: string;
	/** How many versions the history keeps. */
	versions: number;
	/** Whether GitHub has the newest one. */
	synced: boolean;
}

export interface BackupOptions {
	readonly dataDir: string;
	readonly topics: Topics;
	/** The live apps, whose code is backed up. */
	readonly apps: () => readonly AppInfo[];
	/** The GitHub CLI to run. Default: gh on PATH. */
	readonly gh?: string;
	readonly log?: (message: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function appBackup(options: BackupOptions) {
	const log = options.log ?? ((line) => console.error(line));
	const dir = join(options.dataDir, "backup");
	const ghDir = join(options.dataDir, "gh");
	const remoteFile = join(options.dataDir, "backup.json");
	const gh = options.gh ?? "gh";
	// The host's own GitHub sign-in, never a token from its environment; no browser opens on the host.
	const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: ghDir, BROWSER: "true", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" };
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];

	let remote = existsSync(remoteFile) ? (JSON.parse(readFileSync(remoteFile, "utf8")) as { repo: string; url: string }) : undefined;
	let state: Backup = { git: false, status: remote ? "on" : "off", code: "", url: "", repo: remote?.repo ?? "", error: "", versions: 0, synced: false };
	const set = (next: Partial<Backup>) => {
		state = { ...state, ...next };
		options.topics.changed(TOPIC);
	};

	const run = (command: string, args: readonly string[], cwd?: string) =>
		new Promise<string>((resolve, reject) => {
			execFile(command, args, { cwd, env, timeout: 120_000 }, (error, stdout, stderr) => {
				if (!error) return resolve(String(stdout).trim());
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`${command} is not installed on the host.`));
				reject(new Error(String(stderr).trim() || error.message));
			});
		});
	// Git as the host uses it, whatever the machine's own git settings say. Pushes sign in through the host's gh.
	const git = (...args: string[]) =>
		run(
			"git",
			[
				"-c", "user.name=Imp",
				"-c", "user.email=imp@localhost",
				"-c", "commit.gpgsign=false",
				"-c", "core.hooksPath=/dev/null",
				"-c", "credential.helper=",
				"-c", `credential.helper=!'${gh}' auth git-credential`,
				...args,
			],
			dir,
		);

	// One change at a time: commits and pushes.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => undefined);
		return next;
	};

	const count = async () => Number(await git("rev-list", "--count", "HEAD").catch(() => "0"));

	const ready = serial(async () => {
		try {
			await run("git", ["--version"]);
			mkdirSync(dir, { recursive: true });
			if (!existsSync(join(dir, ".git"))) await git("init", "--quiet", "--initial-branch=main");
			set({ git: true, versions: await count() });
			return true;
		} catch (error) {
			log(`backup: no history of the apps' versions: ${message(error)}`);
			return false;
		}
	});

	/** Commits the live apps as they are now, when that differs from the last version. */
	async function commit(summary: string) {
		for (const entry of readdirSync(dir)) if (entry !== ".git") rmSync(join(dir, entry), { recursive: true, force: true });
		for (const app of options.apps()) {
			mkdirSync(join(dir, app.id));
			for (const name of APP_FILES) writeFileSync(join(dir, app.id, name), app.files[name]);
		}
		await git("add", "--all");
		if (!(await git("status", "--porcelain"))) return;
		await git("commit", "--quiet", "--message", summary);
		set({ versions: await count(), synced: false });
	}

	async function push() {
		if (!remote || state.versions === 0) return;
		try {
			await git("push", "--quiet", remote.url, "HEAD:refs/heads/main");
			set({ synced: true, error: "" });
		} catch (error) {
			set({ synced: false, error: `Could not back up to ${remote.repo}: ${message(error)}` });
		}
	}

	/** Keeps the apps' code as it is now, and pushes it. */
	function record(summary: string) {
		serial(async () => {
			if (!(await ready)) return;
			await commit(summary);
			await push();
		}).catch((error) => log(`backup: ${message(error)}`));
	}

	/** After the sign-in: the person's imp-apps repository, made private if it is not there yet. */
	async function finish() {
		const owner = await run(gh, ["api", "user", "--jq", ".login"]);
		const repo = `${owner}/${REPO_NAME}`;
		const view = () => run(gh, ["repo", "view", repo, "--json", "url", "--jq", ".url"]);
		const url = await view().catch(async () => {
			await run(gh, ["repo", "create", repo, "--private", "--description", "My Imp apps' code, backed up by my Imp host."]);
			return view();
		});
		remote = { repo, url };
		writeFileSync(remoteFile, JSON.stringify(remote));
		set({ status: "on", repo, code: "", url: "", error: "" });
		if (await ready) await push();
	}

	let login: ChildProcess | undefined;
	const stopLogin = () => {
		const child = login;
		login = undefined;
		child?.kill();
	};

	return {
		state: () => state,
		record,
		/** Keeps the apps as the host starts with them, and pushes what GitHub does not have yet. */
		start: () => record("Keep the apps as the host started with them"),

		/** GitHub's device code sign-in: the code shows in Settings, and the person approves on any device. */
		connect() {
			if (state.status !== "off") return;
			mkdirSync(ghDir, { recursive: true, mode: 0o700 });
			set({ status: "starting", code: "", url: "", error: "" });
			// --insecure-storage keeps the token in DATA_DIR/gh, as the ChatGPT one is in DATA_DIR, not in a keychain
			// that a background service may not reach.
			const child = spawn(
				gh,
				["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key", "--insecure-storage"],
				{ env, stdio: ["ignore", "pipe", "pipe"] },
			);
			login = child;
			let output = "";
			const read = (chunk: Buffer) => {
				output += chunk.toString("utf8");
				const code = output.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
				const url = output.match(/https:\/\/\S+\/login\/device/)?.[0];
				if (code && url && login === child && state.status === "starting") set({ status: "waiting", code, url });
			};
			child.stdout.on("data", read);
			child.stderr.on("data", read);
			const fail = (error: string) => set({ status: "off", code: "", url: "", error });
			child.on("error", (error) => {
				if (login !== child) return;
				login = undefined;
				fail((error as NodeJS.ErrnoException).code === "ENOENT" ? "The host needs the GitHub CLI: install gh (cli.github.com) on it, then connect again." : error.message);
			});
			child.on("close", (exit) => {
				if (login !== child) return;
				login = undefined;
				if (exit !== 0) return fail(output.trim().split("\n").at(-1) || `GitHub's sign-in stopped (${exit}).`);
				serial(finish).catch((error) => fail(`Signed in to GitHub, but ${message(error)}`));
			});
		},

		cancel() {
			stopLogin();
			if (state.status !== "on") set({ status: "off", code: "", url: "", error: "" });
		},

		/** Stops pushing and signs the host out of GitHub. The repository on GitHub stays. */
		async disconnect() {
			stopLogin();
			await run(gh, ["auth", "logout", "--hostname", "github.com"]).catch(() => undefined);
			rmSync(ghDir, { recursive: true, force: true });
			rmSync(remoteFile, { force: true });
			remote = undefined;
			set({ status: "off", code: "", url: "", repo: "", error: "", synced: false });
		},

		close: stopLogin,
	};
}
