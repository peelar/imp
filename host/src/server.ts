// Starts the host: ChatGPT as the model account and the agent's computer, both chosen in the app.
//
//   DATA_DIR      where the host keeps everything (default host/data)
//   PORT          the localhost port `tailscale serve` forwards to (default 8787)
//   E2B_API_KEY   an E2B key for Imp cloud, for a checkout; an installed host takes it in Settings instead
//   MACHINE       "local" fixes the agent's computer to a directory on this one (development only: no isolation);
//                 otherwise the owner picks it in Settings
//   MODEL         the ChatGPT model, used alone (default: gpt-6.1-sol, then gpt-6-sol, then gpt-6-luna, the first
//                 one ChatGPT lets the account use)
//   FLAGS         a Vercel Flags SDK key (optional); otherwise flags come from DATA_DIR/flags.json and their defaults
//   OWNER_LOGIN   the one Tailscale login allowed in (default: everyone on the tailnet)
//   IMP_HOME      set by scripts/install-host.sh: the installed host, which updates itself (update/update.ts)
//   IMP_AUTO_UPDATE  "0" keeps an installed host at its release
//   IMP_REPO      the GitHub repository releases come from (default peelar/imp)
//   EXACT         the Exact checkout the host builds the web client with (default: tools/exact beside the checkout)
//   TAILSCALE     the tailscale CLI the host reads the tailnet with (default: tailscale on PATH)
//
// This is the one file in host/src that reads settings from the environment (scripts/boundaries.ts): every other part
// is handed what it needs.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openCredentialStore, CHATGPT } from "./account/account.ts";
import { startHost } from "./host.ts";
import { localProvider } from "./computer/computer.ts";
import { runningVersion, startUpdater } from "./update/update.ts";

const root = path.join(import.meta.dirname, "..", "..");

const dataDir =
  process.env.DATA_DIR ?? path.join(import.meta.dirname, "..", "data");

if (process.env.MACHINE && process.env.MACHINE !== "local") {
  throw new Error(
    "MACHINE is only for development: set it to local, or leave it out and pick the computer in Settings"
  );
}

const machines =
  process.env.MACHINE === "local"
    ? (secret: string) =>
        localProvider({ secret, dir: path.join(dataDir, "machines") })
    : undefined;

mkdirSync(dataDir, { recursive: true });

const models = createModels({
  credentials: openCredentialStore(path.join(dataDir, "credentials.sqlite")),
});

models.setProvider(openaiCodexProvider());

// ChatGPT serves only the models an account's plan covers, so without MODEL the host moves down these until one answers.
const [model = "gpt-6.1-sol", ...fallbacks] = process.env.MODEL
  ? [process.env.MODEL]
  : ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"];

const version = runningVersion(root);
const repo = process.env.IMP_REPO ?? "peelar/imp";

const host = await startHost({
  models,
  model: { provider: CHATGPT, modelId: model },
  fallbacks,
  machines,
  dataDir,
  appsDir: path.join(root, "client", "apps"),
  clientDir: path.join(root, "client", "dist"),
  // A release installs the Exact it rebuilds the client with; a checkout has it from scripts/setup.sh.
  exactSetup:
    version === "dev" ? undefined : path.join(root, "scripts", "setup.sh"),
  port: Number(process.env.PORT ?? 8787),
  owner: process.env.OWNER_LOGIN,
  cloudKey: process.env.E2B_API_KEY,
  flagsKey: process.env.FLAGS,
  exact: process.env.EXACT,
  tailscale: process.env.TAILSCALE,
  version,
  repo,
  macInstaller: path.join(root, "scripts", "install-mac.sh"),
});

// Only an installed release updates itself: a checkout is the developer's to move.
const home = process.env.IMP_HOME;

if (home && version !== "dev" && process.env.IMP_AUTO_UPDATE !== "0") {
  startUpdater({
    home,
    repo,
    version,
    intervalMs: 60 * 60_000,
    idle: async () => await host.idle(),
    async restart() {
      await host.close();
      // The service manager (systemd or launchd, from install-host.sh) starts the new release.
      process.exit(0);
    },
  });
}
