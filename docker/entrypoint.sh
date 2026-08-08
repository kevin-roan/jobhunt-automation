#!/usr/bin/env bash
#
# Container entrypoint: brings up a virtual desktop, then execs the app.
#
# Attended mode needs a real, visible browser window — the user signs in to
# LinkedIn and Indeed by hand, once, and the on-disk profile keeps the session
# for every later run. On a desktop install that window lands on the user's own
# screen. In a container there is no screen, so BrowserManager.displayAvailable()
# returns false and the whole feature switches itself off.
#
# This script supplies the missing screen:
#
#   Xvfb       an X server that renders into memory instead of to a monitor
#   fluxbox    a window manager, so Chromium's window can be moved, resized and
#              focused, and so dialogs (file pickers, permission prompts) behave
#   x11vnc     exports that X display over VNC, bound to loopback INSIDE the
#              container — it is never published directly
#   websockify serves noVNC over HTTP on NOVNC_PORT, which is what the dashboard
#              embeds, so the user drives the browser from the same browser tab
#              the dashboard is in
#
# Everything stays on this host: the VNC transport never leaves the container's
# loopback interface, and the only published port is the noVNC one, which
# docker-compose binds to 127.0.0.1 by default.
#
# Set VIRTUAL_DISPLAY=0 to skip all of it and run headless, exactly as before.
#
set -Eeuo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

VIRTUAL_DISPLAY="${VIRTUAL_DISPLAY:-1}"

if [[ "$VIRTUAL_DISPLAY" != "1" ]]; then
  log 'VIRTUAL_DISPLAY=0 — no virtual screen; attended mode will stay unavailable.'
  unset DISPLAY
  exec "$@"
fi

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

# Every child is tracked so a stop signal takes the whole desktop down with the
# app rather than leaving an orphaned X server holding the profile directory.
PIDS=()

shutdown() {
  trap - TERM INT EXIT
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap shutdown TERM INT EXIT

# --------------------------------------------------------------------------
# X server
#
# -nolisten tcp keeps the display off the network entirely: x11vnc reaches it
# through the unix socket, so nothing else can. -ac then costs nothing, and
# saves maintaining an Xauthority for processes that all run as this same user.
# --------------------------------------------------------------------------
log "starting Xvfb on ${DISPLAY} at ${SCREEN_GEOMETRY}"
Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
PIDS+=("$!")

# Chromium connects to the display immediately on launch, so the app must not
# start before the server is accepting connections.
for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log 'Xvfb did not come up; dumping its log and continuing headless'
  cat /tmp/xvfb.log >&2 || true
  unset DISPLAY
  exec "$@"
fi
log 'Xvfb is up'

# --------------------------------------------------------------------------
# Window manager. Without one, Chromium maps a bare override-redirect window:
# it renders, but it cannot be focused or resized, and modal dialogs stack
# invisibly on top of each other — which breaks exactly the manual logins this
# exists for.
# --------------------------------------------------------------------------
log 'starting fluxbox'
fluxbox >/tmp/fluxbox.log 2>&1 &
PIDS+=("$!")

# --------------------------------------------------------------------------
# VNC. Bound to loopback: the only way in is through websockify below, which is
# the port compose publishes. A password is used when one is supplied.
# --------------------------------------------------------------------------
X11VNC_ARGS=(
  -display "$DISPLAY"
  -rfbport "$VNC_PORT"
  -localhost
  -forever          # keep serving after a viewer disconnects
  -shared           # the dashboard tab and a native viewer can both attach
  -noxdamage        # XDAMAGE is unreliable against Xvfb and drops repaints
  -quiet
)
if [[ -n "${VNC_PASSWORD:-}" ]]; then
  # `rm:` makes x11vnc read the file once and delete it, so the password does
  # not sit in the container filesystem for the process's lifetime.
  umask 077
  printf '%s\n' "$VNC_PASSWORD" > /tmp/.vncpasswd
  X11VNC_ARGS+=(-passwdfile "rm:/tmp/.vncpasswd")
  log 'x11vnc will require the configured password'
else
  X11VNC_ARGS+=(-nopw)
fi

log "starting x11vnc on 127.0.0.1:${VNC_PORT}"
x11vnc "${X11VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &
PIDS+=("$!")

# --------------------------------------------------------------------------
# noVNC over HTTP. This is what the dashboard iframes, so the user never needs
# a VNC client — the attended browser appears inside the dashboard itself.
# --------------------------------------------------------------------------
NOVNC_WEB=/usr/share/novnc
if [[ -d "$NOVNC_WEB" ]]; then
  # Debian's novnc ships vnc.html but no index.html; the dashboard links to
  # vnc.html directly, and this makes a bare host:port work too.
  [[ -e "$NOVNC_WEB/index.html" ]] || ln -sf vnc.html "$NOVNC_WEB/index.html" 2>/dev/null || true
  log "starting noVNC on 0.0.0.0:${NOVNC_PORT}"
  websockify --web "$NOVNC_WEB" "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" \
    >/tmp/novnc.log 2>&1 &
  PIDS+=("$!")
else
  log "noVNC assets missing at ${NOVNC_WEB}; the VNC port still works with a native viewer"
fi

log "virtual desktop ready — attended browsing is available on ${DISPLAY}"

# The app is the foreground process so its exit status is the container's, and
# so signals reach it through tini.
"$@" &
APP_PID=$!
PIDS+=("$APP_PID")
wait "$APP_PID"
