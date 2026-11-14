#!/bin/sh
# Links the Exact modules the shell uses (each `use … from "@exact/<name>"` in client/app.contract) into
# client/node_modules from the Exact checkout the client builds with, where the Contract compiler finds them.
# `exact add` would write a fixed path into the Exact checkout instead, and Exact sits elsewhere in CI and releases.
# The host links them the same way into the copy of the shell it builds (host/src/shell.ts).
#
#   scripts/link-exact.sh [<exact>]   default: EXACT, or where scripts/setup.sh puts Exact
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
exact=${1:-${EXACT:-$(cd "$root/../.." && pwd)/tools/exact}}
modules="$root/client/node_modules/@exact"

for name in $(sed -n 's/^use .* from "@exact\/\([a-z0-9-]*\)"$/\1/p' "$root/client/app.contract" | sort -u); do
	[ -d "$exact/packages/$name" ] || {
		echo "link-exact: no module $name in $exact/packages" >&2
		exit 1
	}
	mkdir -p "$modules"
	ln -sfn "$exact/packages/$name" "$modules/$name"
done
