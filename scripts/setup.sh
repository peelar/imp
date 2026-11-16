#!/bin/sh
# Sets up a checkout to run Imp and work on it: `npm run setup` at the root, then `npm start`.
#
#   scripts/setup.sh       the web client, which the host serves (npm run setup)
#   scripts/setup.sh mac   that, and what the Mac app builds with (npm run setup:mac; on macOS)
#   scripts/setup.sh exact only Bun, Rust and Exact: what an installed host builds the shell with. The host runs this
#                          from its release (host/src/studio/toolchain.ts), which has no workspaces or tests.
#
# The host rebuilds the web client whenever the imp previews an app, so a checkout needs what the client builds with:
# Exact at the commit in client/exact-rev, the Rust toolchains Exact pins, and Bun. This installs Bun and rustup when
# they are missing, puts Exact where client/exact.mjs and the host look for it (../../../tools/exact from client/, or
# EXACT), installs what Exact's web build reads (Exact's own `setup` adds the native platforms' tools, which `mac`
# runs), installs the workspaces' dependencies alongside, and builds the web client into client/dist.
# Only Node 24+ and git must be there first. Run it again after a pull: it moves Exact to a new pin and rebuilds.
set -eu

fail() {
	echo "setup: $*" >&2
	exit 1
}
step() { printf '\n==> %s\n' "$*"; }

case "${1:-web}" in
web) platform=web ;;
mac)
	[ "$(uname -s)" = Darwin ] || fail "the Mac app builds on macOS"
	platform=macos
	;;
exact) platform=exact ;;
*) fail "usage: scripts/setup.sh [web|mac|exact]" ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd)
rev=$(tr -d '[:space:]' <"$root/client/exact-rev")
exact=${EXACT:-$(cd "$root/../.." && pwd)/tools/exact}

step "Node and Bun"
if [ "$platform" != exact ]; then
	command -v node >/dev/null || fail "Node 24 or newer is missing: https://nodejs.org"
	major=$(node -p 'process.versions.node.split(".")[0]')
	[ "$major" -ge 24 ] || fail "Node $(node -v) is too old: Imp needs 24 or newer"
fi
[ -x "$HOME/.bun/bin/bun" ] && PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null; then
	# The version Exact pins (client/exact.mjs); its installer adds ~/.bun/bin to the shell's profile.
	curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
	PATH="$HOME/.bun/bin:$PATH"
fi
echo "bun $(bun -v)"

# The workspaces' dependencies install while Exact sets up: they share nothing.
if [ "$platform" != exact ]; then
	npm_log=$(mktemp)
	cd "$root"
	npm ci --no-audit --no-fund >"$npm_log" 2>&1 &
	npm_pid=$!
	trap 'kill "$npm_pid" 2>/dev/null || true; rm -f "$npm_log"' EXIT
fi

step "Rust"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v rustup >/dev/null; then
	# No default toolchain: the ones Exact pins come next, and its build scripts pick them.
	curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
	. "$HOME/.cargo/env"
fi

step "Exact $rev in $exact"
if [ ! -d "$exact/.git" ]; then
	[ ! -e "$exact" ] || fail "$exact exists and is not a git checkout: move it, or set EXACT to another path"
	mkdir -p "$exact" 2>/dev/null ||
		fail "cannot create $exact: set EXACT to a directory you own (and export it in your shell profile)"
	git init -q "$exact"
fi
if [ "$(git -C "$exact" rev-parse HEAD 2>/dev/null)" != "$rev" ]; then
	[ -z "$(git -C "$exact" status --porcelain)" ] ||
		fail "$exact has uncommitted changes: commit or stash them, and run this again to move it to $rev"
	git -C "$exact" fetch -q --depth 1 https://github.com/expo/exact "$rev"
	git -C "$exact" -c advice.detachedHead=false checkout -q "$rev"
fi
cd "$exact"
bun install --frozen-lockfile
if [ "$platform" != macos ]; then
	# What the web build reads, as Exact's setup installs it: the stable toolchain its rust-toolchain.toml pins, the
	# nightly that builds the web's wasm (scripts/cargo-check.mjs), the crates it builds offline, and the Chromium its
	# tests drive. Exact's setup also builds tools for GPU modules, games and native TypeScript, which Imp's web
	# client does not use.
	nightly=$(sed -n "s/^export const WEB_TOOLCHAIN = '\(.*\)';$/\1/p" scripts/cargo-check.mjs)
	[ -n "$nightly" ] || fail "no WEB_TOOLCHAIN in $exact/scripts/cargo-check.mjs: Exact moved it, so update this script"
	rustup toolchain install
	rustup toolchain install "$nightly" --profile minimal -c rust-src -c llvm-tools -t wasm32-unknown-unknown
	cargo fetch --locked -q
	# The Chromium is for tests, which an installed host does not run.
	[ "$platform" = exact ] || [ -n "${CHROME:-}" ] || bun node_modules/playwright-core/cli.js install chromium chromium-headless-shell
else
	bun scripts/exact.mjs setup
fi
cd "$root"
if [ "$platform" = exact ]; then
	# Exact's own check also wants the Chromium its tests drive, so a web build checks instead. It also compiles Exact's
	# web tools into its checkout, which takes minutes once, so the host's first preview does not.
	step "A web build (the first compiles Exact's web tools and takes a few minutes)"
	sh "$root/scripts/link-exact.sh" "$exact"
	out=$(mktemp -d)
	(cd "$root/client" && EXACT="$exact" API_BASE_URL= bun exact.mjs web-build --out "$out/dist")
	rm -rf "$out"
	echo "Exact $rev is ready in $exact"
	exit 0
fi
# Exact's own check of what a build for this platform reads; it fails, naming the rest, when something is missing.
(cd "$exact" && bun scripts/exact.mjs setup --check --platform "$platform")

step "The workspaces' dependencies"
wait "$npm_pid" || {
	cat "$npm_log"
	fail "npm ci failed"
}
tail -1 "$npm_log"
# After npm ci, which empties node_modules: the Exact modules the client uses, from the checkout above.
sh "$root/scripts/link-exact.sh" "$exact"

step "The web client (the first build compiles Exact's web tools and takes a few minutes)"
(cd "$root/client" && EXACT="$exact" API_BASE_URL= bun exact.mjs web-build --out dist)

cat <<EOF

Ready. Start the host with \`npm start\` and open http://localhost:8787. MACHINE=local npm start gives the imp a
directory on this computer instead of one you pick in Settings.
EOF
if [ "$platform" = macos ]; then
	echo "Build the Mac app with: cd client && bun exact.mjs mac"
fi
if [ -n "${EXACT:-}" ]; then
	echo "Exact is not in its default place, so keep EXACT=$exact exported for the host and the client's commands."
fi
