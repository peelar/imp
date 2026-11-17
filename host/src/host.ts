// The host: the agent (agent/), its computer, the app gateway, and one HTTP origin that serves both the web client
// and its API. This file only opens the parts and connects them: what the shell reads and changes is shell-api.ts,
// and how it is served is http.ts. server.ts starts it.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Registry } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { actionsExtension } from "./actions/actions.ts";
import { agentRegistry, openHarness } from "./agent/agent.ts";
import { type AppGateway, appGateway, hasAppData } from "./apps/apps.ts";
import { openAssistants } from "./assistants/assistants.ts";
import { type AppBackup, appBackup, type GithubApi } from "./backup/backup.ts";
import { openConnections } from "./connections/connections.ts";
import { TOPIC as CHAT, openChats } from "./chats/chats.ts";
import {
  type Computer,
  openComputer,
  screenSockets,
} from "./computer/computer.ts";
import { serveHttp } from "./http.ts";
import { openRoutines, routinesExtension } from "./routines/routines.ts";
import { openTricks, tricksExtension } from "./tricks/tricks.ts";
import { TOPIC as FLAGS, openFlags } from "./flags/flags.ts";
import { Topics } from "./live/live.ts";
import type { Machine, MachineProvider } from "./machine/machine.ts";
import {
  TOPIC as MEMORY,
  type MemoryProvider,
  type MemorySystem,
  graphMemory,
} from "./memory/memory.ts";
import {
  openSecrets,
  type Secrets,
  TOPIC as SECRETS,
} from "./secrets/secrets.ts";
import { openNotifications } from "./notifications/notifications.ts";
import { shellApi } from "./shell-api.ts";
import {
  TOPIC as ACCOUNT,
  type ModelAccount,
  type ModelRef,
  modelAccount,
} from "./account/account.ts";
import { storedApps, studio } from "./studio/studio.ts";

const context = BACKGROUND_CONTEXT;

export type HostOptions = {
  readonly models: MutableModels;
  /** The agent's model after a ChatGPT sign-in, on the ChatGPT provider. An API key names its own. */
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The ChatGPT models to fall back on, best first, when ChatGPT refuses `model` (account/fallback.ts). */
  readonly fallbacks?: readonly string[] | undefined;
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
  /** scripts/setup.sh, for a host that installs Exact itself: a release. Absent: a checkout, whose developer does. */
  readonly exactSetup?: string | undefined;
  /** The built web client, served at /. Absent: the host serves only the API. */
  readonly clientDir?: string | undefined;
  readonly port: number;
  /** The Tailscale login allowed in, such as "adrian@github". Absent: everyone on the tailnet. */
  readonly owner?: string | undefined;
  /** What the imp remembers about its person, and how (memory/memory.ts). Default: the knowledge graph in memory/graph.ts. */
  readonly memory?: MemorySystem | undefined;
  /** The running release's tag ("dev" in a checkout). Open pages reload when the host they reconnect to has another. */
  readonly version?: string | undefined;
  /** The GitHub repository releases come from, which the Mac installer downloads Imp.app from. */
  readonly repo?: string | undefined;
  /** The Mac installer script, served at /install-mac.sh with this host's address and the repository filled in. */
  readonly macInstaller?: string | undefined;
  /** An E2B API key for Imp cloud machines; the owner can also enter one in Settings. */
  readonly cloudKey?: string | undefined;
  /** A Vercel Flags SDK key. Absent: flags come from DATA_DIR/flags.json and their defaults (flags/flags.ts). */
  readonly flagsKey?: string | undefined;
  /** The tailscale CLI the host reads the tailnet with. Default: tailscale on PATH. */
  readonly tailscale?: string | undefined;
  /** Where the programs the host downloads are kept (processes/programs.ts). Default: DATA_DIR/tools. */
  readonly toolsDir?: string | undefined;
  /** The GitHub CLI that Connect GitHub signs in with (connections/connections.ts). Default: a pinned gh in toolsDir. */
  readonly gh?: string | undefined;
  /** GitHub's REST API as the backup reaches it. Default: api.github.com, with the github key the proxy puts on. */
  readonly github?: GithubApi | undefined;
};

/** The ChatGPT models the agent may run on, best first. */
const chatgptModels = ({ model, fallbacks = [] }: HostOptions) => [
  model.modelId,
  ...fallbacks,
];

const named = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/** Reports a failure of something nobody waits for, in the host's log. */
const report = (what: string) => (cause: unknown) => {
  console.error(
    `${what}: ${cause instanceof Error ? cause.message : String(cause)}`
  );
};

/** What the agent is told and can do before any app: who it is, its computer's tools, the web, and what it remembers. */
function imp(computer: Computer, memory: MemoryProvider) {
  const registry = agentRegistry(computer.workspace);

  registry.install(tricksExtension);
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

/** Where the agent's files and commands are now. Read for each use, so a switch of computer reaches the next one. */
const place = (computer: Computer, cwd?: string) => ({
  connection: computer.connection(),
  id: computer.id(),
  cwd: cwd ?? computer.workspace(),
});

/** The studio the agent builds apps in, which builds the shell for the apps the gateway runs. */
function openStudio(
  { options, topics, computer, registry }: Parts,
  gateway: AppGateway,
  {
    drafts,
    liveChanged,
  }: Pick<Parameters<typeof studio>[0], "drafts" | "liveChanged">
) {
  const clientSource = path.resolve(options.appsDir, "..");

  return studio({
    dataDir: options.dataDir,
    repoAppsDir: options.appsDir,
    clientDir: clientSource,
    exact: options.exact ?? path.resolve(clientSource, "../../../tools/exact"),
    exactSetup: options.exactSetup,
    gateway,
    topics,
    registry,
    // The agent's files only: nothing the studio runs needs the owner's secrets.
    files: () => new RemoteExecutionEnv(place(computer)),
    workspace: computer.workspace,
    context,
    drafts,
    liveChanged,
  });
}

/** The owner's secrets, which the agent's commands and the apps' code use without holding them. */
function openOwnerSecrets(
  { options, topics, registry }: Parts,
  machine: () => Promise<Machine>
) {
  const { dataDir } = options;

  const secrets = openSecrets({
    dataDir,
    toolsDir: options.toolsDir ?? path.join(dataDir, "tools"),
    topics,
    registry,
    machine,
  });

  secrets.start();

  return secrets;
}

/** GitHub's REST API, with the owner's github key, which the egress proxy puts on each request. */
const githubApi =
  (secrets: Secrets): GithubApi =>
  async ({ method, path: route, body }) =>
    await secrets.sendForApp({
      app: "backup",
      url: `https://api.github.com${route}`,
      method,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : "",
      secret: "github",
      address: "",
    });

/** Every version of the apps' code, which the host keeps for the owner beside the apps' data. */
function openBackup(
  { options, topics }: Parts,
  gateway: AppGateway,
  secrets: Secrets
) {
  const { dataDir } = options;

  // Every live app's code, versioned on the host and pushed to GitHub once turned on, with the GitHub connection.
  const backup = appBackup({
    dataDir,
    topics,
    apps: () => gateway.apps().flatMap((app) => gateway.live(app.id) ?? []),
    github: {
      connected: () => secrets.keyHosts("github") !== undefined,
      api: options.github ?? githubApi(secrets),
      pushEnv: secrets.programEnv,
    },
  });

  backup.start();

  return backup;
}

/**
 * The accounts the host connects to, whose sign-ins the vault keeps as keys: GitHub, which the backup pushes with, and
 * the MCP servers, whose keys only the host's own requests for each server get.
 */
function openAccountConnections(
  { options, topics, registry }: Parts,
  {
    secrets,
    backup,
    gateway,
  }: { secrets: Secrets; backup: AppBackup; gateway: AppGateway }
) {
  const connections = openConnections({
    dataDir: options.dataDir,
    toolsDir: options.toolsDir ?? path.join(options.dataDir, "tools"),
    gh: options.gh,
    topics,
    keys: {
      ready: secrets.ready,
      has: (name) => secrets.keyHosts(name) !== undefined,
      put: async (name, value) =>
        await secrets.put({
          name,
          service: name,
          value,
          hosts: "",
          header: "",
          prefix: "",
          envName: "",
        }),
      remove: secrets.remove,
    },
    serverKeys: {
      ready: secrets.ready,
      has: secrets.has,
      standIn: secrets.standIn,
      putFor: secrets.putFor,
      remove: secrets.remove,
    },
    send: secrets.sendFor,
    disconnected: () => {
      backup.turnOff();
    },
  });

  connections.start();

  // What the imp can do with the apps and the MCP servers, behind one search and one run.
  registry.install(
    actionsExtension({ apps: gateway.agent, servers: connections.servers })
  );

  return connections;
}

type Followers = {
  readonly gateway: AppGateway;
  readonly secrets: Secrets;
  readonly account: ModelAccount;
};

/**
 * The agent, its conversations, its routines and its tricks, which follow the computer when the owner switches it.
 */
async function openAgent(
  parts: Parts,
  { gateway, secrets, account }: Followers
) {
  const { options, topics, computer, registry } = parts;

  // The conversations start on the model of the account the host has stored.
  await account.ready;

  const harness = await openHarness({
    dataDir: options.dataDir,
    models: options.models,
    registry,
    // Built for each tool call, so a switch reaches the agent's next one, and so does a secret added in Settings.
    env: async ({ cwd }: { readonly cwd?: string | undefined }) =>
      new RemoteExecutionEnv({
        ...place(computer, cwd),
        shellEnv: await secrets.shellEnv(),
      }),
    context,
  });

  const model = () => account.model() ?? options.model;
  const agent = () => ({ model: model(), cwd: computer.workspace() });

  const chats = await openChats({
    harness,
    topics,
    apps: gateway.apps,
    context,
    dataDir: options.dataDir,
    agent,
  });

  // What the imp does on a schedule, in conversations of their own, once it is signed in.
  const routines = openRoutines({
    dataDir: options.dataDir,
    topics,
    chats,
    ready: async () => await account.usable(),
  });

  registry.install(routinesExtension(routines));

  // The agent's files only: listing the tricks needs none of the owner's secrets.
  const tricks = openTricks({
    env: async () => new RemoteExecutionEnv(place(computer)),
    topics,
    context,
  });

  // A switch of computer applies at once: its apps load on the new machine, the agent works there, and its tricks
  // are that machine's.
  computer.onSwitch(async () => {
    gateway.disconnect();
    secrets.switched();
    await chats.configure();

    const reload = async () => {
      await gateway.start();
      await tricks.refresh();
    };

    reload().catch(report("apps"));
  });

  // Signing in with the other kind of account moves the conversations to its model.
  let current = model();

  topics.on(ACCOUNT, () => {
    const next = model();

    if (
      next.provider !== current.provider ||
      next.modelId !== current.modelId
    ) {
      current = next;
      chats.configure().catch(report("model"));
    }
  });

  harness.resume();
  routines.start();

  // While the agent works, its tools use the machine. Once a turn ends, the imp may have learned a trick.
  let working = false;

  const followTurn = async () => {
    const busy = await chats.busy();

    if (busy) {
      computer.touch();
    } else if (working) {
      await tricks.refresh();
    }

    working = busy;
  };

  topics.on(CHAT, () => {
    followTurn().catch(report("chat"));
  });

  // What the person is told while they are away: a routine's run, a key the imp asks for, a reply it finished.
  const notifications = openNotifications({ topics, chats, routines, secrets });

  return { harness, chats, routines, tricks, notifications };
}

/**
 * The feature flags, decided as the host starts; the owner's choice in Settings changes TOPIC for the next start.
 */
async function hostFlags({ dataDir, flagsKey }: HostOptions, topics: Topics) {
  return await openFlags({
    dataDir,
    sdkKey: flagsKey,
    log: (message) => {
      console.log(message);
    },
    changed: () => {
      topics.changed(FLAGS);
    },
  });
}

/** The app gateway: the stored live apps, with the owner's keys. */
function openAppGateway(
  { options, topics }: Parts,
  {
    stored,
    machine,
    secrets,
  }: {
    stored: ReturnType<typeof storedApps>;
    machine: () => Promise<Machine>;
    secrets: ReturnType<typeof openOwnerSecrets>;
  }
) {
  const gateway = appGateway({
    apps: stored.live,
    dataDir: options.dataDir,
    topics,
    machine,
    keyHosts: secrets.keyHosts,
    send: secrets.sendForApp,
  });

  // Connecting GitHub, or adding a key in Secrets, lets an app that waited for it sync.
  topics.on(SECRETS, () => {
    gateway.keysChanged();
  });

  return gateway;
}

/** Other assistants on the tailnet, such as Claude Code, which reach the apps the owner shares with them over MCP. */
const openOtherAssistants = (
  { options, topics }: Parts,
  gateway: AppGateway,
  version: string
) =>
  openAssistants({
    dataDir: options.dataDir,
    topics,
    apps: gateway.agent,
    version,
    log: (message) => {
      console.error(message);
    },
  });

/** Loads every app now, and what depends on them. A machine that is down is retried by the first call that needs it. */
async function loadApps(parts: {
  readonly gateway: AppGateway;
  readonly studio: { readonly start: () => Promise<void> };
  readonly tricks: { readonly refresh: () => Promise<void> };
}) {
  await parts.gateway.start();
  await Promise.all([parts.studio.start(), parts.tricks.refresh()]);
}

/** The agent's machine, for something that is about to use it. */
const machineInUse = (computer: Computer) => async () => {
  const running = await computer.machine();

  computer.touch();

  return running;
};

/** The apps' code the host keeps: each app's live version and its draft. */
const keptApps = ({ dataDir, appsDir }: HostOptions) =>
  storedApps({
    dataDir,
    repoAppsDir: appsDir,
    hasData: (id) => hasAppData(dataDir, id),
    log: (message) => {
      console.error(message);
    },
  });

export async function startHost(options: HostOptions) {
  const { dataDir, version = "dev" } = options;

  mkdirSync(dataDir, { recursive: true });

  const topics = new Topics();

  // The agent's computer, as the owner picked it in Settings. Nothing here names the provider.
  const computer = openComputer({
    dataDir,
    topics,
    fixed: options.machines,
    cloudKey: options.cloudKey,
    tailscale: options.tailscale,
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
    registry: imp(computer, memory),
  };

  const stored = keptApps(options);

  const machine = machineInUse(computer);
  const secrets = openOwnerSecrets(parts, machine);

  const flags = await hostFlags(options, topics);
  const gateway = openAppGateway(parts, { stored, machine, secrets });

  const backup = openBackup(parts, gateway, secrets);

  const connections = openAccountConnections(parts, {
    secrets,
    backup,
    gateway,
  });

  // Every save and undo changes the live code, which the backup keeps.
  const apps = openStudio(parts, gateway, {
    drafts: stored.drafts,
    liveChanged: backup.record,
  });

  const account = modelAccount(options.models, topics, {
    ids: chatgptModels(options),
    dataDir: options.dataDir,
  });

  const agent = await openAgent(parts, { gateway, secrets, account });
  const { harness, chats, routines, tricks, notifications } = agent;

  loadApps({ gateway, studio: apps, tricks }).catch(report("apps"));

  const screens = screenSockets(computer);
  const assistants = openOtherAssistants(parts, gateway, version);

  const http = await serveHttp({
    port: options.port,
    owner: options.owner,
    api: shellApi({
      account,
      chats,
      routines,
      notifications,
      tricks,
      computer,
      memory,
      secrets,
      backup,
      connections,
      flags,
      assistants,
      studio: apps,
      gateway,
      version,
    }),
    mcp: assistants.serve,
    topics,
    screens,
    // The newest shell the host built for its apps, else the one it shipped with.
    clientDir: () => apps.clientDir() ?? options.clientDir,
    version,
    macInstaller: options.macInstaller,
    repo: options.repo,
    connectionCallback: connections.servers.finish,
  });

  console.log(
    `host on http://127.0.0.1:${options.port}, model ${named(account.model() ?? options.model)}`
  );

  return {
    gateway,
    /** Whether the agent is between turns. */
    idle: async () => !(await chats.busy()),
    async close() {
      screens.close();
      assistants.close();
      http.close();
      gateway.close();
      computer.close();
      secrets.close();
      connections.close();
      routines.close();
      await chats.close();
      await harness.close(context);
    },
  };
}
