#!/usr/bin/env bash
# Removes the ADI-2-Pi.   sudo ./uninstall.sh [--purge]
#   --purge   also delete the bridge's settings and its service user
set -euo pipefail
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "please run with sudo" >&2; exit 1; }

systemctl disable --now adi2-pi adi2-pi-audio >/dev/null 2>&1 || true
rm -f /etc/systemd/system/adi2-pi.service /etc/systemd/system/adi2-pi-audio.service
# give login sessions Bluetooth audio and the ADI-2 back
rm -f /etc/wireplumber/main.lua.d/51-adi2-pi-sessions.lua /etc/wireplumber/bluetooth.lua.d/51-adi2-pi-sessions.lua \
      /etc/wireplumber/wireplumber.conf.d/51-adi2-pi-sessions.conf
# the receivers' own services back as they were (masked by the installer); Roon's override off
for u in shairport-sync squeezelite snapclient gmediarender raspotify; do systemctl unmask "$u" >/dev/null 2>&1 || true; done
for d in /etc/systemd/system/roonbridge*.service.d; do [ -f "$d/adi2-pi.conf" ] && rm -f "$d/adi2-pi.conf"; done
# Bluetooth device class back to what it was
if [ -f /etc/bluetooth/main.conf.adi2-pi.bak ]; then
  mv /etc/bluetooth/main.conf.adi2-pi.bak /etc/bluetooth/main.conf
  systemctl restart bluetooth >/dev/null 2>&1 || true
fi
rm -f /etc/avahi/services/adi2-pi.service /etc/polkit-1/rules.d/50-adi2-pi.rules /usr/lib/systemd/system-shutdown/adi2-pi-ups-off
systemctl reload avahi-daemon >/dev/null 2>&1 || true
# give PipeWire its MIDI bridge back
rm -f /etc/wireplumber/main.lua.d/51-adi2-pi-no-midi.lua /etc/wireplumber/wireplumber.conf.d/51-adi2-pi-no-midi.conf
if [ -f /etc/systemd/journald.conf.d/50-adi2-pi-volatile.conf ]; then
  rm -f /etc/systemd/journald.conf.d/50-adi2-pi-volatile.conf
  systemctl restart systemd-journald || true
fi
systemctl daemon-reload
rm -rf /opt/adi2-pi /usr/local/share/adi2-pi /var/cache/adi2-pi
if [ "$PURGE" -eq 1 ]; then
  rm -rf /var/lib/adi2-pi
  userdel adi2pi >/dev/null 2>&1 || true
  echo "ADI-2-Pi removed, settings deleted."
else
  echo "ADI-2-Pi removed. Settings kept in /var/lib/adi2-pi (use --purge to delete them)."
fi
echo "Node.js, avahi-daemon, PipeWire, BlueZ and the receivers (shairport-sync, gmediarender, squeezelite, snapclient; nqptp, raspotify, Roon Bridge if added) were left installed, NodeSource's apt repository stays configured – their own services are unmasked but not enabled. Paired Bluetooth devices stay paired (bluetoothctl remove … to forget them)."
