#!/bin/sh
# Sets up a checkout to run Imp and work on it: `npm run setup` at the root, then `npm start`.
#
# The host rebuilds the web client whenever the imp previews an app, so a checkout needs what the client builds with:
# Exact at the commit in client/exact-rev, the Rust toolchains Exact pins, and Bun. This installs Bun and rustup when
# they are missing, puts Exact where client/exact.mjs and the host look for it (../../../tools/exact from client/, or
# EXACT), runs Exact's own setup, installs the workspaces' dependencies and builds the web client into client/dist.
# Only Node 24+ and git must be there first. Run it again after a pull: it moves Exact to a new pin and rebuilds.
set -eu

fail() {
	echo "setup: $*" >&2
	exit 1
}
step() { printf '\n==> %s\n' "$*"; }

root=$(cd "$(dirname "$0")/.." && pwd)
rev=$(tr -d '[:space:]' <"$root/client/exact-rev")
exact=${EXACT:-$(cd "$root/../.." && pwd)/tools/exact}

step "Node and Bun"
command -v node >/dev/null || fail "Node 24 or newer is missing: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || fail "Node $(node -v) is too old: Imp needs 24 or newer"
[ -x "$HOME/.bun/bin/bun" ] && PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null; then
	# The version Exact pins (client/exact.mjs); its installer adds ~/.bun/bin to the shell's profile.
	curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
	PATH="$HOME/.bun/bin:$PATH"
fi
echo "node $(node -v), bun $(bun -v)"

step "Rust"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v rustup >/dev/null; then
	# No default toolchain: Exact's setup installs the ones it pins, and the build scripts pick them.
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
(cd "$exact" && bun install --frozen-lockfile && bun scripts/exact.mjs setup)

step "The workspaces' dependencies"
(cd "$root" && npm ci --no-audit --no-fund)

step "The web client (the first build compiles Exact's web runtime and takes a few minutes)"
(cd "$root/client" && EXACT="$exact" API_BASE_URL= bun exact.mjs web-build --out dist)

cat <<EOF

Ready. Start the host with \`npm start\` and open http://localhost:8787. MACHINE=local npm start gives the imp a
directory on this computer instead of one you pick in Settings.
EOF
if [ -n "${EXACT:-}" ]; then
	echo "Exact is not in its default place, so keep EXACT=$exact exported for the host and the client's commands."
fi
