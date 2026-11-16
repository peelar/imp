import type { KnipConfig } from "knip";

// Unused files, exports and dependencies (pnpm lint:knip). Knip finds a workspace's entries in its package.json
// scripts; these are the files that start in other ways.
export default {
  workspaces: {
    ".": {
      // The SDK is what an app's server.ts imports, so its exports are its API.
      entry: ["scripts/*.ts", "sdk/app.ts"],
      project: ["scripts/*.ts", "sdk/*.ts", "*.config.ts"],
      // Ultracite's anti-slop oxlint plugin imports it without listing it.
      ignoreDependencies: ["@oxlint/plugins"],
    },
    host: {
      // host/machine/ and the bridge client are copied to the agent's machine and run there (src/machine/runtime.ts).
      entry: [
        "scripts/*.ts",
        "test/*.test.ts",
        "machine/*.ts",
        "src/machine/bridge-client.ts",
      ],
      project: ["src/**/*.ts", "scripts/*.ts", "test/*.ts", "machine/*.ts"],
      // The agent's template, which imports the SDK from the agent's workspace.
      ignore: ["src/studio/guide/starter/**"],
      // The egress tests make a certificate with the system's openssl.
      ignoreBinaries: ["openssl"],
    },
    client: {
      // The shell's data module and each app's server code, which Exact and the host load.
      entry: ["app.ts", "apps/*/server.ts"],
      project: ["apps/*/server.ts"],
    },
  },
} satisfies KnipConfig;
