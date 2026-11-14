// The host: Pi Durable on SQLite, the agent's machine through the adapter contract, the app gateway, and one HTTP
// origin that serves both the web client and its API. This file only puts the parts together: what the shell reads
// and changes is shell-api.ts, and how it is served is http.ts. server.ts starts it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Registry,
  section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type AppGateway, appGateway } from "./apps.ts";
import { homeChat, TOPIC as CHAT } from "./chat.ts";
import { type Computer, openComputer } from "./computer.ts";
import { serveHttp } from "./http.ts";
import { Topics } from "./live.ts";
import type { MachineProvider } from "./machine.ts";
import {
  TOPIC as MEMORY,
  type MemoryProvider,
  type MemorySystem,
} from "./memory.ts";
import { graphMemory } from "./memory-graph.ts";
import { screenSockets } from "./screen.ts";
import { shellApi } from "./shell-api.ts";
import { chatgptAccount } from "./signin.ts";
import { storedApps, studio } from "./studio.ts";

const context = BACKGROUND_CONTEXT;

export type HostOptions = {
  readonly models: Models;
  /** The home conversation's model, on the ChatGPT provider. */
  readonly model: { readonly provider: string; readonly modelId: string };
  /**
   * A fixed machine for development and tests, such as the local adapter. Absent: the owner picks the agent's computer
   * in Settings (Imp cloud, or a computer of theirs on the tailnet).
   */
  readonly machines?: ((secret: string) => MachineProvider) | undefined;
  readonly dataDir: string;
  /** The app folders (the client's apps/), inside the shell's source. */
  readonly appsDir: string;
  /** The Exact checkout the host builds the shell with. Default: the client's (../../../tools/exact from it). */
  readonly exact?: string | undefined;
  /** The built web client, served at /. Absent: the host serves only the API. */
  readonly clientDir?: string | undefined;
  readonly port: number;
  /** The Tailscale login allowed in, such as "adrian@github". Absent: everyone on the tailnet. */
  readonly owner?: string | undefined;
  /** What the imp remembers about its person, and how (memory.ts). Default: the knowledge graph in memory-graph.ts. */
  readonly memory?: MemorySystem | undefined;
  /** The running release's tag ("dev" in a checkout). Open pages reload when the host they reconnect to has another. */
  readonly version?: string | undefined;
  /** The GitHub repository releases come from, which the Mac installer downloads Imp.app from. */
  readonly repo?: string | undefined;
  /** The Mac installer script, served at /install-mac.sh with this host's address and the repository filled in. */
  readonly macInstaller?: string | undefined;
  /** An E2B API key for Imp cloud machines; the owner can also enter one in Settings. Default: E2B_API_KEY. */
  readonly cloudKey?: string | undefined;
};

/** Reports a failure of something nobody waits for, in the host's log. */
const report = (what: string) => (cause: unknown) => {
  console.error(
    `${what}: ${cause instanceof Error ? cause.message : String(cause)}`
  );
};

/** A stable secret for deriving machine tokens, created on first start. */
function hostSecret(dataDir: string) {
  const file = path.join(dataDir, "host-secret");

  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  return readFileSync(file, "utf-8").trim();
}

/** What the agent is told and can do before any app: who it is, its computer's tools, and what it remembers. */
function agentRegistry(computer: Computer, memory: MemoryProvider) {
  const registry = createRegistry();

  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "imp",
      sections: [
        section(
          "preamble",
          () =>
            `You are Imp, the user's own imp: a small, clever, loyal helper that runs their errands in the Imp app. You use their apps for them and build new apps when they ask. You have your own Linux computer: the read, write, edit, and bash tools run on it, in ${computer.workspace()}. Act without asking, except before destructive or irreversible actions. Keep answers short.`,
          { tag: false }
        ),
      ],
    })
  );
  // After the preamble, so the prompt says who the imp is before what it remembers.
  registry.install(memory.extension);

  return registry;
}

type Parts = {
  readonly options: HostOptions;
  readonly topics: Topics;
  readonly computer: Computer;
  readonly registry: Registry;
};

/** The agent's files and commands on its current computer. Built for each use, so a switch reaches the next one. */
const environment =
  (computer: Computer) =>
  ({ cwd }: { readonly cwd?: string | undefined }) =>
    new RemoteExecutionEnv({
      connection: computer.connection(),
      id: computer.id(),
      cwd: cwd ?? computer.workspace(),
    });

/** The apps: the gateway that runs them, and the studio the agent builds them in. */
function openApps({ options, topics, computer, registry }: Parts) {
  const { dataDir, appsDir } = options;

  const stored = storedApps(dataDir, appsDir, (message) => {
    console.error(message);
  });

  const gateway = appGateway({
    apps: stored.live,
    dataDir,
    topics,
    registry,
    machine: async () => {
      const machine = await computer.machine();

      computer.touch();

      return machine;
    },
  });

  const clientSource = path.resolve(appsDir, "..");
  const env = environment(computer);

  const apps = studio({
    dataDir,
    repoAppsDir: appsDir,
    clientDir: clientSource,
    exact:
      options.exact ??
      process.env.EXACT ??
      path.resolve(clientSource, "../../../tools/exact"),
    gateway,
    topics,
    registry,
    files: () => env({}),
    workspace: computer.workspace,
    context,
    drafts: stored.drafts,
  });

  return { gateway, apps };
}

/** The agent and its home conversation, which follow the computer when the owner switches it. */
async function openAgent(parts: Parts, gateway: AppGateway) {
  const { options, topics, computer, registry } = parts;

  const harness = await Harness.open(
    await openNodeSqliteStorage(path.join(options.dataDir, "harness.sqlite")),
    { models: options.models, registry, env: environment(computer) },
    context
  );

  const agent = () => ({ model: options.model, cwd: computer.workspace() });
  const home = await harness.root(context, { agent: agent() });

  // root() applies `agent` only when it creates the conversation; a changed model or machine applies on every start,
  // and a switch of computer at once: its apps load on the new machine and the agent works there.
  await home.configure(agent(), context);
  computer.onSwitch(async () => {
    gateway.disconnect();
    await home.configure(agent(), context);
    gateway.start().catch(report("apps"));
  });

  const chat = await homeChat({
    harness,
    home,
    topics,
    apps: gateway.apps,
    context,
  });

  harness.resume();

  // While the agent works, its tools use the machine.
  const keepAwake = async () => {
    if (await chat.busy()) {
      computer.touch();
    }
  };

  topics.on(CHAT, () => {
    keepAwake().catch(report("chat"));
  });

  return { harness, home, chat };
}

export async function startHost(options: HostOptions) {
  const { dataDir, version = "dev" } = options;

  mkdirSync(dataDir, { recursive: true });

  const secret = hostSecret(dataDir);
  const topics = new Topics();

  // The agent's computer, as the owner picked it in Settings. Nothing here names the provider.
  const computer = openComputer({
    dataDir,
    secret,
    topics,
    fixed: options.machines?.(secret),
    cloudKey: options.cloudKey ?? process.env.E2B_API_KEY,
  });

  const memory = (options.memory ?? graphMemory)({
    dataDir,
    changed: () => {
      topics.changed(MEMORY);
    },
  });

  const parts = {
    options,
    topics,
    computer,
    registry: agentRegistry(computer, memory),
  };

  const { gateway, apps } = openApps(parts);
  const account = chatgptAccount(options.models, topics);
  const { harness, home, chat } = await openAgent(parts, gateway);

  // Load every app now. A machine that is down is retried by the first call that needs it.
  const loadApps = async () => {
    await gateway.start();
    await apps.start();
  };

  loadApps().catch(report("apps"));

  const screens = screenSockets(computer);

  const http = await serveHttp({
    port: options.port,
    owner: options.owner,
    api: shellApi({
      account,
      chat,
      computer,
      memory,
      studio: apps,
      gateway,
      home,
      context,
      version,
    }),
    topics,
    screens,
    // The newest shell the host built for its apps, else the one it shipped with.
    clientDir: () => apps.clientDir() ?? options.clientDir,
    version,
    macInstaller: options.macInstaller,
    repo: options.repo,
  });

  console.log(
    `host on http://127.0.0.1:${options.port}, model ${options.model.provider}/${options.model.modelId}`
  );

  return {
    gateway,
    /** Whether the agent is between turns. */
    idle: async () => !(await chat.busy()),
    async close() {
      screens.close();
      http.close();
      gateway.close();
      computer.close();
      await chat.close();
      await harness.close(context);
    },
  };
}
