# The machine setup: everything Imp installs on the agent's computer, whoever provides it. The host runs it as root on
# Debian or Ubuntu whenever the machine has not run this exact version: the E2B adapter bakes it into its template,
# and the SSH adapter runs it on your own computer. Every step must be safe to run again on a machine that ran an
# older version, because machines are durable and keep what earlier versions installed.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Node runs the machine runtime (agentd and app workers) and is there for the agent. Pinned, so every machine runs the
# same one; /usr/local/bin/node is the path the runtime starts with.
NODE_VERSION=26.13.1

apt-get update -q
apt-get install -y -q --no-install-recommends \
	build-essential ca-certificates curl git jq less procps python3 python3-venv ripgrep unzip xz-utils

case "$(uname -m)" in
	x86_64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) echo "Imp machines need an x86_64 or arm64 CPU, not $(uname -m)" >&2; exit 1 ;;
esac

# Node's own npm and corepack are removed first: unpacked over another version's, their files mix and npm fails. The
# marker says this machine's npm came whole from this Node; a machine set up before it gets Node unpacked again.
NODE_MARKER=/usr/local/lib/node_modules/npm/.imp-node
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ] ||
	[ "$(cat "$NODE_MARKER" 2>/dev/null || true)" != "$NODE_VERSION" ]; then
	rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" |
		tar -xJ -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
	echo "$NODE_VERSION" > "$NODE_MARKER"
fi

# The computer's screen: a virtual display with a light desktop. The agent's programs open their windows there, and
# the owner watches and takes over from the app. The machine runtime starts it (machine/screen.sh); x11vnc serves it
# on a socket only the machine's user can open, never on the network.
apt-get install -y -q --no-install-recommends \
	xvfb x11vnc xfce4 xfce4-terminal dbus-x11 adwaita-icon-theme xdg-utils \
	fonts-dejavu-core fonts-liberation fonts-noto-color-emoji

# A browser for the agent to drive and the owner to watch: Google Chrome, which updates with apt from Google's
# repository. Google builds it for x86_64 only; on arm64, Debian's Chromium where there is one.
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then
	if [ "$arch" = x64 ]; then
		curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
		apt-get install -y -q /tmp/google-chrome.deb
		rm -f /tmp/google-chrome.deb
	elif . /etc/os-release && [ "$ID" = debian ]; then
		apt-get install -y -q --no-install-recommends chromium
	else
		echo "No Chrome for arm64 $ID; the screen has no browser" >&2
	fi
fi

# The agent's commands send their HTTPS requests through agentd's egress proxy, where the host puts the owner's secrets
# on the ones to a secret's hosts (host/src/egress.ts). Chrome would take the proxy from the same environment; this
# policy keeps it connecting directly, so no page it opens gets a secret.
for dir in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed; do
	mkdir -p "$dir"
	echo '{ "ProxyMode": "direct" }' > "$dir/imp-egress.json"
done

# agent-browser, the CLI the agent drives that browser with (machine/agentd.ts points it at the Chrome above, on the
# screen). Its saved flows are the imp's tricks. Pinned, so every machine runs the same one.
AGENT_BROWSER_VERSION=0.43.0
if [ "$(agent-browser --version 2>/dev/null || true)" != "agent-browser $AGENT_BROWSER_VERSION" ]; then
	/usr/local/bin/npm install -g --no-audit --no-fund "agent-browser@$AGENT_BROWSER_VERSION"
fi
