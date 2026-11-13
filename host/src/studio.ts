// Where apps are made. The agent writes an app's folder in its own workspace and asks for a preview; the studio
// takes the folder from the machine (nothing else crosses over), tries its server code on a copy of the data, builds
// the shell with its screen, and only then makes it the app's draft, which the shell shows in the app's tab with Save
// and Discard. Only the person saves: Save makes the draft live and keeps the version before it, which Undo restores
// for 48 hours.
//
// On disk, under DATA_DIR:
//   code/<id>/live/                 the live version of an app the agent made or changed (else client/apps/<id>/)
//   code/<id>/draft/                the draft being previewed
//   code/<id>/history/<ms>/         a saved-over version: code/ (none when the save made the app), data.sqlite,
//                                   meta.json ({ schema: how many migrations that data had })
//   builds/<build id>/              the web builds; builds/current.json names the one the host serves
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Registry, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { RemoteExecutionEnv } from "@earendil-works/pi-env";
import {
	APP_FILES,
	APP_ID,
	type AppFiles,
	type AppGateway,
	type AppInfo,
	appInfo,
	checkSlot,
	draftSlot,
	readAppFiles,
	readApps,
} from "./apps.ts";
import type { Topics } from "./live.ts";
import { buildShell, type ShellApp } from "./shell.ts";

export const APPS_TOPIC = "apps";
export const BUILD_TOPIC = "build";
const HISTORY_MS = 48 * 3600_000;
const KEPT_BUILDS = 3;
const STUDIO_FILES = join(import.meta.dirname, "..", "studio");
const SDK = join(import.meta.dirname, "..", "..", "sdk", "app.ts");

const writeApp = (dir: string, files: AppFiles) => {
	mkdirSync(dir, { recursive: true });
	for (const name of APP_FILES) writeFileSync(join(dir, name), files[name]);
};

/** The apps the host starts with: each stored live version over the repository's, and the drafts. */
export function storedApps(dataDir: string, repoAppsDir: string, log: (message: string) => void) {
	const live = new Map(readApps(repoAppsDir).map((app) => [app.id, app]));
	const drafts: AppInfo[] = [];
	const code = join(dataDir, "code");
	for (const id of existsSync(code) ? readdirSync(code) : []) {
		for (const [kind, list] of [["live", undefined], ["draft", drafts]] as const) {
			const dir = join(code, id, kind);
			if (!existsSync(dir)) continue;
			try {
				const app = appInfo(readAppFiles(dir), id);
				if (list) list.push(app);
				else live.set(id, app);
			} catch (error) {
				log(`studio: skipped ${dir}: ${error instanceof Error ? error.message : error}`);
			}
		}
	}
	return { live: [...live.values()], drafts };
}

export interface StudioOptions {
	readonly dataDir: string;
	/** The repository's apps (client/apps). */
	readonly repoAppsDir: string;
	/** The shell's source (client/). */
	readonly clientDir: string;
	/** The Exact checkout the shell builds with. */
	readonly exact: string;
	readonly gateway: AppGateway;
	readonly topics: Topics;
	readonly registry: Registry;
	/** The agent's files, and where it works on them: the current computer's, which the owner may switch. */
	readonly files: () => RemoteExecutionEnv;
	readonly workspace: () => string;
	readonly context: Context;
	readonly drafts: readonly AppInfo[];
	readonly log?: (message: string) => void;
}

export function studio(options: StudioOptions) {
	const { gateway, topics, context } = options;
	const log = options.log ?? ((message) => console.log(message));
	const code = (id: string, ...rest: string[]) => join(options.dataDir, "code", id, ...rest);
	const builds = join(options.dataDir, "builds");
	mkdirSync(builds, { recursive: true });
	const currentFile = join(builds, "current.json");
	let current: string | undefined = existsSync(currentFile) ? (JSON.parse(readFileSync(currentFile, "utf8")) as { id: string }).id : undefined;
	if (current && !existsSync(join(builds, current, "index.html"))) current = undefined;

	// One change at a time: previews, saves, discards and undos each build the shell and swap versions.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const run = queue.then(work, work);
		queue = run.catch(() => undefined);
		return run;
	};

	// ---- History ----

	const historyOf = (id: string) => {
		const dir = code(id, "history");
		return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b)) : [];
	};
	const latest = (id: string) => {
		const entry = historyOf(id).at(-1);
		if (!entry) return undefined;
		const dir = code(id, "history", entry);
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { schema: number };
		return { dir, schema: meta.schema, code: existsSync(join(dir, "code")) ? join(dir, "code") : undefined };
	};
	/** Keeps every saved-over version for 48 hours, and the newest one longer. */
	const prune = (id: string) => {
		const entries = historyOf(id);
		for (const entry of entries.slice(0, -1)) {
			if (Date.now() - Number(entry) > HISTORY_MS) rmSync(code(id, "history", entry), { recursive: true, force: true });
		}
	};
	/** What undoing the app's last save does, for the shell's button: see AppTile in client/app.contract. */
	const undoKind = (id: string) => {
		if (gateway.version(draftSlot(id))) return "";
		const entry = latest(id);
		if (!entry) return "";
		if (!entry.code) return "remove";
		return entry.schema === gateway.schemaVersion(id) ? "keep" : "data";
	};

	// ---- Builds ----

	/** The apps as the shell shows them: each one's draft while it has one. `override` stands in for one app. */
	async function shown(override?: ShellApp): Promise<ShellApp[]> {
		const apps: ShellApp[] = [];
		for (const { id } of gateway.apps()) {
			if (id === override?.id) continue;
			const slot = gateway.version(draftSlot(id)) ? draftSlot(id) : id;
			const app = gateway.version(slot)!;
			try {
				apps.push({ id, files: app.files, operations: (await gateway.manifest(slot)).operations });
			} catch (error) {
				// An app whose server code fails to start has no screen until it is fixed; the others still build.
				log(`studio: ${id} left out of the shell: ${error instanceof Error ? error.message : error}`);
			}
		}
		return override ? [...apps, override] : apps;
	}

	/** Builds the shell with these apps; answers the build's id, or throws what the compiler said. */
	async function build(apps: readonly ShellApp[]): Promise<string> {
		const id = `b${Date.now().toString(36)}`;
		const started = Date.now();
		const result = await buildShell({
			clientDir: options.clientDir,
			exact: options.exact,
			workDir: join(options.dataDir, "shell"),
			outDir: join(builds, id),
			apps,
			version: id,
		});
		if (!result.ok) throw new Error(result.error);
		log(`studio: built the shell ${id} with ${apps.map((a) => a.id).join(", ") || "no apps"} in ${Date.now() - started} ms`);
		return id;
	}

	/** Serves a build: open pages see a new build id and relaunch into it. */
	function serve(id: string) {
		current = id;
		writeFileSync(currentFile, JSON.stringify({ id }));
		const all = readdirSync(builds, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		for (const name of all.slice(0, -KEPT_BUILDS)) {
			if (name === id) continue;
			rmSync(join(builds, name), { recursive: true, force: true });
			rmSync(join(builds, `${name}.lock`), { force: true });
		}
		topics.changed(BUILD_TOPIC);
	}

	const rebuild = async () => serve(await build(await shown()));

	// ---- The agent's work ----

	/** Reads `apps/<id>/` from the agent's workspace. */
	async function fromWorkspace(id: string): Promise<AppFiles> {
		const files: Record<string, string> = {};
		for (const name of APP_FILES) {
			const path = `${options.workspace()}/apps/${id}/${name}`;
			const read = await options.files().readTextFile(path, context);
			if (!read.ok) throw new Error(`Could not read apps/${id}/${name} in your workspace: ${read.error.message}`);
			files[name] = read.value;
		}
		return files as unknown as AppFiles;
	}

	async function writeWorkspace(path: string, content: string) {
		const env = options.files();
		const dir = path.slice(0, path.lastIndexOf("/"));
		const made = await env.createDir(dir, { recursive: true }, context);
		if (!made.ok) throw new Error(`Could not make ${dir}: ${made.error.message}`);
		const written = await env.writeFile(path, content, context);
		if (!written.ok) throw new Error(`Could not write ${path}: ${written.error.message}`);
	}

	const starter = (id: string): AppFiles => {
		const name = id[0]!.toUpperCase() + id.slice(1);
		const files = readAppFiles(join(STUDIO_FILES, "starter"));
		return { ...files, "app.json": files["app.json"].replaceAll("{{id}}", id).replaceAll("{{name}}", name) };
	};

	/** Writes an app's current code (its draft, else its live version, else a starter) into the agent's workspace. */
	async function appCode(id: string) {
		if (!APP_ID.test(id)) throw new Error(`An app's id is lowercase letters and digits, such as "calendar"; "${id}" is not.`);
		const draft = gateway.version(draftSlot(id));
		const live = gateway.version(id);
		const files = draft?.files ?? live?.files ?? starter(id);
		const base = `${options.workspace()}/apps`;
		for (const name of APP_FILES) await writeWorkspace(`${base}/${id}/${name}`, files[name]);
		await writeWorkspace(`${base}/GUIDE.md`, readFileSync(join(STUDIO_FILES, "GUIDE.md"), "utf8"));
		await writeWorkspace(`${base}/sdk.ts`, readFileSync(SDK, "utf8"));
		for (const doc of ["start-here.md", "contract-for-agents.md"]) {
			const path = join(options.exact, "docs", doc);
			if (existsSync(path)) await writeWorkspace(`${base}/docs/${doc}`, readFileSync(path, "utf8"));
		}
		const what = draft ? "the draft the user is previewing" : live ? "the saved version" : "a starter app (a list of notes) to change into what the user asked for";
		return `Wrote ${base}/${id}/ (${what}). Read ${base}/GUIDE.md before you change it; call preview_app("${id}") when it is ready.`;
	}

	/** Checks the workspace's version of an app and makes it the app's draft, shown in its tab. */
	async function preview(id: string) {
		if (!APP_ID.test(id)) throw new Error(`An app's id is lowercase letters and digits, such as "calendar"; "${id}" is not.`);
		const app = appInfo(await fromWorkspace(id), id);
		const draft = draftSlot(id);
		const previous = gateway.version(draft) ? await gateway.manifest(draft).catch(() => undefined) : undefined;

		// The server code, on a copy of the data the draft will run on: the draft's own while its migrations still lead
		// to the new ones, so test entries survive a change that keeps the data's structure; else the live data.
		const check = checkSlot(id);
		const scratch = join(options.dataDir, "apps", `${check}.copy`);
		const manifestFor = async (base: string) => {
			gateway.uninstall(check);
			gateway.copyDataTo(base, scratch);
			gateway.replaceData(check, scratch);
			rmSync(scratch, { force: true });
			try {
				return await gateway.install(check, app);
			} finally {
				gateway.uninstall(check);
				gateway.removeData(check);
			}
		};
		let manifest = await manifestFor(id);
		// Migrations are kept in order and never changed once the user's data has had them.
		const saved = gateway.version(id) ? await gateway.manifest(id).catch(() => undefined) : undefined;
		const changed = saved?.schema.findIndex((sql, i) => manifest.schema[i] !== sql) ?? -1;
		if (saved && changed >= 0) {
			throw new Error(`Migration ${changed + 1} in server.ts differs from the one the user's data already has (${JSON.stringify(saved.schema[changed])}). Keep the saved migrations as they are and add a new one at the end.`);
		}
		const keepDraftData = previous !== undefined && previous.schema.every((sql, i) => manifest.schema[i] === sql);
		if (keepDraftData) manifest = await manifestFor(draft);

		// The shell, with this version's screen.
		const built = await build(await shown({ id, files: app.files, operations: manifest.operations }));

		// All good: this is the draft now.
		if (!keepDraftData) {
			gateway.uninstall(draft);
			gateway.copyDataTo(id, scratch);
			gateway.replaceData(draft, scratch);
			rmSync(scratch, { force: true });
		}
		rmSync(code(id, "draft"), { recursive: true, force: true });
		writeApp(code(id, "draft"), app.files);
		await gateway.install(draft, app);
		serve(built);
		topics.changed(APPS_TOPIC);
		const data = gateway.version(id) ? "a copy of the user's data" : "empty data (the app is new)";
		return `The preview is ready: the user sees ${app.name} in its tab, on ${data}, with Save and Discard. Tell them what to try; only they can save.`;
	}

	// ---- The person's decisions ----

	async function save(id: string) {
		const draft = gateway.version(draftSlot(id));
		if (!draft) throw new Error(`The ${id} app has no preview to save.`);
		const live = gateway.version(id);
		const entry = code(id, "history", String(Date.now()));
		mkdirSync(entry, { recursive: true });
		if (live) {
			writeApp(join(entry, "code"), live.files);
			gateway.copyDataTo(id, join(entry, "data.sqlite"));
		}
		writeFileSync(join(entry, "meta.json"), JSON.stringify({ schema: gateway.schemaVersion(id) }));
		try {
			// The live data takes the draft's migrations as this version loads.
			await gateway.install(id, draft);
		} catch (error) {
			if (live) {
				gateway.uninstall(id);
				gateway.replaceData(id, join(entry, "data.sqlite"));
				await gateway.install(id, live).catch(() => undefined);
			} else {
				gateway.uninstall(id);
				gateway.removeData(id);
			}
			rmSync(entry, { recursive: true, force: true });
			throw error;
		}
		rmSync(code(id, "live"), { recursive: true, force: true });
		writeApp(code(id, "live"), draft.files);
		rmSync(code(id, "draft"), { recursive: true, force: true });
		gateway.uninstall(draftSlot(id));
		gateway.removeData(draftSlot(id));
		prune(id);
		// The shell already shows this version's screen; only its bar changes.
		topics.changed(APPS_TOPIC);
	}

	async function discard(id: string) {
		if (!gateway.version(draftSlot(id))) throw new Error(`The ${id} app has no preview to discard.`);
		gateway.uninstall(draftSlot(id));
		gateway.removeData(draftSlot(id));
		rmSync(code(id, "draft"), { recursive: true, force: true });
		topics.changed(APPS_TOPIC);
		await rebuild();
	}

	async function undo(id: string) {
		if (gateway.version(draftSlot(id))) throw new Error("Save or discard the preview first.");
		const entry = latest(id);
		if (!entry) throw new Error(`The ${id} app has no save to undo.`);
		const restoreData = !entry.code || entry.schema !== gateway.schemaVersion(id);
		gateway.uninstall(id);
		if (entry.code) {
			const previous = appInfo(readAppFiles(entry.code), id);
			if (restoreData) gateway.replaceData(id, join(entry.dir, "data.sqlite"));
			rmSync(code(id, "live"), { recursive: true, force: true });
			writeApp(code(id, "live"), previous.files);
			await gateway.install(id, previous);
		} else {
			// The save made the app: undoing it removes the app, with the rest of its folder.
			gateway.removeData(id);
			rmSync(code(id), { recursive: true, force: true });
		}
		if (entry.code) rmSync(entry.dir, { recursive: true, force: true });
		topics.changed(APPS_TOPIC);
		await rebuild();
	}

	const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
	options.registry.install(
		defineExtension({
			name: "studio",
			sections: [
				section(
					"studio",
					() =>
						`You build apps for the user, and change them, when they ask. An app is a folder of three files you write in ${options.workspace()}/apps/<id>/: call app_code first (it writes the app's current code, or a starter, and apps/GUIDE.md, which explains the rest), edit, then call preview_app. The user tries the preview in the app's tab and saves it; you never can. Keep improving it with them until they do.`,
				),
			],
			tools: [
				defineTool({
					name: "app_code",
					description:
						"Write an app's current code into apps/<app>/ in your workspace, with apps/GUIDE.md: its draft if the user is previewing one, else its saved version, else (a new app) a working starter to change. Call it before you build or change an app.",
					parameters: obj({ app: str({ description: "The app's id: lowercase letters and digits, such as \"calendar\"." }) }),
					execute: async ({ app }: { app: string }) => text(await appCode(app)),
				}),
				defineTool({
					name: "preview_app",
					description:
						"Check apps/<app>/ in your workspace and, if it passes, show it to the user as a preview in the app's tab, on a copy of their data. Fails with what to fix: server.ts that does not load, migrations that do not apply, or a screen that does not compile.",
					parameters: obj({ app: str({ description: "The app's id, the folder's name." }) }),
					execute: async ({ app }: { app: string }) => text(await serial(() => preview(app))),
				}),
			],
		}),
	);

	return {
		/** The apps for the shell, with each one's draft and undo. */
		state: () => gateway.apps().map((app) => ({ ...app, draft: gateway.version(draftSlot(app.id)) !== undefined, undo: undoKind(app.id) })),
		/** The build the host serves, "repo" while it serves the repository's own. */
		buildId: () => current ?? "repo",
		/** Where that build is, undefined for the repository's. */
		clientDir: () => (current ? join(builds, current) : undefined),
		save: (id: string) => serial(() => save(id)),
		discard: (id: string) => serial(() => discard(id)),
		undo: (id: string) => serial(() => undo(id)),
		/** Starts the drafts, and rebuilds the shell when the host holds apps the repository's build lacks. */
		async start() {
			for (const app of options.drafts) await gateway.install(draftSlot(app.id), app).catch((error) => log(`studio: draft ${app.id}: ${error}`));
			if (existsSync(join(options.dataDir, "code"))) await serial(rebuild);
		},
	};
}
