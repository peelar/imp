# Releasing Imp

A commit that changes what the host, the Mac app or the apps do carries a changeset: run `npm run changeset`, pick a bump for `@imp/host` (patch for fixes, minor for features; Imp's version is the host's) and commit the Markdown file it writes with the change. Refactors, tests, CI and docs need none, and nothing checks for one.

On every push to `main`, the Release workflow (`.github/workflows/release.yml`) runs `changeset version` when changesets are pending: it bumps `host/package.json`, writes `host/CHANGELOG.md` and commits both to `main` as "Release Imp v<version>". The same run builds the host and the Mac app and publishes GitHub release `v<version>`, which installed hosts and Mac apps update themselves to. A push without a changeset releases nothing. Nothing is published to npm.
