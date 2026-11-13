#!/bin/sh
# Installs the Imp host from the latest GitHub release, on Linux (a systemd user service) or macOS (a launchd agent):
#
#   curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
#
# Everything lives in IMP_HOME (default ~/.imp): releases/<tag> holds each unpacked release, `current` links the one
# that runs, data/ is the host's data and `env` its settings. The host then keeps itself at the latest release
# (host/src/update.ts); IMP_AUTO_UPDATE=0 in `env` stops that. Running this again updates and restarts it.
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
# The Imp host's settings, read at every start (host/src/server.ts describes each).
# The agent's computer: "e2b" needs E2B_API_KEY; "local" runs it on this machine, with no isolation.
E2B_API_KEY=
# MACHINE=local
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
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$agent"
	logs="tail -f $IMP_HOME/host.log"
	;;
*) fail "installs on Linux or macOS" ;;
esac

port=$(sed -n 's/^PORT=//p' "$IMP_HOME/env" | tail -1)
cat <<EOF

Imp $tag is running on 127.0.0.1:${port:-8787} and keeps itself up to date.
  Settings: $IMP_HOME/env (then run this again, or restart the service)
  Logs:     $logs

Next:
  1. Put your E2B key in $IMP_HOME/env (or MACHINE=local).
  2. Serve it on your tailnet: tailscale serve --bg ${port:-8787}
  3. Open https://<this machine>.<tailnet>.ts.net and sign in with ChatGPT.
  4. On your Mac: curl -fsSL https://<this machine>.<tailnet>.ts.net/install-mac.sh | sh
EOF
