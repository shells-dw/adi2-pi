#!/usr/bin/env bash
# ADI-2-Pi audio: PipeWire + WirePlumber + PipeWire's PulseAudio server, for Bluetooth and the
# streaming receivers (they play through the PulseAudio socket $XDG_RUNTIME_DIR/pulse/native).
# Started by adi2-pi-audio.service inside its own D-Bus session (dbus-run-session), which
# WirePlumber needs. Exits when any of them stops, so systemd restarts all of them.
set -u
: "${XDG_RUNTIME_DIR:?}"
pipewire &
PW=$!
for _ in $(seq 1 100); do [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && break; sleep 0.05; done
wireplumber &
WP=$!
PIDS="$PW $WP"
if command -v pipewire-pulse >/dev/null 2>&1; then
  pipewire-pulse &
  PIDS="$PIDS $!"
fi
trap 'kill $PIDS 2>/dev/null; wait; exit 0' TERM INT
# shellcheck disable=SC2086
wait -n $PIDS
code=$?
# shellcheck disable=SC2086
kill $PIDS 2>/dev/null
wait
exit $(( code == 0 ? 1 : code ))
