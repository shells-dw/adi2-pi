# Installation and updates

## Installer

```sh
git clone https://github.com/shells-dw/adi2-pi.git
cd adi2-pi
git checkout "$(git describe --tags --abbrev=0 origin/main)"   # the latest release
sudo ./install.sh
```

Without the `git checkout` line it installs the current development state. Running the installer
again updates the installation and keeps the settings.

### From a release file

Without git, or for a Pi without internet access: download `adi2-pi-<version>.tar.gz` (and
`.tar.gz.sig`) from [Releases](https://github.com/shells-dw/adi2-pi/releases), copy it to the
Pi (USB stick, `scp`), then:

```sh
tar -xzf adi2-pi-<version>.tar.gz
cd adi2-pi
sudo ./install.sh
```

Without internet access the installer uses the packages already installed and names the
missing ones. Raspberry Pi OS has no Node.js and, depending on the image, not all audio
packages, so a new Pi needs the package sources once. Later updates work offline: System →
*ADI-2-Pi updates* → *Install from a file*, or the commands above.

Checking the signature (optional) with the public key from the repository,
[lib/release-key.pub](../lib/release-key.pub), not from the archive:

```sh
tail -n 1 adi2-pi-<version>.tar.gz.sig | base64 -d > sig.bin
openssl pkeyutl -verify -pubin -inkey release-key.pub -rawin -in adi2-pi-<version>.tar.gz -sigfile sig.bin
```

`Signature Verified Successfully` = the archive is the signed release. Installations do this
check themselves for every update; the first installation trusts where it came from.

What it does:

- Node.js 24 LTS from NodeSource (`deb.nodesource.com`, 64-bit systems); on 32-bit systems, with
  `--system-node` or when NodeSource can't be reached, the system's Node.js (Raspberry Pi OS
  Trixie: 20, Bookworm: 18)
- packages from the system's repositories: avahi, ALSA utilities; on a Pi gpiod and i2c-tools;
  with audio PipeWire, WirePlumber, BlueZ, Python D-Bus; with streaming the receivers
- system user `adi2pi`, services `adi2-pi` (bridge) and `adi2-pi-audio` (a dedicated PipeWire
  instance for the ADI-2 and Bluetooth)
- program in `/opt/adi2-pi`, settings in `/var/lib/adi2-pi`
- mDNS announcement (`_adi2._tcp`, `_http._tcp`)
- prints the address, e.g. `http://raspberrypi.local`

| Option | Effect |
|---|---|
| `--port N` | HTTP/WebSocket port. Default 80; if it's taken, the installer asks (`-y`: first free port from 8080). |
| `--no-bluetooth` | Remote control only: no audio service, Bluetooth or streaming. |
| `--no-streaming` | No network receivers. |
| `--with-airplay2` | Builds shairport-sync with AirPlay 2 and nqptp from source (about 10 min on a Pi 4). An existing build is kept; the installer says when newer sources exist. |
| `--rebuild-airplay2` | Builds AirPlay 2 again from the current sources. |
| `--with-spotify` | Spotify Connect: raspotify's apt repository, librespot. |
| `--with-roon` | Roon Bridge, with Roon's installer. |
| `--with-ups` | Switches I²C on and looks for a Waveshare UPS HAT; I²C stays on when one answers. |
| `--no-ups` | Doesn't look for a UPS HAT. |
| `--dedicated` / `--shared` | Not a Pi: answers the question below without asking. |
| `--auto-updates` / `--no-auto-updates` | System updates on *install* / *off* (see below). |
| `--keep-pipewire-midi` | Leaves the desktop session's PipeWire MIDI bridge on (it then blocks the ADI-2's MIDI port while someone is logged in). |
| `--journal-ram` | System journal in RAM only. |
| `--system-node` | The system's Node.js instead of NodeSource; without it, a later run switches back to Node.js 24. |
| `--same-options` | The previous run's options (`/etc/adi2-pi/install-options`) plus the ones given. |
| `--offline` | No package sources; everything needed must be installed. Chosen by itself when they can't be reached. |
| `-y`, `--yes` | No questions. |

Uninstall: `sudo /opt/adi2-pi/uninstall.sh` (`--purge` also removes the settings and the user).

## Other Linux systems

`install.sh` runs on Debian 12+, Ubuntu 22.04+ and Linux Mint with systemd, on x86_64 or ARM. On a
computer that isn't a Raspberry Pi it asks once whether the computer is used only for the ADI-2
(default: yes without a desktop, no with one; the answer is kept):

- **Yes** (`--dedicated`): full installation, as on a Pi.
- **No** (`--shared`): remote control only. The desktop keeps the ADI-2 as its sound card and its
  Bluetooth; ADI-2-Pi never shuts the computer down or restarts it and installs no system updates.

GPIO trigger and UPS HAT need a Raspberry Pi.

Other distributions (Fedora, Arch …): remote control only, set up by hand.

1. Node.js 18 or newer, then:
   ```sh
   git clone https://github.com/shells-dw/adi2-pi.git
   git -C adi2-pi checkout "$(git -C adi2-pi describe --tags --abbrev=0 origin/main)"
   node adi2-pi/bin/adi2-pi.js --no-audio --shared --port 8080 --data ~/.local/share/adi2-pi
   ```
   The user needs to be in the `audio` group.
2. With PipeWire: `/etc/wireplumber/wireplumber.conf.d/51-adi2-pi-no-midi.conf` containing
   `wireplumber.profiles = { main = { monitor.alsa-midi = disabled } }`, then
   `systemctl --user restart wireplumber`.
3. Start with the computer, `~/.config/systemd/user/adi2-pi.service`:
   ```ini
   [Service]
   ExecStart=/usr/bin/node %h/adi2-pi/bin/adi2-pi.js --no-audio --shared --port 8080 --data %h/.local/share/adi2-pi
   Restart=on-failure

   [Install]
   WantedBy=default.target
   ```
   `systemctl --user enable --now adi2-pi` (and `sudo loginctl enable-linger $USER` to start
   without a login). Updates: unpack a new release over the folder.

## ADI-2-Pi updates

System → *ADI-2-Pi updates*. Only releases signed with the release key of the installed version
are installed.

- *Check for updates daily* (off by default) or *Check now* asks GitHub for the latest release;
  a newer one is shown with a link (and as a Home Assistant update entity). Nothing is downloaded.
- *Download and install*: the Pi downloads `adi2-pi-<version>.tar.gz` and its `.sig` and installs
  them.
- *Install updates automatically* (off by default): a newer release is installed once nothing
  plays on the Pi (checked again every 30 min). A version that failed is left to the user.
- *Install from a file*: choose the `.tar.gz` and its `.sig` together; the Pi doesn't go online.
- By hand: unpack on the Pi, `sudo ./install.sh --same-options`.

A root service (`adi2-pi-self-update.service`) checks the signature again and runs the release's
`install.sh -y --same-options`; the page reloads with the new version. Log:
`/var/log/adi2-pi/self-update.log`. Without internet access the installer uses the installed
packages and stops if one the new version needs is missing.

## System updates

System → *System updates*: all packages of the Pi's apt sources (Raspberry Pi OS, Debian,
NodeSource, the receivers' repositories), like `sudo apt full-upgrade`.

| *Automatically* | |
|---|---|
| off (default) | *Check now* and *Install updates* when asked |
| check and show | 5 min after each start, then every 24 h; available updates are listed (also on the Overview) |
| install | checks and installs 5 min after each start, then every 24 h |

apt's own daily timers often miss a Pi that's only on with the ADI-2; this runs after each start.

- Security updates are marked. Installation is non-interactive; changed configuration files are
  kept (the new default goes next to them as `.dpkg-dist`).
- No automatic restart: after a kernel update the card offers *Restart the Pi*. After a Node.js
  update ADI-2-Pi restarts itself.
- The Pi doesn't shut down while updates install.
- ADI-2-Pi runs unprivileged; two root services (`adi2-pi-os-check`, `adi2-pi-os-upgrade`) and a
  polkit rule let it start them and restart the Pi, nothing else. Logs in `/var/log/adi2-pi/`.
- With an access key, only clients with the key can start updates.

## Network access and files

The web interface loads nothing from outside. ADI-2-Pi connects out only for: the MQTT server
(when set), GitHub for the update check and downloads (when asked or switched on), and the
Headphone EQ Generator's *Check for updated headphone data* (`api.github.com`,
`raw.githubusercontent.com`). The installer uses the package sources, NodeSource and, for
`--with-*`, GitHub, raspotify or Roon's server.

Written on the Pi: `/var/lib/adi2-pi/settings.json` (on change; scenes, actions, access key hash,
MQTT password), downloaded headphone data in `/var/lib/adi2-pi/eq`, the audio service's state in
`/var/lib/adi2-pi/audio-state`, the AirPlay metadata pipe, and with Roon its ALSA configuration.
The unit's settings are not stored on the Pi.
