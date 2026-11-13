// Starts the host: ChatGPT as the model account (signed in from the app), and the machine adapter MACHINE names.
//
//   DATA_DIR      where the host keeps everything (default host/data)
//   PORT          the localhost port `tailscale serve` forwards to (default 8787)
//   MACHINE       "e2b" (default; needs E2B_API_KEY) or "local" (development only: no isolation)
//   MODEL         the ChatGPT model (default gpt-6.1-sol)
//   OWNER_LOGIN   the one Tailscale login allowed in (default: everyone on the tailnet)
//   IMP_HOME      set by scripts/install-host.sh: the installed host, which updates itself (update.ts)
//   IMP_AUTO_UPDATE  "0" keeps an installed host at its release
//   IMP_REPO      the GitHub repository releases come from (default peelar/imp)
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openCredentialStore } from "./credentials.ts";
import { startHost } from "./host.ts";
import type { MachineProvider } from "./machine.ts";
import { e2bProvider } from "./machine-e2b.ts";
import { localProvider } from "./machine-local.ts";
import { CHATGPT } from "./signin.ts";
import { runningVersion, startUpdater } from "./update.ts";

const root = join(import.meta.dirname, "..", "..");
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, "..", "data");
const kind = process.env.MACHINE ?? "e2b";
const machines: Record<string, (secret: string) => MachineProvider> = {
	e2b: (secret) => e2bProvider({ secret }),
	local: (secret) => localProvider({ secret, dir: join(dataDir, "machines") }),
};
const machine = machines[kind];
if (!machine) throw new Error(`MACHINE must be one of ${Object.keys(machines).join(", ")}`);

const { mkdirSync } = await import("node:fs");
mkdirSync(dataDir, { recursive: true });
const models = createModels({ credentials: openCredentialStore(join(dataDir, "credentials.sqlite")) });
models.setProvider(openaiCodexProvider());

const version = runningVersion(root);
const repo = process.env.IMP_REPO ?? "peelar/imp";
const host = await startHost({
	models,
	model: { provider: CHATGPT, modelId: process.env.MODEL ?? "gpt-6.1-sol" },
	machines: machine,
	dataDir,
	appsDir: join(root, "client", "apps"),
	clientDir: join(root, "client", "dist"),
	port: Number(process.env.PORT ?? 8787),
	owner: process.env.OWNER_LOGIN,
	version,
	repo,
	macInstaller: join(root, "scripts", "install-mac.sh"),
});

// Only an installed release updates itself: a checkout is the developer's to move.
const home = process.env.IMP_HOME;
if (home && version !== "dev" && process.env.IMP_AUTO_UPDATE !== "0") {
	startUpdater({
		home,
		repo,
		version,
		intervalMs: 60 * 60_000,
		idle: () => host.idle(),
		async restart() {
			await host.close();
			// The service manager (systemd or launchd, from install-host.sh) starts the new release.
			process.exit(0);
		},
	});
}
