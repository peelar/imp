---
"@imp/host": minor
---

The GitHub app is now behind the `github-app` feature flag, off by default. To keep using it, add `{ "github-app": true }` to `flags.json` in the host's data directory and restart the host; its data is still there.
