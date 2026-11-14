# Releasing Imp

A PR that changes what the host, the Mac app or the apps do adds a changeset: run `npm run changeset`, pick a bump for `@imp/host`, the package a release ships (Imp's version is the host's) (patch for fixes, minor for features) and commit the Markdown file it writes. A PR that keeps behavior the same (refactors, tests, CI, docs) gets the `skip changeset` label instead. The **Require changeset** check enforces this and reruns when labels change.

On every push to `main`, the Release workflow (`.github/workflows/release.yml`) opens or updates the release PR, `changeset-release/main`. It bumps the version in `host/package.json` and writes `host/CHANGELOG.md` from the pending changesets. Merging it builds the host and the Mac app and publishes GitHub release `v<version>`, which installed hosts and Mac apps update themselves to. Nothing is published to npm.

The release PR is opened with `GITHUB_TOKEN`, so CI does not run on it by itself. Its only changes are the version and the changelog.

The repository needs **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** turned on, and the `skip changeset` label.
