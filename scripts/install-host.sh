#!/bin/sh
# Installs the Imp host from the latest GitHub release, on Linux (a systemd user service) or macOS (a launchd agent):
#
#   curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
#
# Everything lives in IMP_HOME (default ~/.imp): releases/<tag> holds each unpacked release, `current` links the one
# that runs, data/ is the host's data and `env` holds the few settings the app does not have. It serves the host on
# your tailnet with `tailscale serve`, and prints the one link to open: everything else, such as the agent's computer,
# is set up in the app. The host then keeps itself at the latest release (host/src/update.ts); IMP_AUTO_UPDATE=0 in
# `env` stops that. Running this again updates and restarts it.
set -eu

REPO="${IMP_REPO:-peelar/imp}"
IMP_HOME="${IMP_HOME:-$HOME/.imp}"
LABEL="dev.imp.host"

fail() { echo "install-host: $*" >&2; exit 1; }
command -v curl >/dev/null || fail "needs curl"
command -v tar >/dev/null || fail "needs tar"
NODE=$(command -v node) || fail "needs Node 24 or newer on PATH (https://nodejs.org)"
major=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || fail "needs Node 24 or newer; $NODE is $("$NODE" --version)"

# GitHub sends /releases/latest on to the latest release's tag page; that address names the tag.
tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
tag=${tag##*/}
case "$tag" in v[0-9]*) ;; *) fail "$REPO has no release yet" ;; esac

mkdir -p "$IMP_HOME/releases" "$IMP_HOME/data"
if [ ! -d "$IMP_HOME/releases/$tag" ]; then
	echo "Downloading Imp ${tag}…"
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	curl -fsSL -o "$work/host.tar.gz" "https://github.com/$REPO/releases/download/$tag/imp-host-$tag.tar.gz"
	mkdir "$work/release"
	tar -xzf "$work/host.tar.gz" -C "$work/release"
	[ "$(cat "$work/release/VERSION")" = "$tag" ] || fail "imp-host-$tag.tar.gz is not release $tag"
	mv "$work/release" "$IMP_HOME/releases/$tag"
fi
ln -sfn "releases/$tag" "$IMP_HOME/current"

if [ ! -f "$IMP_HOME/env" ]; then
	cat > "$IMP_HOME/env" <<'EOF'
# The Imp host's few settings outside the app, read at every start (host/src/server.ts describes each). Everything
# else, such as the agent's computer, is set up in the app.
# The port `tailscale serve` forwards to.
PORT=8787
# The one Tailscale login allowed in, such as you@github; unset lets everyone on the tailnet in.
# OWNER_LOGIN=
# IMP_AUTO_UPDATE=0
EOF
	chmod 600 "$IMP_HOME/env"
fi

# What the service runs: the settings, then the current release's host. A restart after an update starts the release
# `current` links to by then.
cat > "$IMP_HOME/run.sh" <<EOF
#!/bin/sh
set -a
. "$IMP_HOME/env"
set +a
export IMP_HOME="$IMP_HOME" IMP_REPO="$REPO" DATA_DIR="$IMP_HOME/data"
exec "$NODE" "$IMP_HOME/current/host/src/server.ts"
EOF
chmod +x "$IMP_HOME/run.sh"

case "$(uname -s)" in
Linux)
	command -v systemctl >/dev/null || fail "needs systemd to keep the host running; run $IMP_HOME/run.sh under your own, restarting it whenever it exits"
	systemctl --user show-environment >/dev/null 2>&1 ||
		fail "this login has no systemd user session; run sudo loginctl enable-linger $(id -un), log in again and rerun this, or run $IMP_HOME/run.sh under your own supervisor, restarting it whenever it exits"
	unit="$HOME/.config/systemd/user/imp.service"
	mkdir -p "$(dirname "$unit")"
	cat > "$unit" <<EOF
[Unit]
Description=Imp host
After=network-online.target

[Service]
ExecStart=/bin/sh $IMP_HOME/run.sh
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable imp.service >/dev/null
	systemctl --user restart imp.service
	logs="journalctl --user -u imp -f"
	# Without lingering, a user service stops when its user logs out.
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
		echo "To keep Imp running after you log out: sudo loginctl enable-linger $(id -un)"
	fi
	;;
Darwin)
	domain="gui/$(id -u)"
	agent="$HOME/Library/LaunchAgents/$LABEL.plist"
	mkdir -p "$(dirname "$agent")"
	cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>/bin/sh</string><string>$IMP_HOME/run.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$IMP_HOME/host.log</string>
	<key>StandardErrorPath</key><string>$IMP_HOME/host.log</string>
</dict>
</plist>
EOF
	# bootout returns before the running host has exited, and bootstrapping it again before then fails with
	# "Input/output error", so this waits for the old one to go.
	launchctl bootout "$domain/$LABEL" 2>/dev/null || true
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		launchctl print "$domain/$LABEL" >/dev/null 2>&1 || break
		sleep 1
	done
	# A host turned off with `launchctl disable` fails to bootstrap with the same error.
	launchctl enable "$domain/$LABEL"
	# launchd's own error ends with advice to rerun it as root, which cannot help: the host runs as this user.
	started=$(launchctl bootstrap "$domain" "$agent" 2>&1) ||
		fail "launchd would not start the host: $(printf '%s\n' "$started" | head -1). Run this again, without sudo; if it fails the same way, see $IMP_HOME/host.log"
	logs="tail -f $IMP_HOME/host.log"
	;;
*) fail "installs on Linux or macOS" ;;
esac

port=$(sed -n 's/^PORT=//p' "$IMP_HOME/env" | tail -1)
port=${port:-8787}

# Serves the host on the tailnet over HTTPS, unless something else is already served there. Sets `url`, or `note` with
# what is in the way.
serve_on_tailnet() {
	url="" note=""
	ts=$(command -v tailscale || true)
	[ -n "$ts" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
	if [ -z "$ts" ]; then
		note="Install Tailscale on this machine and sign in (https://tailscale.com/download), then run this again."
		return
	fi
	dns=$("$ts" status --json 2>/dev/null | "$NODE" -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
			const status = JSON.parse(s || "{}");
			if (status.BackendState === "Running") console.log(String(status.Self?.DNSName ?? "").replace(/[.]$/, ""));
		});') || true
	if [ -z "$dns" ]; then
		note="Sign in to Tailscale on this machine (tailscale up), then run this again."
		return
	fi
	served=$("$ts" serve status --json 2>/dev/null || echo '{}')
	if printf %s "$served" | grep -q "127.0.0.1:$port\""; then
		url="https://$dns"
	elif printf %s "$served" | grep -q '"Web"'; then
		note="Tailscale already serves something else on this machine. Serve Imp on another port: $ts serve --bg --https=8443 $port"
	elif "$ts" serve --bg "$port" >/dev/null 2>&1; then
		url="https://$dns"
	else
		note="Tailscale would not let this user serve Imp. Allow it once, then run this again: sudo $ts set --operator=$(id -un)"
	fi
}
serve_on_tailnet

echo
echo "Imp $tag is running and keeps itself up to date."
echo
if [ -n "$url" ]; then
	echo "  Open $url to sign in and set up your imp."
	echo
	echo "  The Mac app, if you want it: curl -fsSL $url/install-mac.sh | sh"
else
	echo "  One thing left: $note"
fi
echo "  Logs: $logs"
