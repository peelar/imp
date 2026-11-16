#!/bin/sh
# Installs Imp for macOS, pointed at the host that served this script:
#
#   curl -fsSL https://<your host>/install-mac.sh | sh
#
# install-host.sh runs it too, from the release it installs, with IMP_HOST and IMP_REPO set, when the host is a Mac.
#
# It puts Imp.app from the latest GitHub release in ~/Applications and adds a launchd agent that keeps it at the
# latest release: it checks at login and every hour. While Imp is closed, a new release replaces it at once. While Imp
# is open, the release waits beside it and Imp offers to restart: Restart quits Imp, and the agent, which watches for
# that, puts the new release in place and opens it. The release is ad-hoc signed (no Apple Developer ID), which macOS
# opens because curl does not quarantine what it downloads. `sh install-mac.sh --uninstall` takes it all away.
#
# `sh install-mac.sh --refresh` only writes the updater and its agent again; each new release's updater runs it, so
# the updater keeps up with the release it installed.
#
# The host fills in __IMP_HOST__ and __IMP_REPO__ when it serves this file (host/src/http.ts).
set -eu

HOST="${IMP_HOST:-__IMP_HOST__}"
REPO="${IMP_REPO:-__IMP_REPO__}"
case "$REPO" in */*) ;; *) REPO=peelar/imp ;; esac
APP_ID="dev.imp.app"
APP="$HOME/Applications/Imp.app"
SUPPORT="$HOME/Library/Application Support/Imp"
# The app's own storage, its `app:/data`, where the updater says a release is ready and the app asks for a restart
# (client/app.ts).
DATA="$HOME/Library/Application Support/exact/$APP_ID/data"
LABEL="dev.imp.updater"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"

[ "$(uname -s)" = Darwin ] || { echo "Imp for macOS installs on a Mac." >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
	rm -rf "$APP" "$SUPPORT" "$AGENT" "$DATA/update.json" "$DATA/restart"
	defaults delete "$APP_ID" 2>/dev/null || true
	echo "Imp is uninstalled."
	exit 0
fi

mkdir -p "$HOME/Applications" "$SUPPORT" "$DATA" "$HOME/Library/LaunchAgents"

# The updater, which launchd runs. It is also what installs the app the first time, below. It is written beside the old
# one and moved over it, because the updater that runs `--refresh` is still reading its own file.
cat > "$SUPPORT/update.sh.new" <<EOF
#!/bin/sh
# Keeps $APP at the latest release of $REPO. Written by install-mac.sh; launchd ($LABEL) runs it every hour, at login,
# and when the app asks for a restart.
set -eu
REPO="$REPO"
APP="$APP"
SUPPORT="$SUPPORT"
DATA="$DATA"
EOF
cat >> "$SUPPORT/update.sh.new" <<'EOF'
STAGED="$SUPPORT/staged"
running() { pgrep -f "$APP/Contents/MacOS/" >/dev/null; }

# The staged release replaces the app, which is not running. The new release's installer then writes this updater
# again, so a change to the updater reaches every Mac with the release that makes it.
apply() {
	[ -d "$STAGED/Imp.app" ] || return 0
	tag=$(cat "$STAGED/version")
	was=$(cat "$SUPPORT/version" 2>/dev/null || echo none)
	rm -rf "$APP.old"
	[ -d "$APP" ] && mv "$APP" "$APP.old"
	mv "$STAGED/Imp.app" "$APP"
	rm -rf "$APP.old" "$STAGED"
	rm -f "$DATA/update.json"
	echo "$tag" > "$SUPPORT/version"
	echo "$(date): installed Imp $tag (was $was)"
	# An installer from before `--refresh` would install everything again, so only one that knows it runs.
	if curl -fsSL -o "$SUPPORT/install-mac.sh" "https://raw.githubusercontent.com/$REPO/$tag/scripts/install-mac.sh" &&
		grep -q -- '"--refresh"' "$SUPPORT/install-mac.sh"; then
		IMP_REPO="$REPO" sh "$SUPPORT/install-mac.sh" --refresh || echo "$(date): the updater of $tag did not install" >&2
	fi
	rm -f "$SUPPORT/install-mac.sh"
}

# Restart in the app writes $DATA/restart and quits; launchd runs this when the file appears. Once the app is gone the
# staged release goes in, and the app opens again, new or not.
if [ -f "$DATA/restart" ]; then
	rm -f "$DATA/restart"
	for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
		running || break
		sleep 1
	done
	# Still running: the quit was cancelled, so the release keeps waiting.
	running && exit 0
	apply
	open "$APP"
	exit 0
fi

installed=$(cat "$SUPPORT/version" 2>/dev/null || echo none)
# GitHub sends /releases/latest on to the latest release's tag page; that address names the tag.
latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
latest=${latest##*/}
case "$latest" in
	v[0-9]*) ;;
	*) echo "$(date): $REPO has no release yet" >&2; exit 1 ;;
esac
if [ "$latest" = "$installed" ] && [ -d "$APP" ]; then
	rm -rf "$STAGED"
	rm -f "$DATA/update.json"
	exit 0
fi

if [ "$(cat "$STAGED/version" 2>/dev/null)" != "$latest" ] || [ ! -d "$STAGED/Imp.app" ]; then
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	curl -fsSL -o "$work/Imp.zip" "https://github.com/$REPO/releases/download/$latest/Imp-macos.zip"
	ditto -x -k "$work/Imp.zip" "$work/unpacked"
	[ -d "$work/unpacked/Imp.app" ] || { echo "$(date): Imp-macos.zip of $latest has no Imp.app" >&2; exit 1; }
	xattr -dr com.apple.quarantine "$work/unpacked/Imp.app" 2>/dev/null || true
	codesign --verify --deep --strict "$work/unpacked/Imp.app"
	rm -rf "$STAGED"
	mkdir -p "$STAGED"
	mv "$work/unpacked/Imp.app" "$STAGED/Imp.app"
	echo "$latest" > "$STAGED/version"
fi

# A running Imp is never quit from here: it shows that the release is ready, and the person restarts when it suits
# them. A closed one is replaced now.
if running; then
	mkdir -p "$DATA"
	printf '{"version":"%s"}\n' "$latest" > "$DATA/update.json"
	exit 0
fi
apply
EOF
chmod +x "$SUPPORT/update.sh.new"
mv "$SUPPORT/update.sh.new" "$SUPPORT/update.sh"

# Restart's request (`WatchPaths`) runs the updater as well as the hour and login.
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>/bin/sh</string><string>$SUPPORT/update.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>StartInterval</key><integer>3600</integer>
	<key>WatchPaths</key><array><string>$DATA/restart</string></array>
	<key>StandardOutPath</key><string>$SUPPORT/update.log</string>
	<key>StandardErrorPath</key><string>$SUPPORT/update.log</string>
</dict>
</plist>
EOF

if [ "${1:-}" = "--refresh" ]; then
	# The agent is not loaded again here: that would stop the updater running this. The new update.sh runs from the
	# agent's next start, and a changed agent loads at the next login.
	echo "$(date): the updater is now the one in this release"
	exit 0
fi

echo "Installing Imp from ${REPO}…"
sh "$SUPPORT/update.sh"

# The app keeps the host's address as its persisted `hostAddress` state (client/app.contract), a JSON string in its
# defaults.
case "$HOST" in
	http://*|https://*) defaults write "$APP_ID" exact.state.hostAddress -string "\"$HOST\"" ;;
esac

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"

echo "Imp $(cat "$SUPPORT/version") is in ~/Applications, connected to $HOST, and keeps itself up to date."
open "$APP"
