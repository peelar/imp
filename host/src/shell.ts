// The shell's wiring for the apps, and the web build that ships it.
//
// Contract lets only the root component declare resources and mutations, so each app's screen is a component the root
// feeds: the app's app.contract exports `component Screen`, and each of its props names one of the app's operations.
// A prop of type `action` is a write the screen calls with the write's params in order; any other prop is a read
// without params, streamed live. From those props this file writes the root's part for every app between the
// `// <apps:…>` and `// </apps:…>` markers of client/app.contract and client/app.ts. The agent never writes the root.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppFiles, Operation } from "./apps.ts";

export interface ShellApp {
	readonly id: string;
	readonly files: AppFiles;
	readonly operations: readonly Pick<Operation, "name" | "kind" | "params">[];
}

/** The shell's own folder, without what a build writes or the apps, which are generated in. */
const SKIP = new Set(["dist", "target", ".exact", "apps", "node_modules", "app.contract.d.ts"]);

const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);
const CONTRACT_TYPE = { string: "string", number: "number", integer: "number", boolean: "bool", enum: "string" } as const;

/** The props of the app's `component Screen`, in order. */
export function screenProps(id: string, contract: string): { name: string; type: string }[] {
	const lines = contract.split("\n");
	const start = lines.findIndex((line) => /^component Screen\s*$/.test(line));
	if (start < 0) throw new Error(`apps/${id}/app.contract must declare \`component Screen\`: the shell shows it in the app's tab.`);
	const props: { name: string; type: string }[] = [];
	let inProps = false;
	for (const line of lines.slice(start + 1)) {
		if (!line.trim() || line.trim().startsWith("//")) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) break;
		if (indent <= 2) {
			if (inProps) break;
			inProps = line.trim() === "props";
			continue;
		}
		if (!inProps) continue;
		const prop = line.trim().match(/^(\w+)\s*:\s*(.+)$/);
		if (prop) props.push({ name: prop[1]!, type: prop[2]! });
	}
	return props;
}

/** One app's part of the root, or every problem with its Screen's props. */
function wire(app: ShellApp) {
	const { id } = app;
	const cap = pascal(id);
	const problems: string[] = [];
	const shapes = new Set<string>();
	const members: string[] = [];
	const refresh: string[] = [];
	const bindings: string[] = [];
	const mutations: string[] = [];
	for (const prop of screenProps(id, app.files["app.contract"])) {
		const operation = app.operations.find((o) => o.name === prop.name);
		const at = `Screen's prop ${prop.name}`;
		if (!operation) {
			problems.push(`${at} names no operation in server.ts (${app.operations.map((o) => o.name).join(", ") || "it has none"})`);
			continue;
		}
		const call = `${id}${pascal(operation.name)}`;
		if (prop.type === "action") {
			if (operation.kind !== "write") {
				problems.push(`${at} is an action, but ${operation.name} is a read: give the prop its answer's type, such as Item[]`);
				continue;
			}
			const params = Object.values(operation.params).map((param, i) => `arg${i + 1}: ${CONTRACT_TYPE[param.type]}`);
			const args = params.map((_, i) => `arg${i + 1}`).join(", ");
			const action = `${id}Do${pascal(operation.name)}`;
			members.push(
				`  mutation ${id}Wrote${pascal(operation.name)} as shape Reply queue`,
				`  action ${action}${params.length ? `(${params.join(", ")})` : ""}`,
				`    send ${id}Wrote${pascal(operation.name)} = ${call}(${args})`,
			);
			mutations.push(`  ${call}: true,`);
			bindings.push(`${prop.name}=${action}`);
		} else {
			if (operation.kind !== "read") {
				problems.push(`${at} is a value, but ${operation.name} is a write: make the prop an action`);
				continue;
			}
			if (Object.keys(operation.params).length > 0) {
				problems.push(`${at}: ${operation.name} takes params, and the screen can only use reads without params (filter in the screen)`);
				continue;
			}
			// The app's shapes, named for the root by the app: Item is TodosItem there.
			const type = prop.type.replace(/\b[A-Z]\w*\b/g, (shape) => (shapes.add(shape), `${cap}${shape}`));
			const resource = `${id}Read${pascal(operation.name)}`;
			members.push(
				`  resource ${resource} = ${call}() when signedIn as shape ${type} else empty()`,
				`  derive ${resource}Lost = match failure(${resource}) { case some(f) => true, case none => false }`,
			);
			refresh.push(`    if ${resource}Lost`, `      refresh ${resource}`);
			bindings.push(`${prop.name}=${resource}`);
		}
	}
	if (problems.length > 0) throw new Error(`apps/${id}/app.contract: ${problems.join("; ")}.`);
	return {
		use: `use Screen as ${cap}Screen${[...shapes].map((shape) => `, ${shape} as ${cap}${shape}`).join("")} from "./apps/${id}/app.contract"`,
		tab: `  tab ${id} "/${id}"`,
		members,
		refresh,
		screen: [
			`                  if e.name == "${id}"`,
			`                    AppPage(id="${id}", draft=hasDraft("${id}", apps), undo=undoKind("${id}", apps), save=saveApp, discard=discardApp, undoSave=undoApp)`,
			`                      ${cap}Screen(${bindings.join(", ")})`,
		],
		mutations,
	};
}

/** `text` with the lines between `// <apps:name>` and `// </apps:name>` replaced by `lines`. */
function fill(text: string, name: string, lines: readonly string[]) {
	const pattern = new RegExp(`(// <apps:${name}>[^\\n]*)[\\s\\S]*?(\\n[ \\t]*// </apps:${name}>)`);
	if (!pattern.test(text)) throw new Error(`the shell has no <apps:${name}> block`);
	return text.replace(pattern, (_, open: string, close: string) => [open, ...lines].join("\n") + close);
}

/** The shell's root files with every app wired in, built as `version`. */
export function generate(shell: { contract: string; ts: string }, apps: readonly ShellApp[], version: string) {
	const parts = [...apps].sort((a, b) => a.id.localeCompare(b.id)).map(wire);
	let contract = shell.contract;
	contract = fill(contract, "use", parts.map((p) => p.use));
	contract = fill(contract, "version", [`fn builtVersion(): string = ${JSON.stringify(version)}`]);
	contract = fill(contract, "tabs", parts.map((p) => p.tab));
	contract = fill(contract, "members", parts.flatMap((p) => p.members));
	contract = fill(contract, "refresh", parts.flatMap((p) => p.refresh));
	contract = fill(contract, "screens", parts.flatMap((p) => p.screen));
	const ts = fill(shell.ts, "mutations", parts.flatMap((p) => p.mutations));
	return { contract, ts };
}

export interface BuildOptions {
	/** The shell's source: the repository's client/. */
	readonly clientDir: string;
	/** The Exact checkout. */
	readonly exact: string;
	/** Where the shell is assembled; replaced. */
	readonly workDir: string;
	/** Where the web build goes. */
	readonly outDir: string;
	readonly apps: readonly ShellApp[];
	readonly version: string;
}

/** Assembles the shell with these apps and builds it for the web; a failure names what the compiler said. */
export async function buildShell(options: BuildOptions): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		rmSync(options.workDir, { recursive: true, force: true });
		cpSync(options.clientDir, options.workDir, {
			recursive: true,
			filter: (source) => !SKIP.has(relative(options.clientDir, source).split(/[\\/]/)[0] ?? ""),
		});
		for (const app of options.apps) {
			const dir = join(options.workDir, "apps", app.id);
			mkdirSync(dir, { recursive: true });
			for (const [name, content] of Object.entries(app.files)) writeFileSync(join(dir, name), content);
		}
		const read = (name: string) => readFileSync(join(options.workDir, name), "utf8");
		const { contract, ts } = generate({ contract: read("app.contract"), ts: read("app.ts") }, options.apps, options.version);
		writeFileSync(join(options.workDir, "app.contract"), contract);
		writeFileSync(join(options.workDir, "app.ts"), ts);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	rmSync(options.outDir, { recursive: true, force: true });
	const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
		// API_BASE_URL empty: the page asks the origin it was served from (see client/app.ts).
		const child = spawn("sh", ["exact.mjs", "web-build", "--out", options.outDir], {
			cwd: options.workDir,
			env: { ...process.env, EXACT: options.exact, API_BASE_URL: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("close", (code) => resolve({ code, output }));
		child.on("error", (error) => resolve({ code: -1, output: String(error) }));
	});
	if (code === 0) return { ok: true };
	// What the compiler said, quoting the line it refuses, without the build's chatter and the shell's own warnings.
	const noise = /^warning: patch|exact\.mjs feedback|^app\.contract:\d+:\d+ warning|^compiler: \d+ warning|^import\.meta\.env|^\(node:|trace-warnings/;
	// Paths as the agent knows them: apps/<id>/app.contract, not the host's copy of the shell.
	const said = output
		.replaceAll(`${options.workDir}/`, "")
		.split("\n")
		.filter((line) => line.trim() && !noise.test(line));
	return { ok: false, error: said.slice(-40).join("\n").slice(0, 6000) };
}
