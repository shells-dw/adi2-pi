#!/usr/bin/env bash
# ADI-2-Pi installer for Raspberry Pi OS (Bookworm or Trixie, 64-bit recommended).
# Run from the unpacked folder:   sudo ./install.sh
# Running it again updates the bridge and keeps your settings.
#
# Options:
#   --port N            web/API port (default: 80; if it's taken, the installer asks – or picks 8080
#                       with -y). Run the installer again with --port to change it later.
#   --keep-pipewire-midi   don't stop PipeWire/WirePlumber from grabbing MIDI ports
#   --no-bluetooth      remote control only: no audio service, no Bluetooth, no streaming
#   --no-streaming      no network receivers (AirPlay, UPnP, Squeezelite, Snapcast)
#   --with-airplay2     build AirPlay 2 (shairport-sync + nqptp from GitHub, ~10 min) instead of classic AirPlay;
#                       skipped when the same version is built already. Once built, AirPlay 2 stays
#                       when you run the installer again without this option.
#   --rebuild-airplay2  build AirPlay 2 again even if it's up to date
#   --with-spotify      Spotify Connect: adds raspotify's apt repository (librespot)
#   --with-roon         Roon Bridge: downloads and runs Roon's own installer
#   --journal-ram       keep the system log in RAM only (less SD card writes; logs are lost on reboot)
#   -y, --yes           don't ask anything (scripted installs): a taken port 80 becomes 8080
set -euo pipefail

APP=adi2-pi
DEST=/opt/adi2-pi
DATA=/var/lib/adi2-pi
SVC_USER=adi2pi
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=""
ASSUME_YES=0
KEEP_PW_MIDI=0
JOURNAL_RAM=0
AUDIO=1
STREAMING=1
WITH_AP2=0
REBUILD_AP2=0
WITH_SPOTIFY=0
WITH_ROON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --keep-pipewire-midi) KEEP_PW_MIDI=1; shift ;;
    --journal-ram) JOURNAL_RAM=1; shift ;;
    --no-bluetooth|--no-audio) AUDIO=0; STREAMING=0; shift ;;
    --no-streaming) STREAMING=0; shift ;;
    --with-airplay2) WITH_AP2=1; shift ;;
    --rebuild-airplay2) WITH_AP2=1; REBUILD_AP2=1; shift ;;
    --with-spotify) WITH_SPOTIFY=1; shift ;;
    --with-roon) WITH_ROON=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# output: "[2/6] Step" headings, indented details; colours only on a terminal
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; D=; C=; G=; Y=; R=; N=; fi
STEP=0; TOTAL=0
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$C" "$STEP" "$TOTAL" "$N" "$B" "$*" "$N"; }
say()  { printf '      %s\n' "$*"; }
ok()   { printf '      %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '      %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "please run with sudo: sudo $0 $*"
if [ "$STREAMING" -eq 0 ] && [ $((WITH_AP2 + WITH_SPOTIFY + WITH_ROON)) -gt 0 ]; then
  die "--with-airplay2 / --with-spotify / --with-roon need the streaming receivers – leave out --no-streaming / --no-bluetooth"
fi
[ -f "$SRC/bin/adi2-pi.js" ] || die "run this script from the unpacked adi2-pi folder"

# ---------------------------------------------------------------- system check
. /etc/os-release 2>/dev/null || true
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
printf '%sADI-2-Pi installer%s %s%s · %s%s\n' "$B" "$N" "$D" "${PRETTY_NAME:-unknown system}" "$ARCH" "$N"
case "${VERSION_CODENAME:-}" in
  bookworm|trixie|forky) ;;
  *) warn "tested on Raspberry Pi OS Bookworm and Trixie; this is '${PRETTY_NAME:-unknown}'. Continuing anyway." ;;
esac
[ "$ARCH" = "arm64" ] || warn "architecture is $ARCH – 64-bit Raspberry Pi OS is recommended (needed for some audio services later)."

# PulseAudio installed? Then no streaming receivers (they need PipeWire's PulseAudio server)
PA_KEPT=0
if [ "$AUDIO" -eq 1 ] && [ "$STREAMING" -eq 1 ] && dpkg-query -W -f='${Status}' pulseaudio 2>/dev/null | grep -q 'install ok installed'; then
  # (dpkg -s also succeeds for removed packages that left config files: ask for "installed")
  [ $((WITH_AP2 + WITH_SPOTIFY + WITH_ROON)) -eq 0 ] || die "PulseAudio is installed – the streaming receivers need PipeWire's PulseAudio server instead. Remove pulseaudio first, or install without --with-airplay2 / --with-spotify / --with-roon."
  STREAMING=0; PA_KEPT=1
fi

# ---------------------------------------------------------------- web page port (asked first)
WAS_RUNNING=0
systemctl is-active --quiet "$APP" 2>/dev/null && WAS_RUNNING=1
port_in_use() {
  # a port is "free" if nothing listens, or it's our own (re-install)
  local p="$1"
  ss -Hltn "sport = :$p" 2>/dev/null | grep -q . || return 1
  [ "$WAS_RUNNING" -eq 1 ] && ss -Hltnp "sport = :$p" 2>/dev/null | grep -q 'node' && return 1
  return 0
}
if [ -f "$DATA/settings.json" ]; then
  CUR_PORT="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$DATA/settings.json" 2>/dev/null | grep -oE '[0-9]+$' || true)"
  CUR_PORT="${CUR_PORT:-80}"
else
  CUR_PORT=""
fi
port_user() { ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'users:\(\("[^"]+' | head -n1 | sed 's/.*"//'; }
valid_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
if [ -n "$PORT" ]; then
  # chosen with --port
  valid_port "$PORT" || die "invalid port '$PORT' – use a number from 1 to 65535"
  if port_in_use "$PORT"; then U="$(port_user "$PORT")"; die "port $PORT is already used${U:+ by $U} – choose another one with --port"; fi
else
  PORT="${CUR_PORT:-80}"
  if port_in_use "$PORT"; then
    U="$(port_user "$PORT")"
    FREE=8080; while port_in_use "$FREE"; do FREE=$((FREE + 1)); done
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      warn "port $PORT is already used on this Pi${U:+ (by $U)}"
      while :; do
        printf "      Port for ADI-2-Pi's web page [%s]: " "$FREE"
        read -r ANS || ANS=""
        ANS="${ANS:-$FREE}"
        if ! valid_port "$ANS"; then say "please enter a number from 1 to 65535"
        elif port_in_use "$ANS"; then U2="$(port_user "$ANS")"; say "port $ANS is taken too${U2:+ (by $U2)}"
        else PORT="$ANS"; break; fi
      done
    else
      warn "port $PORT is already used on this Pi${U:+ (by $U)} – using port $FREE"
      PORT="$FREE"
    fi
  fi
fi

# the steps this run takes
TOTAL=4
[ "$AUDIO" -eq 1 ] && TOTAL=$((TOTAL + 1))
[ "$STREAMING" -eq 1 ] && TOTAL=$((TOTAL + 1 + WITH_AP2 + WITH_SPOTIFY + WITH_ROON))

# ---------------------------------------------------------------- packages
step "Installing packages"
[ "$PA_KEPT" -eq 1 ] && warn "PulseAudio is installed – keeping it, so no streaming receivers this time (remove pulseaudio first to get them)."
export DEBIAN_FRONTEND=noninteractive
# apt waits (up to 15 min) while another process holds the package lock; only the dpkg/apt lock
# files are checked (unattended-upgrade-shutdown runs permanently and holds no lock)
if command -v fuser >/dev/null 2>&1 && fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; then
  say "another package update is running – waiting for it to finish…"
fi
PKGS="nodejs avahi-daemon alsa-utils gpiod"   # gpiod: reading the ADI-2 trigger on GPIO3 (optional feature)
# audio: PipeWire + WirePlumber (Bluetooth codecs SBC/SBC-XQ, aptX/aptX HD, LDAC come with
# libspa-0.2-bluetooth), BlueZ, and Python's D-Bus bindings for pairing
[ "$AUDIO" -eq 1 ] && PKGS="$PKGS pipewire pipewire-bin wireplumber libspa-0.2-bluetooth bluez dbus python3 python3-dbus python3-gi rfkill"
# streaming receivers, all from the repos; they play into the audio service through
# PipeWire's PulseAudio server (or the ALSA "pulse" plugin for ALSA-only programs)
if [ "$AUDIO" -eq 1 ] && [ "$STREAMING" -eq 1 ]; then
  PKGS="$PKGS pipewire-pulse libasound2-plugins"
  RX_PKGS="shairport-sync gmediarender gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio gstreamer1.0-libav squeezelite snapclient"
fi
say "updating the package lists…"
apt-get -o DPkg::Lock::Timeout=900 update -qq
say "${D}$PKGS${N}"
apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends $PKGS >/dev/null
# receivers: together if possible, else one by one, so one missing package only costs that receiver
if [ -n "${RX_PKGS:-}" ]; then
  say "streaming receivers: ${D}$RX_PKGS${N}"
  if ! apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends $RX_PKGS >/dev/null 2>&1; then
    for p in $RX_PKGS; do
      apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends "$p" >/dev/null 2>&1 \
        || warn "package $p is not available on this system – the receiver that needs it stays off"
    done
  fi
fi
if [ "$AUDIO" -eq 1 ] && ! command -v dbus-run-session >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends dbus-daemon >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends dbus-bin >/dev/null 2>&1 || true
  command -v dbus-run-session >/dev/null 2>&1 || die "dbus-run-session is missing (package dbus-daemon) – needed for the audio service"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is needed, found $(node -v 2>/dev/null || echo none). Please update Raspberry Pi OS to Bookworm or newer."
ok "packages installed (Node.js $(node -v))"

# ---------------------------------------------------------------- user + files
step "Copying ADI-2-Pi to $DEST"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  say "creating the service user $SVC_USER…"
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin --groups audio "$SVC_USER"
else
  usermod -a -G audio "$SVC_USER"
fi
# GPIO access (trigger: shut down with the ADI-2) and permission to power the Pi off
getent group gpio >/dev/null && usermod -a -G gpio "$SVC_USER"
if [ -d /etc/polkit-1/rules.d ] || command -v pkaction >/dev/null 2>&1; then
  install -d /etc/polkit-1/rules.d
  cat > /etc/polkit-1/rules.d/50-adi2-pi.rules <<'EOF3'
// installed by adi2-pi: the bridge may power the Pi off (Trigger: shut down with the ADI-2, off by default)
polkit.addRule(function (action, subject) {
  if (subject.user == "adi2pi" && (action.id == "org.freedesktop.login1.power-off" ||
      action.id == "org.freedesktop.login1.power-off-multiple-sessions" ||
      action.id == "org.freedesktop.login1.power-off-ignore-inhibit")) return polkit.Result.YES;
});
EOF3
fi
if [ "$AUDIO" -eq 1 ]; then
  getent group bluetooth >/dev/null || groupadd --system bluetooth
  usermod -a -G bluetooth "$SVC_USER"   # BlueZ's D-Bus policy lets this group control Bluetooth
fi

install -d -m 0755 "$DEST"
rm -rf "${DEST:?}/bin" "${DEST:?}/lib" "${DEST:?}/web" "${DEST:?}/audio"
cp -r "$SRC/bin" "$SRC/lib" "$SRC/web" "$SRC/audio" "$DEST/"
cp "$SRC/package.json" "$SRC/README.md" "$DEST/"
[ -d "$SRC/docs" ] && cp -r "$SRC/docs" "$DEST/"
cp "$SRC/uninstall.sh" "$DEST/"
chmod 0755 "$DEST/bin/adi2-pi.js" "$DEST/uninstall.sh" "$DEST/audio/run-audio.sh" "$DEST/lib/bt-helper.py"
chown -R root:root "$DEST"

# ---------------------------------------------------------------- settings (port)
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"

node -e '
  const fs = require("fs"); const f = process.argv[1]; const port = Number(process.argv[2]);
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  if (s.port !== port) { s.port = port; fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2) + "\n"); fs.renameSync(f + ".tmp", f); }
' "$DATA/settings.json" "$PORT"
chown "$SVC_USER:$SVC_USER" "$DATA/settings.json"
chmod 0640 "$DATA/settings.json"
ok "version $(node -p "require('$DEST/package.json').version"), settings in $DATA, web page on port $PORT"

# ---------------------------------------------------------------- PipeWire MIDI
# PipeWire's MIDI bridge subscribes to every ALSA MIDI port, which keeps the ADI-2's MIDI port
# busy for anyone else. Only the ADI-2's port matters here, but WirePlumber can only switch
# the whole MIDI bridge off. Skip with --keep-pipewire-midi if you use MIDI apps through PipeWire.
step "Freeing the ADI-2's MIDI port"
WP_DONE=0
if [ "$KEEP_PW_MIDI" -eq 0 ] && command -v wireplumber >/dev/null 2>&1; then
  WP_VER="$(wireplumber --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -n1 || true)"
  case "$WP_VER" in
    0.4*)
      install -d /etc/wireplumber/main.lua.d
      cat > /etc/wireplumber/main.lua.d/51-adi2-pi-no-midi.lua <<'EOF'
-- installed by adi2-pi: keep PipeWire off ALSA MIDI ports so the bridge can use the ADI-2's port
alsa_monitor.properties["alsa.midi"] = false
EOF
      WP_DONE=1 ;;
    0.5*|[1-9]*)
      install -d /etc/wireplumber/wireplumber.conf.d
      cat > /etc/wireplumber/wireplumber.conf.d/51-adi2-pi-no-midi.conf <<'EOF'
# installed by adi2-pi: keep PipeWire off ALSA MIDI ports so the bridge can use the ADI-2's port
wireplumber.profiles = {
  main = {
    monitor.alsa-midi = disabled
  }
}
EOF
      WP_DONE=1 ;;
  esac
  if [ "$WP_DONE" -eq 1 ]; then
    ok "PipeWire's MIDI bridge switched off"
    # restart running user sessions' WirePlumber so it takes effect now
    for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
      u="$(id -nu "$uid" 2>/dev/null)" || continue
      sudo -u "$u" XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user try-restart wireplumber >/dev/null 2>&1 || true
    done
  fi
fi
[ "$WP_DONE" -eq 1 ] || ok "left as it is"

# ---------------------------------------------------------------- audio service (Bluetooth)
# ADI-2-Pi runs its own PipeWire + WirePlumber as a system service (adi2-pi-audio), using only
# the ADI-2 and Bluetooth. Desktop/login sessions are told to leave both alone, so the two don't
# fight over the Bluetooth adapter.
if [ "$AUDIO" -eq 1 ]; then
  step "Setting up the audio service (Bluetooth)"
  WP_VER="$(wireplumber --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | tail -n1 || true)"
  case "$WP_VER" in
    0.4*) install -d /etc/wireplumber/main.lua.d /etc/wireplumber/bluetooth.lua.d
          install -m 0644 "$SRC/audio/sessions/0.4/main.lua.d/51-adi2-pi-sessions.lua" /etc/wireplumber/main.lua.d/
          install -m 0644 "$SRC/audio/sessions/0.4/bluetooth.lua.d/51-adi2-pi-sessions.lua" /etc/wireplumber/bluetooth.lua.d/ ;;
    *)    install -d /etc/wireplumber/wireplumber.conf.d
          install -m 0644 "$SRC/audio/sessions/0.5/wireplumber.conf.d/51-adi2-pi-sessions.conf" /etc/wireplumber/wireplumber.conf.d/ ;;
  esac
  # running login sessions: restart their WirePlumber so they let go of Bluetooth and the ADI-2
  for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
    u="$(id -nu "$uid" 2>/dev/null)" || continue
    sudo -u "$u" XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user try-restart wireplumber >/dev/null 2>&1 || true
  done
  command -v rfkill >/dev/null 2>&1 && rfkill unblock bluetooth >/dev/null 2>&1 || true
  # Announce the Pi as an audio device (Audio/Video, loudspeaker). iPhones – and some other
  # phones – don't list devices that call themselves a computer, which is BlueZ's default.
  BT_CONF=/etc/bluetooth/main.conf
  BT_CLASS="Class = 0x200414"
  if [ -f "$BT_CONF" ] && ! grep -q "^$BT_CLASS" "$BT_CONF"; then
    [ -f "$BT_CONF.adi2-pi.bak" ] || cp "$BT_CONF" "$BT_CONF.adi2-pi.bak"
    if grep -qE '^[#[:space:]]*Class[[:space:]]*=' "$BT_CONF"; then
      sed -i -E "0,/^[#[:space:]]*Class[[:space:]]*=.*/s//# set by adi2-pi: the Pi is an audio device\\n$BT_CLASS/" "$BT_CONF"
    elif grep -q '^\[General\]' "$BT_CONF"; then
      sed -i "/^\[General\]/a # set by adi2-pi: the Pi is an audio device\\n$BT_CLASS" "$BT_CONF"
    else
      printf '[General]\n# set by adi2-pi: the Pi is an audio device\n%s\n' "$BT_CLASS" >> "$BT_CONF"
    fi
    systemctl restart bluetooth >/dev/null 2>&1 || true
  fi
  systemctl enable --now bluetooth >/dev/null 2>&1 || warn "the Bluetooth service could not be started (is Bluetooth disabled in /boot/firmware/config.txt?)"
  install -m 0644 "$SRC/systemd/adi2-pi-audio.service" /etc/systemd/system/adi2-pi-audio.service
  systemctl daemon-reload
  systemctl enable adi2-pi-audio >/dev/null
  systemctl restart adi2-pi-audio
  ok "adi2-pi-audio installed"
else
  if [ -f /etc/systemd/system/adi2-pi-audio.service ]; then
    say "removing the audio service (--no-bluetooth)…"
    systemctl disable --now adi2-pi-audio >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/adi2-pi-audio.service
  fi
  rm -f /etc/wireplumber/main.lua.d/51-adi2-pi-sessions.lua /etc/wireplumber/bluetooth.lua.d/51-adi2-pi-sessions.lua \
        /etc/wireplumber/wireplumber.conf.d/51-adi2-pi-sessions.conf
fi

# ---------------------------------------------------------------- streaming receivers
# ADI-2-Pi runs the receivers itself (as its own user, named after the bridge), so the packages'
# own services are masked: otherwise there would be two "raspberrypi" AirPlay receivers etc.
mask_unit() {
  local u="$1"
  systemctl list-unit-files "$u.service" >/dev/null 2>&1 || return 0
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  systemctl mask "$u" >/dev/null 2>&1 || true
}
if [ "$STREAMING" -eq 1 ]; then
  step "Setting up the streaming receivers"
  for u in shairport-sync squeezelite snapclient gmediarender raspotify; do mask_unit "$u"; done
  for b in shairport-sync gmediarender squeezelite snapclient; do
    command -v "$b" >/dev/null 2>&1 && ok "$b" || say "${D}$b not installed${N}"
  done
  AP2_BIN=/usr/local/bin/shairport-sync
  AP2_STAMP=/usr/local/share/adi2-pi/airplay2-build   # git commits of the last AirPlay 2 build
  if [ "$WITH_AP2" -eq 0 ] && [ -x "$AP2_BIN" ] && "$AP2_BIN" -V 2>/dev/null | grep -q AirPlay2; then
    ok "AirPlay 2 build found – kept (--with-airplay2 updates it)"
  fi

  # ---- AirPlay 2 (opt-in): build shairport-sync and nqptp from their GitHub sources
  if [ "$WITH_AP2" -eq 1 ]; then
    step "AirPlay 2 (shairport-sync + nqptp from github.com/mikebrady)"
    # the newest commits on GitHub vs. what was built last time
    command -v git >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends git >/dev/null
    NQ_HEAD="$(git ls-remote https://github.com/mikebrady/nqptp.git HEAD 2>/dev/null | cut -c1-12 || true)"
    SP_HEAD="$(git ls-remote https://github.com/mikebrady/shairport-sync.git HEAD 2>/dev/null | cut -c1-12 || true)"
    AP2_NEED=1
    if [ "$REBUILD_AP2" -eq 0 ] && [ -x "$AP2_BIN" ] && "$AP2_BIN" -V 2>/dev/null | grep -q AirPlay2 \
       && command -v nqptp >/dev/null 2>&1; then
      # a build without a stamp file: shairport-sync -V starts with its commit
      if [ ! -f "$AP2_STAMP" ] && [ -n "$SP_HEAD" ] && [ -n "$NQ_HEAD" ] && "$AP2_BIN" -V 2>/dev/null | grep -q "^${SP_HEAD:0:7}"; then
        install -d "$(dirname "$AP2_STAMP")"; echo "nqptp=$NQ_HEAD shairport-sync=$SP_HEAD" > "$AP2_STAMP"
      fi
      if [ -n "$SP_HEAD" ] && [ -n "$NQ_HEAD" ] && [ "$(cat "$AP2_STAMP" 2>/dev/null)" = "nqptp=$NQ_HEAD shairport-sync=$SP_HEAD" ]; then
        AP2_NEED=0; ok "up to date ($("$AP2_BIN" -V 2>/dev/null)) – not rebuilt"
      elif [ -z "$SP_HEAD" ] || [ -z "$NQ_HEAD" ]; then
        AP2_NEED=0; warn "GitHub not reachable – keeping the existing AirPlay 2 build"
      fi
    fi
  fi
  if [ "$WITH_AP2" -eq 1 ] && [ "$AP2_NEED" -eq 1 ]; then
    say "building – this takes a while (about 10 minutes on a Pi 4)…"
    PLIST=libplist-dev; apt-cache show libplist-2.0-dev >/dev/null 2>&1 && PLIST=libplist-2.0-dev
    apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends build-essential git autoconf automake libtool pkg-config \
      libpopt-dev libconfig-dev libasound2-dev libpulse-dev libavahi-client-dev libssl-dev libsoxr-dev \
      "$PLIST" libplist-utils libsodium-dev libavutil-dev libavcodec-dev libavformat-dev uuid-dev libgcrypt20-dev xxd >/dev/null
    B=/var/cache/adi2-pi/build
    rm -rf "$B"; install -d "$B"
    git clone -q --depth 1 https://github.com/mikebrady/nqptp.git "$B/nqptp"
    ( cd "$B/nqptp" && autoreconf -fi >/dev/null 2>&1 && ./configure --with-systemd-startup >/dev/null && make -s >/dev/null && make -s install >/dev/null ) \
      || die "building nqptp failed – see the output above, or install without --with-airplay2"
    systemctl daemon-reload
    systemctl enable nqptp >/dev/null 2>&1 || true
    systemctl restart nqptp >/dev/null 2>&1 || warn "nqptp did not start (AirPlay 2 needs it): journalctl -u nqptp"
    git clone -q --depth 1 https://github.com/mikebrady/shairport-sync.git "$B/shairport-sync"
    # the PulseAudio option's name differs between versions (--with-pa, --with-pulseaudio)
    ( cd "$B/shairport-sync" && autoreconf -fi >/dev/null 2>&1 && \
      PA_OPT="$(./configure --help | grep -oE -- '--with-(pulseaudio|pa)([^-a-z]|$)' | head -n1 | grep -oE -- '--with-[a-z]+' || true)" && \
      ./configure --sysconfdir=/etc --with-alsa $PA_OPT --with-soxr --with-avahi --with-ssl=openssl --with-airplay-2 >/dev/null && \
      make -s -j"$(nproc)" >/dev/null ) || die "building shairport-sync failed – see the output above, or install without --with-airplay2"
    install -m 0755 "$B/shairport-sync/shairport-sync" "$AP2_BIN"
    install -d "$(dirname "$AP2_STAMP")"
    echo "nqptp=$(git -C "$B/nqptp" rev-parse HEAD | cut -c1-12) shairport-sync=$(git -C "$B/shairport-sync" rev-parse HEAD | cut -c1-12)" > "$AP2_STAMP"
    rm -rf "$B"
    ok "AirPlay 2 built: $("$AP2_BIN" -V 2>/dev/null || echo ok)"
  fi

  # ---- Spotify Connect (opt-in): librespot from raspotify's apt repository
  if [ "$WITH_SPOTIFY" -eq 1 ]; then
    step "Spotify Connect (raspotify's apt repository)"
    command -v curl >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends curl >/dev/null
    curl -fsSL https://dtcooper.github.io/raspotify/key.asc -o /usr/share/keyrings/raspotify-archive-keyrings.asc
    chmod 0644 /usr/share/keyrings/raspotify-archive-keyrings.asc
    echo 'deb [signed-by=/usr/share/keyrings/raspotify-archive-keyrings.asc] https://dtcooper.github.io/raspotify raspotify main' > /etc/apt/sources.list.d/raspotify.list
    apt-get -o DPkg::Lock::Timeout=900 update -qq
    apt-get -o DPkg::Lock::Timeout=900 install -y -qq raspotify >/dev/null \
      || die "installing raspotify failed – Spotify Connect needs it; run again without --with-spotify"
    mask_unit raspotify
    command -v librespot >/dev/null 2>&1 && ok "librespot installed" || warn "raspotify installed, but librespot was not found"
  fi

  # ---- Roon Bridge (opt-in): Roon's own installer; its "System Output" plays into ADI-2-Pi
  if [ "$WITH_ROON" -eq 1 ]; then
    step "Roon Bridge"
    case "$(uname -m)" in
      aarch64) RARCH=linuxarmv8 ;; armv7l) RARCH=linuxarmv7hf ;; x86_64) RARCH=linuxx64 ;; *) die "Roon Bridge isn't available for $(uname -m)" ;;
    esac
    if [ ! -d /opt/RoonBridge ]; then
      say "downloading Roon's installer (download.roonlabs.com)…"
      # Roon's installer needs curl and bzip2 (its download is a .tar.bz2)
      apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends curl bzip2 >/dev/null
      install -d /var/cache/adi2-pi
      RURL="download.roonlabs.com/builds/roonbridge-installer-$RARCH.sh"
      curl -fsSL -o "/var/cache/adi2-pi/roonbridge-installer-$RARCH.sh" "https://$RURL" \
        || curl -fsSL -o "/var/cache/adi2-pi/roonbridge-installer-$RARCH.sh" "http://$RURL" \
        || die "could not download Roon's installer from $RURL"
      chmod +x "/var/cache/adi2-pi/roonbridge-installer-$RARCH.sh"
      # Roon's installer asks to confirm
      printf 'y\ny\n' | "/var/cache/adi2-pi/roonbridge-installer-$RARCH.sh" >/dev/null || die "Roon's installer failed"
    fi
    # Roon's "System Output" = ALSA default for Roon: point it at ADI-2-Pi's audio service
    install -d -m 0755 "$DATA/roon-home"
    cat > "$DATA/roon-home/.asoundrc" <<'EOF2'
# written by ADI-2-Pi: Roon Bridge's "System Output" plays through ADI-2-Pi's audio service
pcm.!default { type pulse server "unix:/run/adi2-pi-audio/pulse/native" }
ctl.!default { type pulse server "unix:/run/adi2-pi-audio/pulse/native" }
EOF2
    RUNIT="$(systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -i '^roonbridge.*\.service$' | head -n1)"
    RUNIT="${RUNIT:-roonbridge.service}"
    install -d "/etc/systemd/system/$RUNIT.d"
    printf '# installed by adi2-pi\n[Unit]\nAfter=adi2-pi-audio.service\n[Service]\nEnvironment=HOME=%s/roon-home\n' "$DATA" > "/etc/systemd/system/$RUNIT.d/adi2-pi.conf"
    systemctl daemon-reload
    systemctl restart "$RUNIT" >/dev/null 2>&1 && ok "Roon Bridge running" || warn "Roon Bridge did not start: journalctl -u $RUNIT"
  fi
fi

# ---------------------------------------------------------------- journal in RAM (optional)
step "Starting ADI-2-Pi"
if [ "$JOURNAL_RAM" -eq 1 ]; then
  install -d /etc/systemd/journald.conf.d
  printf '# installed by adi2-pi --journal-ram\n[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' > /etc/systemd/journald.conf.d/50-adi2-pi-volatile.conf
  systemctl restart systemd-journald
  ok "system log kept in RAM only"
fi

# ---------------------------------------------------------------- service + mDNS
install -m 0644 "$SRC/systemd/adi2-pi.service" /etc/systemd/system/adi2-pi.service
[ "$AUDIO" -eq 1 ] || sed -i 's#^\(ExecStart=.*adi2-pi.js.*\)$#\1 --no-audio#' /etc/systemd/system/adi2-pi.service
[ "$AUDIO" -eq 0 ] || [ "$STREAMING" -eq 1 ] || sed -i 's#^\(ExecStart=.*adi2-pi.js.*\)$#\1 --no-streaming#' /etc/systemd/system/adi2-pi.service
sed "s/@PORT@/$PORT/g" "$SRC/systemd/adi2-pi.avahi.xml" > /etc/avahi/services/adi2-pi.service
systemctl daemon-reload
systemctl enable --now avahi-daemon >/dev/null 2>&1 || warn "avahi-daemon could not be started – the bridge won't be found by name"
systemctl reload avahi-daemon >/dev/null 2>&1 || true
systemctl enable "$APP" >/dev/null
systemctl restart "$APP"

sleep 2
if ! systemctl is-active --quiet "$APP"; then
  journalctl -u "$APP" -n 20 --no-pager >&2 || true
  die "the bridge did not start – see the log above"
fi

HOST="$(hostname)"
URL="http://$HOST.local"; [ "$PORT" != 80 ] && URL="$URL:$PORT"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IPURL="http://$IP"; [ "$PORT" != 80 ] && IPURL="$IPURL:$PORT"
ok "running"
if [ "$AUDIO" -eq 1 ] && ! systemctl is-active --quiet adi2-pi-audio; then
  warn "the audio service did not start – see: journalctl -u adi2-pi-audio -n 30"
fi

printf '\n%s✓ ADI-2-Pi is ready.%s\n\n' "$G$B" "$N"
printf '  Open     %s%s%s  (or %s)\n' "$B" "$URL" "$N" "$IPURL"
[ "$AUDIO" -eq 1 ] && printf '  Pair     phones and headphones on the Bluetooth tab\n'
printf '  Log      journalctl -u %s -f\n' "$APP"
printf '  Remove   sudo %s/uninstall.sh\n' "$DEST"
if ! journalctl -u "$APP" -n 20 --no-pager 2>/dev/null | grep -q 'answers on ID'; then
  printf '\n  %sNo ADI-2 answered yet.%s Connect it by USB and set MIDI Control to ON\n' "$Y" "$N"
  printf '  (Device Mode menu on the Pro, Remap Keys/Diag on the DAC).\n'
fi
