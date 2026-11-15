import { defineConfig } from "oxfmt";
import core from "ultracite/oxfmt";

export default defineConfig({
  ...core,
  // Pages the host serves as they are written (host/src/computer/screen.html) are not reformatted.
  ignorePatterns: [...(core.ignorePatterns ?? []), "**/*.html"],
  sortImports: false,
});
