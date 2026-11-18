#!/bin/sh
# The walkthrough: Imp driven end to end in a real browser as a person meets it, every screen photographed, for whoever
# changed the app to look at before handing it over (AGENTS.md says when). Each part runs against the real host with
# test-host.ts's scripted model, its self-approving ChatGPT and GitHub sign-ins and the local computer, on fresh data.
#
#   sh scripts/walkthrough.sh          screens, then build (pnpm walkthrough)
#   sh scripts/walkthrough.sh screens  client/walkthrough/walkthrough.test.contract in Exact's test runner, in Chrome at
#                                      a phone's size, the Mac app's window and a wide window: onboarding, connecting
#                                      GitHub, managing apps, the app directory, home, chat, routines, tricks, the
#                                      computer and Settings
#   sh scripts/walkthrough.sh build    the imp builds a new app (Notes) and the person saves it, on the page the host
#                                      itself serves, which a preview rebuilds and reloads; Exact's runner cannot drive
#                                      that release build, so agent-browser does (npm i -g agent-browser)
#   sh scripts/walkthrough.sh mac      the native Mac app (on macOS, after setup.sh mac), shot whole with its toolbar and
#                                      safe areas, which no browser shows
#
# The screenshots land in client/.exact/walkthrough/, emptied first; it ends by listing them.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/client/.exact/walkthrough"
parts=${1:-all}

fail() {
	echo "walkthrough: $*" >&2
	exit 1
}

screens() {
	echo "== screens (Chrome)"
	(cd "$root/client" && bun exact.mjs test web walkthrough/walkthrough.test.contract)
}

# The native Mac app with its own toolbar (--chrome platform), each shot the whole window: the test runner's screenshots
# leave the toolbar out, and a page that slides under it is just what a browser never shows.
mac() {
	[ "$(uname -s)" = Darwin ] || fail "the Mac app's walkthrough runs on macOS (after sh scripts/setup.sh mac)"
	echo "== the Mac app (its toolbar included)"
	(cd "$root/client" && bun exact.mjs agent macos --chrome platform --reset-storage --size 1280x800 \
		"clock data" "screenshot $out/mac-onboarding-signin.png window" \
		"tap signin" 'clock until state account.status == "signedIn" within 8000' "clock settle" \
		"screenshot $out/mac-onboarding-first-app.png window" \
		"tap first-app-skip" "clock until state account.introduceApps == false within 10000" "clock settle" \
		"screenshot $out/mac-github.png window" \
		"tap home-entry" "clock settle" "screenshot $out/mac-home.png window" \
		"tap routines-entry" "clock settle" "screenshot $out/mac-routines.png window" \
		"tap tricks-entry" "clock settle" "screenshot $out/mac-tricks.png window" \
		"tap directory-entry" "clock settle" "screenshot $out/mac-directory.png window" \
		"tap tab-settings" "clock settle" "screenshot $out/mac-settings.png window" \
		"tap chat-new" "type composer What can you do?" "type composer key Enter" \
		"clock until state chat.busy == false within 10000" "clock settle" "screenshot $out/mac-chat.png window" \
		"resize 900x700" "clock settle" "screenshot $out/mac-chat-small.png window" \
		"resize 1280x800" "tap tab-github" "clock settle" "tap app-manage" "clock settle" \
		"screenshot $out/mac-github-manage.png window")
}

# The build part's own host, away from the ports a dev host (8787) and the Exact tests (8787, 8799) take.
port=8790
ab="agent-browser --session imp-walkthrough"

# Waits up to $2 seconds for the selector $1 on the build part's page.
await() {
	i=0
	until $ab eval "document.querySelector('$1') ? 1 : 0" 2>/dev/null | grep -q 1; do
		i=$((i + 1))
		[ "$i" -le "$2" ] || fail "build: $1 did not show within $2 s; the host's log is $out/build-host.log"
		sleep 1
	done
}

shot() {
	$ab screenshot "$out/build-$1.png" >/dev/null
	echo "build: $out/build-$1.png"
}

# Shoots the page at the Mac app's window and a phone's size too, then goes back to the wide window.
shots() {
	shot "$1-wide"
	$ab set viewport 900 700 >/dev/null
	shot "$1-mac"
	$ab set viewport 390 844 >/dev/null
	shot "$1-phone"
	$ab set viewport 1280 800 >/dev/null
}

build() {
	echo "== build (agent-browser, the host's own page)"
	command -v agent-browser >/dev/null || fail "build needs agent-browser: npm i -g agent-browser && agent-browser install"
	! curl -s -o /dev/null "http://127.0.0.1:$port/" || fail "something already answers on port $port"
	# The page the host serves is client/dist, as setup.sh builds it: rebuilt so it is this checkout's.
	(cd "$root/client" && API_BASE_URL= bun exact.mjs web-build --out dist)
	data=$(mktemp -d)
	TEST_DATA_DIR="$data" PORT=$port TEST_API_PORT=8798 node "$root/host/scripts/test-host.ts" >"$out/build-host.log" 2>&1 &
	host=$!
	trap 'kill $host 2>/dev/null; $ab close >/dev/null 2>&1; rm -rf "$data"' EXIT
	i=0
	until curl -sf -o /dev/null "http://127.0.0.1:$port/"; do
		i=$((i + 1))
		[ "$i" -le 60 ] || fail "build: the host did not answer within 60 s; its log is $out/build-host.log"
		sleep 1
	done
	$ab open "http://127.0.0.1:$port/" >/dev/null
	$ab set viewport 1280 800 >/dev/null
	await '[data-testid=signin]' 30
	$ab click '[data-testid=signin]' >/dev/null
	await '[data-testid=first-app-ask]' 30
	# The scripted model builds from these words what a real one builds from the person's.
	$ab fill '[data-testid=first-app-ask]' 'app code: notes' >/dev/null
	$ab click '[data-testid=first-app-build]' >/dev/null
	await '[data-testid=side-composer]' 30
	sleep 2
	shots after-build-it
	$ab fill '[data-testid=side-composer]' 'preview app: notes' >/dev/null
	$ab press Enter >/dev/null
	# The host builds the shell with the new app and the page reloads into it: minutes the first time on a machine.
	await '[data-testid=tab-notes]' 600
	sleep 2
	shots preview-ready
	# The page may still reload into the new build after its tab shows, which drops the click: tap again until it opens.
	i=0
	until $ab eval "document.querySelector('#panel-notes [data-testid=preview-save]') ? 1 : 0" | grep -q 1; do
		i=$((i + 1))
		[ "$i" -le 10 ] || fail "build: Notes opened without its preview's Save"
		$ab click '[data-testid=tab-notes]' >/dev/null
		sleep 3
	done
	shots preview
	$ab click '#panel-notes [data-testid=preview-save]' >/dev/null
	await '#panel-notes [data-testid=undo-save]' 30
	shots saved
	$ab click '#panel-notes [data-testid=app-manage]' >/dev/null
	sleep 1
	shot manage-wide
	$ab press Escape >/dev/null
	$ab click '#panel-notes [data-testid=undo-save]' >/dev/null
	sleep 1
	shot undo-wide
}

rm -rf "$out"
mkdir -p "$out"

case $parts in
all)
	screens
	build
	;;
screens) screens ;;
build) build ;;
mac) mac ;;
*) fail "unknown part $parts: screens, build, mac, or none for screens and build" ;;
esac

echo
echo "walkthrough: $(find "$out" -name '*.png' | wc -l | tr -d ' ') screenshots in $out. Look at every one before you hand the change over:"
find "$out" -name '*.png' | sort
