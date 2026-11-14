# Updates and releases

## The host updates itself

An installed host runs from `~/.imp/current`, a link to one unpacked release under `~/.imp/releases`. Every hour it asks GitHub for the latest release. When there is a newer one, it:

1. downloads `imp-host-<tag>.tar.gz` and checks its digest,
2. unpacks it beside the running release and links it as `current`,
3. waits until the agent is idle, then exits, and
4. the service manager (systemd or launchd) starts it again from the new release.

The web client is built into the release, so the same restart updates it. Open pages notice that the host they reconnected to is another release, and reload. `host/src/update.ts` is the whole updater.

Set `IMP_AUTO_UPDATE=0` in `~/.imp/env` to keep a host at its release. A checkout never updates itself: it is the developer's to move.

## The Mac app updates itself

The Mac app checks at login and every hour, and replaces itself, quitting and reopening if it is running. It is not signed with an Apple Developer ID. macOS opens it because curl does not quarantine what it downloads.

## Making a release

Imp is released with [Changesets](https://github.com/changesets/changesets). Its version is the host's, in `host/package.json`.

1. A commit that changes what Imp does carries a changeset: `npm run changeset`, with a patch or minor bump for `@imp/host`. A commit without one releases nothing.
2. On every push to `main`, `.github/workflows/release.yml` turns the pending changesets into the next version and its section of `host/CHANGELOG.md`, and commits both to `main`.
3. The same run builds the host and web client on Linux and the Mac app on macOS (`scripts/package.sh`), and publishes them as GitHub release `v<version>`, with the changelog section as its notes:

| Asset | What it is |
| --- | --- |
| `imp-host-vX.Y.Z.tar.gz` | The host, its production dependencies and the built web client. |
| `Imp-macos.zip` | The ad-hoc signed Mac app. |
| `install-host.sh` | The host installer. |
