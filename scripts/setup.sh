#!/bin/sh
# Sets up a checkout to run Imp and work on it: `sh scripts/setup.sh` at the root, then `pnpm start`.
#
#   scripts/setup.sh       the web client, which the host serves
#   scripts/setup.sh mac   that, and what the Mac app builds with (on macOS)
#   scripts/setup.sh exact only Bun, Rust and Exact: what an installed host builds the shell with. The host runs this
#                          from its release (host/src/studio/toolchain.ts), which has no workspaces or tests.
#
# The host rebuilds the web client whenever the imp previews an app, so a checkout needs what the client builds with:
# Exact at the commit in client/exact-rev, the Rust toolchains Exact pins, and Bun. This installs Bun and rustup when
# they are missing, puts Exact where client/exact.mjs and the host look for it (../../../tools/exact from client/, or
# EXACT), installs what Exact's web build reads (Exact's `setup --platform web`; its plain `setup`, which `mac` runs,
# adds the native platforms' tools), installs pnpm when it is missing and the workspaces' dependencies alongside, and
# builds the web client into client/dist.
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

step "Node, pnpm and Bun"
if [ "$platform" != exact ]; then
	command -v node >/dev/null || fail "Node 24 or newer is missing: https://nodejs.org"
	major=$(node -p 'process.versions.node.split(".")[0]')
	[ "$major" -ge 24 ] || fail "Node $(node -v) is too old: Imp needs 24 or newer"
	# Where pnpm's installer puts it, which also adds it to the shell's profile.
	if [ -z "${PNPM_HOME:-}" ]; then
		[ "$(uname -s)" = Darwin ] && PNPM_HOME="$HOME/Library/pnpm" || PNPM_HOME="$HOME/.local/share/pnpm"
	fi
	export PNPM_HOME
	PATH="$PNPM_HOME/bin:$PATH"
	if ! command -v pnpm >/dev/null; then
		# The version the root's package.json pins; pnpm switches to a newer pin by itself.
		version=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$root/package.json")
		curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION="$version" sh -
	fi
	echo "pnpm $(pnpm -v)"
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
	install_log=$(mktemp)
	cd "$root"
	pnpm install --frozen-lockfile >"$install_log" 2>&1 &
	install_pid=$!
	trap 'kill "$install_pid" 2>/dev/null || true; rm -f "$install_log"' EXIT
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
if [ "$platform" = exact ]; then
	# What the web build reads: the stable toolchain Exact's rust-toolchain.toml pins, the nightly that builds the web's
	# wasm (scripts/cargo-check.mjs) and the crates it builds offline. Not Exact's `setup --platform web`, which also
	# installs the Chromium its tests drive, which an installed host does not run.
	nightly=$(sed -n "s/^export const WEB_TOOLCHAIN = '\(.*\)';$/\1/p" scripts/cargo-check.mjs)
	[ -n "$nightly" ] || fail "no WEB_TOOLCHAIN in $exact/scripts/cargo-check.mjs: Exact moved it, so update this script"
	rustup toolchain install
	rustup toolchain install "$nightly" --profile minimal -c rust-src -c llvm-tools -t wasm32-unknown-unknown
	cargo fetch --locked -q
elif [ "$platform" = web ]; then
	# Exact's own web setup: the toolchains, wasm-bindgen, Binaryen, the crates and Chromium, everything its check below
	# asks for, without the native platforms' tools.
	bun scripts/exact.mjs setup --platform web
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
wait "$install_pid" || {
	cat "$install_log"
	fail "pnpm install failed"
}
tail -1 "$install_log"
# After the install, which may prune client/node_modules: the Exact modules the client uses, from the checkout above.
sh "$root/scripts/link-exact.sh" "$exact"

step "The web client (the first build compiles Exact's web tools and takes a few minutes)"
(cd "$root/client" && EXACT="$exact" API_BASE_URL= bun exact.mjs web-build --out dist)

cat <<EOF

Ready. Start the host with \`pnpm start\` and open http://localhost:8787. MACHINE=local pnpm start gives the imp a
directory on this computer instead of one you pick in Settings.
EOF
if [ "$platform" = macos ]; then
	echo "Build the Mac app with: cd client && bun exact.mjs mac"
fi
if [ -n "${EXACT:-}" ]; then
	echo "Exact is not in its default place, so keep EXACT=$exact exported for the host and the client's commands."
fi
