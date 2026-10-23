#!/usr/bin/env bash
# Private PipeWire + WirePlumber with stand-ins for the ADI-2 and Bluetooth nodes (for tests).
# Usage: pw-fixture.sh <runtime dir> [config home]  – prints "ready" once the nodes have ports.
# Add a sink later with:   XDG_RUNTIME_DIR=… pw-fixture.sh --node <name> Audio/Sink [props]
# Add a source later with: XDG_RUNTIME_DIR=… pw-fixture.sh --source <name> [props]   (runs until killed)
set -e
if [ "$1" = "--source" ]; then
  exec pw-loopback -n "src-$2" --capture-props="media.class=Audio/Sink node.name=feed_$2" --playback-props="media.class=Audio/Source node.name=$2 audio.position=[FL,FR] $3"
fi
if [ "$1" = "--node" ]; then
  pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=\"$2\" media.class=$3 audio.position=[FL FR] object.linger=true $4 }" >/dev/null
  exit 0
fi
export XDG_RUNTIME_DIR="$1"
[ -n "$2" ] && export XDG_CONFIG_HOME="$2"
exec dbus-run-session -- bash -c '
  pipewire >"$XDG_RUNTIME_DIR/pipewire.log" 2>&1 &
  for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && break; sleep 0.1; done
  wireplumber >"$XDG_RUNTIME_DIR/wireplumber.log" 2>&1 &
  command -v pipewire-pulse >/dev/null && pipewire-pulse >"$XDG_RUNTIME_DIR/pipewire-pulse.log" 2>&1 &
  sleep 1
  mk() { pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=\"$1\" media.class=$2 audio.position=[FL FR] object.linger=true $3 }" >/dev/null; }
  mk "alsa_output.usb-RME_ADI-2_Pro_12345-00.analog-stereo" Audio/Sink "api.alsa.card.name=\"ADI-2 Pro (12345)\" device.api=alsa priority.session=100"
  # a source with two output ports: the playback side of a loopback
  pw-loopback -n adi-in --capture-props="media.class=Audio/Sink node.name=adi_in_feed node.description=feed" \
    --playback-props="media.class=Audio/Source node.name=alsa_input.usb-RME_ADI-2_Pro_12345-00.analog-stereo api.alsa.card.name=ADI-2_Pro device.api=alsa audio.position=[FL,FR]" >/dev/null 2>&1 &
  mk "alsa_output.platform-hdmi.stereo" Audio/Sink "api.alsa.card.name=vc4-hdmi device.api=alsa priority.session=2000"
  for i in $(seq 1 50); do [ "$(pw-link -o | grep -c capture_F)" -ge 2 ] && break; sleep 0.1; done
  echo ready
  wait
'
