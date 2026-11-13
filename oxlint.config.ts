import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

// Ultracite's core and anti-slop policy, with the limits and style decisions of peelar/factory and peelar/cli.
// It covers every TypeScript file the host type-checks: the host, the SDK and each app's server code.
export default defineConfig({
  env: { browser: false, node: true },
  extends: [core, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "node_modules/**",
    "host/data/**",
    // Written by host/scripts/shell.ts between its markers, and run by Exact, not by Node.
    "client/app.ts",
    // The agent's template: it imports the SDK from where the agent's workspace keeps it, not from this repository.
    "host/studio/starter/**",
  ],
  jsPlugins: [
    ...antiSlop.jsPlugins,
    { name: "sonarjs", specifier: "eslint-plugin-sonarjs" },
  ],
  overrides: [
    {
      // node:test's test() returns a promise the runner collects; nobody awaits it.
      files: ["**/*.test.ts"],
      rules: { "typescript/no-floating-promises": "off" },
    },
    ...(core.overrides ?? []),
    {
      // Tool configs and an app's server code are default exports by their loaders' contract (see sdk/app.ts).
      files: ["*.config.ts", "client/apps/*/server.ts"],
      rules: { "import/no-default-export": "off" },
    },
  ],
  rules: {
    // Hoisted function declarations are the house style (helpers sit below their callers), so keep them.
    "eslint/func-style": "off",
    // Same style decisions as peelar/factory and peelar/cli.
    "eslint/func-names": "off",
    "eslint/no-shadow": "off",
    "eslint/no-use-before-define": "off",
    "eslint/prefer-named-capture-group": "off",
    "eslint/require-unicode-regexp": "off",
    "eslint/require-await": "off",
    "eslint/sort-keys": "off",
    // A `.catch()` handler types its parameter `unknown`, and anti-slop lets only a parameter named `cause` be that.
    "unicorn/catch-error-name": ["error", { ignore: ["^cause$"] }],
    // Nothing here runs in a browser: every postMessage is to or from a worker thread, which has no origin.
    "unicorn/require-post-message-target-origin": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/no-array-sort": "off",
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "node/callback-return": "off",
    "typescript/strict-boolean-expressions": "off",
    "import/consistent-type-specifier-style": "off",
    // pi-durable docs must be JSON objects; only type aliases get the implicit index signature that needs, interfaces do not.
    "typescript/consistent-type-definitions": ["error", "type"],
    // Type-aware exhaustiveness replaces redundant default branches.
    "default-case": "off",
    "typescript/consistent-type-imports": [
      "error",
      {
        prefer: "type-imports",
        fixStyle: "inline-type-imports",
        disallowTypeAnnotations: false,
      },
    ],
    // The anti-slop limits.
    complexity: ["error", 20],
    "import/no-default-export": "error",
    "max-depth": ["error", 3],
    "max-lines": [
      "error",
      { max: 500, skipBlankLines: true, skipComments: true },
    ],
    "max-lines-per-function": [
      "error",
      { max: 100, skipBlankLines: true, skipComments: true },
    ],
    "max-params": ["error", 3],
    "oxc/no-accumulating-spread": "error",
    "sonarjs/cognitive-complexity": ["error", 15],
    "typescript/await-thenable": "error",
    "typescript/no-floating-promises": ["error", { ignoreVoid: false }],
    "typescript/no-misused-promises": "error",
    "typescript/no-unnecessary-type-parameters": "error",
    "typescript/no-unsafe-type-assertion": "error",
  },
});
