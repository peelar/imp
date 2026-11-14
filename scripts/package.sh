#!/bin/sh
# Builds one part of a release into <out>, as .github/workflows/release.yml does for a new version:
#
#   scripts/package.sh host <tag> <out>   imp-host-<tag>.tar.gz (the host, its production dependencies and the built
#                                         web client) and install-host.sh; on Linux or macOS
#   scripts/package.sh mac <tag> <out>    Imp-macos.zip, the ad-hoc signed Mac app; on macOS
#
# Both need Bun and Exact (EXACT, or ../tools/exact beside this repository); host also needs Node, npm, and `npm ci` at
# the root for turbo.
set -eu

fail() { echo "package: $*" >&2; exit 1; }
[ $# -eq 3 ] || fail "usage: scripts/package.sh host|mac <tag> <out>"
what=$1 tag=$2
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "the tag is vX.Y.Z, not $tag" ;; esac
mkdir -p "$3"
out=$(cd "$3" && pwd)
root=$(cd "$(dirname "$0")/.." && pwd)
# The version Exact writes into the Mac app's Info.plist and the web build's app.version.json.
export EXACT_VERSION="${tag#v}"
# The web client asks the page's origin for its host, and the Mac app the address it saved (client/app.ts).
export API_BASE_URL=

case "$what" in
host)
	(cd "$root/client" && bun exact.mjs web-build --out dist)
	stage=$(mktemp -d)
	trap 'rm -rf "$stage"' EXIT
	# The repository's files, as git lists them (tracked, and new ones not ignored), then the built client.
	(cd "$root" && git ls-files --cached --others --exclude-standard -- host sdk client/apps scripts/install-mac.sh |
		tar -cf - -T -) | tar -xf - -C "$stage"
	mkdir -p "$stage/client"
	cp -R "$root/client/dist" "$stage/client/dist"
	# The host's production dependencies, from the workspace lockfile pruned to the host (turbo prune). The pruned lock
	# loses npm's dev flags, so `npm prune` drops what only the root's tooling needs. They go in host/node_modules,
	# where every release has had them; the workspace files are not shipped.
	(cd "$root" && npx turbo prune @imp/host --out-dir "$stage/.pruned" >/dev/null)
	cp "$stage/.pruned/package.json" "$stage/.pruned/package-lock.json" "$stage/"
	rm -rf "$stage/.pruned"
	(cd "$stage" && npm ci --omit=dev --no-audit --no-fund && npm prune --omit=dev --no-audit --no-fund)
	rm -rf "$stage/node_modules/@imp" "$stage/package.json" "$stage/package-lock.json"
	find "$stage/node_modules" -type d -empty -delete
	mv "$stage/node_modules" "$stage/host/node_modules"
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
