# Updates and releases

## The host updates itself

An installed host runs from `~/.imp/current`, a link to one unpacked release under `~/.imp/releases`. Every hour it asks GitHub for the latest release. When there is a newer one, it:

1. downloads `imp-host-<tag>.tar.gz` and checks its digest,
2. unpacks it beside the running release and links it as `current`,
3. waits until the agent is idle, then exits, and
4. the service manager (systemd or launchd) starts it again from the new release.

The web client is built into the release, so the same restart updates it. Settings → General shows the release the host runs (`dev` for a checkout). Open pages notice that the host they reconnected to is another release, and reload. `host/src/update/update.ts` is the whole updater.

Set `IMP_AUTO_UPDATE=0` in `~/.imp/env` to keep a host at its release. A checkout never updates itself: it is the developer's to move. Nor does a build of `main` installed from the `unreleased` prerelease (its version is `main-<commit>`), since the latest release is older than it; `.github/workflows/unreleased.yml` rebuilds that prerelease on every push to `main`, without the Mac app.

## The Mac app updates itself

A launchd agent that `scripts/install-mac.sh` installs (`dev.imp.updater`) checks GitHub at login and every hour. It never quits Imp:

- While Imp is closed, a new release replaces it at once.
- While Imp is open, the release is downloaded and checked, and waits in `~/Library/Application Support/Imp/staged`. The updater writes its tag to `update.json` in the app's storage (`~/Library/Application Support/exact/dev.imp.app/data`), and **Restart for vX.Y.Z** shows at the bottom of the left sidebar, above Settings (in the sidebar's drawer on a narrow window). Restart writes `restart` beside it and quits Imp. The agent watches for that file: once Imp is gone it puts the release in place and opens Imp again. If the quit is cancelled, the release keeps waiting.

After it installs a release, the updater runs that release's `install-mac.sh --refresh`, which writes the updater again, so a change to the updater reaches every Mac with the release that makes it. A Mac installed before this updater keeps the old one, which quits and reopens Imp, until `install-mac.sh` runs on it once more. What the updater did is in `~/Library/Application Support/Imp/update.log`.

The app is not signed with an Apple Developer ID. macOS opens it because curl does not quarantine what it downloads.

## Making a release

Imp is released with [Changesets](https://github.com/changesets/changesets). Its version is the host's, in `host/package.json`.

1. A commit that changes what Imp does carries a changeset: `pnpm changeset`, with a patch or minor bump for `@imp/host`. A commit without one releases nothing.
2. On every push to `main`, `.github/workflows/release.yml` turns the pending changesets into the next version and its section of `host/CHANGELOG.md`, and commits both to `main`.
3. The same run builds the host and web client on Linux and the Mac app on macOS (`scripts/package.sh`), and publishes them as GitHub release `v<version>`, with the changelog section as its notes:

| Asset | What it is |
| --- | --- |
| `imp-host-vX.Y.Z.tar.gz` | The host, its production dependencies and the built web client. |
| `Imp-macos.zip` | The ad-hoc signed Mac app. |
| `install-host.sh` | The host installer. |
