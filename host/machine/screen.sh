#!/bin/sh
# The computer's screen, started by agentd as the machine's user: a virtual display (Xvfb) with an Xfce desktop, and
# x11vnc serving it on the Unix socket SCREEN_SOCKET, in a directory only this user can open. Starts what is not
# running and is safe to run again; the screen outlives agentd, so a new runtime picks up the same desktop.
set -eu
: "${SCREEN_SOCKET:?}" "${SCREEN_DISPLAY:?}"
for program in Xvfb x11vnc startxfce4 dbus-launch; do
	command -v "$program" >/dev/null || { echo "screen: $program is not installed" >&2; exit 1; }
done
dir=$(dirname "$SCREEN_SOCKET")
mkdir -p "$dir" && chmod 700 "$dir"
log="$dir/screen.log"
me=$(id -u)
number=${SCREEN_DISPLAY#:}
running() { pgrep -u "$me" -f "$1" >/dev/null; }

if ! running "^Xvfb $SCREEN_DISPLAY "; then
	# A display left from a machine that stopped without shutting down.
	rm -f "/tmp/.X$number-lock" "/tmp/.X11-unix/X$number"
	setsid -f Xvfb "$SCREEN_DISPLAY" -screen 0 1280x800x24 -nolisten tcp >>"$log" 2>&1 </dev/null
	i=0
	until [ -S "/tmp/.X11-unix/X$number" ]; do
		i=$((i + 1)); [ $i -le 100 ] || { echo "screen: Xvfb did not start; see $log" >&2; exit 1; }
		sleep 0.1
	done
fi
export DISPLAY="$SCREEN_DISPLAY"
running "^xfce4-session" || setsid -f dbus-launch --exit-with-session startxfce4 >>"$log" 2>&1 </dev/null
if ! running "^x11vnc .*-unixsock $SCREEN_SOCKET" || [ ! -S "$SCREEN_SOCKET" ]; then
	pkill -u "$me" -f "^x11vnc .*-unixsock $SCREEN_SOCKET" || true
	rm -f "$SCREEN_SOCKET"
	setsid -f x11vnc -display "$SCREEN_DISPLAY" -rfbport 0 -unixsock "$SCREEN_SOCKET" -forever -shared -nopw -quiet \
		-o "$log" >/dev/null 2>&1 </dev/null
	i=0
	until [ -S "$SCREEN_SOCKET" ]; do
		i=$((i + 1)); [ $i -le 100 ] || { echo "screen: x11vnc did not start; see $log" >&2; exit 1; }
		sleep 0.1
	done
fi
