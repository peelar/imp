#!/bin/sh
# Builds one part of a release into <out>, as .github/workflows/release.yml does for a new version:
#
#   scripts/package.sh host <tag> <out>   imp-host-<tag>.tar.gz (the host, its production dependencies and the built
#                                         web client) and install-host.sh; on Linux or macOS
#   scripts/package.sh mac <tag> <out>    Imp-macos.zip, the ad-hoc signed Mac app; on macOS
#
# Both need Bun and Exact (EXACT, or where scripts/setup.sh puts it); host also needs Node and pnpm.
set -eu

fail() { echo "package: $*" >&2; exit 1; }
[ $# -eq 3 ] || fail "usage: scripts/package.sh host|mac <tag> <out>"
what=$1 tag=$2
# A release's tag, or main-<commit> for the build of main's newest commit (.github/workflows/unreleased.yml).
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) version=${tag#v} ;; main-*) version="0.0.0-$tag" ;; *) fail "the tag is vX.Y.Z or main-<commit>, not $tag" ;; esac
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(cd "$(dirname "$0")/.." && pwd)
# The version Exact writes into the Mac app's Info.plist and the web build's app.version.json.
export EXACT_VERSION="$version"
# The web client asks the page's origin for its host, and the Mac app the address it saved (client/app.ts).
export API_BASE_URL=
# The Exact modules the client uses, which its builds read from client/node_modules.
sh "$root/scripts/link-exact.sh"

case "$what" in
host)
	(cd "$root/client" && bun exact.mjs web-build --out dist)
	stage=$(mktemp -d)
	trap 'rm -rf "$stage"' EXIT
	# The repository's files, as git lists them (tracked, and new ones not ignored), then the built client. The client's
	# source and scripts/setup.sh (with link-exact.sh) come along: the host rebuilds the client with each app it
	# previews, with the Exact that script installs (host/src/studio/toolchain.ts).
	(cd "$root" && git ls-files --cached --others --exclude-standard -- LICENSE host sdk client scripts/install-mac.sh scripts/setup.sh scripts/link-exact.sh |
		tar -cf - -T -) | tar -xf - -C "$stage"
	cp -R "$root/client/dist" "$stage/client/dist"
	# The host's production dependencies, as the workspace lockfile pins them (pnpm deploy). They go in
	# host/node_modules, where every release has had them; the rest of the deployed copy is not shipped. Its links
	# point inside node_modules, so they hold after the move.
	(cd "$root" && pnpm --filter @imp/host deploy --prod "$stage/.deployed" >/dev/null)
	mv "$stage/.deployed/node_modules" "$stage/host/node_modules"
	rm -rf "$stage/.deployed"
	echo "$tag" > "$stage/VERSION"
	tar -czf "$out/imp-host-$tag.tar.gz" -C "$stage" .
	cp "$root/scripts/install-host.sh" "$out/install-host.sh"
	echo "$out/imp-host-$tag.tar.gz"
	;;
mac)
	[ "$(uname -s)" = Darwin ] || fail "the Mac app builds on macOS"
	built=$(cd "$root/client" && bun exact.mjs mac --release --json | tail -1)
	app=$(printf '%s' "$built" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
	[ -d "$app" ] || fail "the Mac build made no app: $built"
	rm -f "$out/Imp-macos.zip"
	# ditto, not zip, which breaks the bundle's symlinks and its signature.
	ditto -c -k --sequesterRsrc --keepParent "$app" "$out/Imp-macos.zip"
	echo "$out/Imp-macos.zip"
	;;
*) fail "usage: scripts/package.sh host|mac <tag> <out>" ;;
esac
