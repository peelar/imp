#!/bin/sh
# Installs Imp for macOS, pointed at the host that served this script:
#
#   curl -fsSL https://<your host>/install-mac.sh | sh
#
# It puts Imp.app from the latest GitHub release in ~/Applications and adds a launchd agent that keeps it at the
# latest release: it checks at login and every hour, and when a new release is out it quits Imp, replaces it and opens
# it again. The release is ad-hoc signed (no Apple Developer ID), which macOS opens because curl does not quarantine
# what it downloads. `sh install-mac.sh --uninstall` takes it all away.
#
# The host fills in __IMP_HOST__ and __IMP_REPO__ when it serves this file (host/src/host.ts).
set -eu

HOST="${IMP_HOST:-__IMP_HOST__}"
REPO="${IMP_REPO:-__IMP_REPO__}"
case "$REPO" in */*) ;; *) REPO=peelar/imp ;; esac
APP_ID="dev.imp.app"
APP="$HOME/Applications/Imp.app"
SUPPORT="$HOME/Library/Application Support/Imp"
LABEL="dev.imp.updater"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"

[ "$(uname -s)" = Darwin ] || { echo "Imp for macOS installs on a Mac." >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
	rm -rf "$APP" "$SUPPORT" "$AGENT"
	defaults delete "$APP_ID" 2>/dev/null || true
	echo "Imp is uninstalled."
	exit 0
fi

mkdir -p "$HOME/Applications" "$SUPPORT" "$HOME/Library/LaunchAgents"

# The updater, which launchd runs. It is also what installs the app the first time, below.
cat > "$SUPPORT/update.sh" <<EOF
#!/bin/sh
# Keeps $APP at the latest release of $REPO. Written by install-mac.sh; launchd ($LABEL) runs it.
set -eu
REPO="$REPO"
APP_ID="$APP_ID"
APP="$APP"
SUPPORT="$SUPPORT"
EOF
cat >> "$SUPPORT/update.sh" <<'EOF'
installed=$(cat "$SUPPORT/version" 2>/dev/null || echo none)
# GitHub sends /releases/latest on to the latest release's tag page; that address names the tag.
latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
latest=${latest##*/}
case "$latest" in
	v[0-9]*) ;;
	*) echo "$(date): $REPO has no release yet" >&2; exit 1 ;;
esac
[ "$latest" = "$installed" ] && [ -d "$APP" ] && exit 0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/Imp.zip" "https://github.com/$REPO/releases/download/$latest/Imp-macos.zip"
ditto -x -k "$work/Imp.zip" "$work/unpacked"
[ -d "$work/unpacked/Imp.app" ] || { echo "$(date): Imp-macos.zip of $latest has no Imp.app" >&2; exit 1; }
xattr -dr com.apple.quarantine "$work/unpacked/Imp.app" 2>/dev/null || true
codesign --verify --deep --strict "$work/unpacked/Imp.app"

# A running Imp is quit first and opened again after, so it never runs from a half-replaced bundle. Its settings are
# saved as they change and its chats live on the host, so quitting loses nothing but an unsent draft.
running=false
if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
	running=true
	pkill -f "$APP/Contents/MacOS/"
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
		sleep 1
	done
fi
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$work/unpacked/Imp.app" "$APP"
rm -rf "$APP.old"
echo "$latest" > "$SUPPORT/version"
echo "$(date): installed Imp $latest (was $installed)"
if $running; then open "$APP"; fi
EOF
chmod +x "$SUPPORT/update.sh"

echo "Installing Imp from ${REPO}…"
sh "$SUPPORT/update.sh"

# The app keeps the host's address as its persisted `hostAddress` state (client/app.contract), a JSON string in its
# defaults.
case "$HOST" in
	http://*|https://*) defaults write "$APP_ID" exact.state.hostAddress -string "\"$HOST\"" ;;
esac

cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>/bin/sh</string><string>$SUPPORT/update.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>StartInterval</key><integer>3600</integer>
	<key>StandardOutPath</key><string>$SUPPORT/update.log</string>
	<key>StandardErrorPath</key><string>$SUPPORT/update.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"

echo "Imp $(cat "$SUPPORT/version") is in ~/Applications, connected to $HOST, and keeps itself up to date."
open "$APP"
