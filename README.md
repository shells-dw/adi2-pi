<img src="docs/logo/wordmark-light.png" alt="ADI-2-Pi" width="420">

Network remote and audio bridge for RME ADI-2 series converters (ADI-2 DAC, ADI-2 Pro / Pro EX,
ADI-2/4 Pro SE / Pro EX). Runs on a Raspberry Pi connected to the unit by USB.

- **Web interface:** all output, input and device settings, parametric EQ with a draggable curve,
  bass/treble, loudness, setups, the unit's 20 EQ presets (edit, store, load).
- **API:** WebSocket and HTTP, used by the web interface, a Stream Deck plugin and other clients.
  See [docs/API.md](docs/API.md). Reference client: [clients/adi2pi-client.js](clients/adi2pi-client.js).
- **Volume safety:** volume limit per output, rise-speed limit, linked volumes, start volume
  (louder outputs are turned down when the unit is switched on).
- **Volume from the sender:** the volume slider of AirPlay and Spotify Connect senders sets the
  ADI-2's volume; the stream plays at full level.
- **Scenes, actions, sleep timer:** named sets of values; actions apply them on events (Bluetooth
  device connects, playback starts or stops, time of day, unit switched on); sleep timer with
  fade-out and mute.
- **Input priority** (ADI-2 Pro models): outputs play the first input of a list that has a signal,
  e.g. AES, or Analog while AES has none.
- **Backup and restore** of the unit's settings, EQ presets, setup names and ADI-2-Pi's settings.
- **Optional access key** for the API and the web interface.
- **MQTT** with Home Assistant discovery.
- **Bluetooth (A2DP), both directions** on the Pi's built-in adapter: phones play into the ADI-2;
  Bluetooth headphones/speakers receive Line Out or Phones 3/4 after its DSP. Codecs: LDAC,
  aptX HD, aptX, SBC-XQ, SBC.
- **Network receivers:** AirPlay (optionally AirPlay 2), UPnP/DLNA, Squeezelite, Snapcast;
  Spotify Connect and Roon Bridge as install options.
- **Headphone EQ Generator** at `/eq/`: fits a parametric EQ for the ADI-2 or TotalMix FX Room
  EQ to oratory1990's measurements and writes it to an output. See [docs/eq-generator.md](docs/eq-generator.md).
- **Shutdown with the ADI-2 (optional):** shuts the Pi down when the ADI-2's USB connection
  disappears, or when its 12 V Trigger Out switches off (wired to GPIO3; Pi 4/3 also start again).
- Works offline. Outgoing connections made by ADI-2-Pi itself: the optional headphone data
  update, the optional update check and release download, the MQTT server when MQTT is switched
  on, and apt's package sources for system updates when asked for or switched on.

## Requirements

- Raspberry Pi with Raspberry Pi OS Bookworm or Trixie, Lite or Desktop, 64-bit recommended.
  Tested on a Raspberry Pi 4. The trigger wake-up does not work on a Pi 5.
- ADI-2 connected by USB, **MIDI Control = ON** (Pro models: SETUP – Options – Device Mode;
  DAC: Remap Keys / Diag).
- For Bluetooth and streaming: the ADI-2 in USB **stereo** mode (default).

## Installation

```sh
git clone https://github.com/shells-dw/adi2-pi.git
cd adi2-pi
sudo ./install.sh
```

or download a release archive, unpack it and run `sudo ./install.sh` in the folder.

The installer:

- installs Node.js 24 LTS from NodeSource's apt repository (`deb.nodesource.com`; 64-bit systems).
  On 32-bit systems, with `--system-node`, or when the repository can't be reached, Raspberry Pi
  OS's Node.js is used (Trixie: 20, Bookworm: 18)
- installs the other packages from the Raspberry Pi OS repositories (avahi, ALSA utilities, gpiod,
  i2c-tools; with audio: PipeWire, WirePlumber, BlueZ, Python D-Bus bindings; with streaming: the
  receivers)
- creates the system user `adi2pi` and the services `adi2-pi` (bridge) and `adi2-pi-audio`
  (a dedicated PipeWire instance for the ADI-2 and Bluetooth)
- copies the program to `/opt/adi2-pi`; settings are kept in `/var/lib/adi2-pi`
- announces the bridge via mDNS (`_adi2._tcp`, `_http._tcp`)
- looks for a Waveshare UPS HAT on I²C and, if one answers, keeps I²C switched on (see
  [UPS HAT](#ups-hat))
- prints the address, e.g. `http://raspberrypi.local`

Running `install.sh` again updates the installation and keeps the settings. Options can be added
in a later run.

| Option | Effect |
|---|---|
| `--port N` | HTTP/WebSocket port. Default 80; if 80 is in use, the installer asks for another port (`-y`: first free port from 8080). |
| `--no-bluetooth` | Remote control only: no audio service, no Bluetooth, no streaming. |
| `--no-streaming` | No network receivers. |
| `--with-airplay2` | Builds shairport-sync with AirPlay 2 and nqptp from source (github.com/mikebrady), about 10 minutes on a Pi 4. An existing AirPlay 2 build is kept, with or without the option; the installer says when GitHub has newer sources. |
| `--rebuild-airplay2` | Builds AirPlay 2 again from the current sources on GitHub. |
| `--with-spotify` | Spotify Connect: adds the raspotify apt repository and installs librespot. |
| `--with-roon` | Roon Bridge: runs Roon's installer. |
| `--keep-pipewire-midi` | Leaves the MIDI bridge of the desktop session's PipeWire enabled (see [MIDI port](#midi-port)). |
| `--journal-ram` | Keeps the system journal in RAM only. |
| `--with-ups` | Switches I²C on and looks for a Waveshare UPS HAT; I²C stays on when one answers (see [UPS HAT](#ups-hat)). |
| `--no-ups` | Doesn't look for a UPS HAT at all. |
| `--system-node` | Node.js from Raspberry Pi OS instead of NodeSource; removes NodeSource's repository if present. Without the option, a later run switches to Node.js 24 again. |
| `--auto-updates` | Sets System → *System updates* to *install*: all updates 5 minutes after each start of the Pi, then every 24 hours (see [System updates](#system-updates)). |
| `--no-auto-updates` | Sets it to *off* (updates only when asked for). |
| `--same-options` | The options of the previous run (saved in `/etc/adi2-pi/install-options`) plus the ones given. |
| `--offline` | Doesn't use the package sources; everything needed must be installed. Chosen by itself when they can't be reached. |
| `-y`, `--yes` | No questions. |

Uninstall: `sudo /opt/adi2-pi/uninstall.sh` (`--purge` also removes settings and the service user).

## Web interface

| Tab | Content |
|---|---|
| Overview | *Signal path*: the unit (model, mode, clock, sample rate, balanced phones), its sources with AES/SPDIF signal and what the Pi plays, each output with the source it plays (selectable; marked *auto* when input priority set it, *Pi playing* while it is on USB for the Pi), volume and level at 0 dBFS; scenes that match the unit, active headphone profiles, sleep timer and waiting actions, UPS, updates. Below: volume, Mute/Dim, quick levels, profile, Ref Level and DSP switches per output |
| Line Out, Phones 1/2, Phones 3/4 | Level, EQ, bass/treble, loudness, settings of the output |
| Input | Analog input (Pro models) |
| EQ Presets | The unit's 20 EQ presets: editor, apply to an output, store, load |
| Device | Device settings, setups |
| Pi Playback | Title and artist of what plays, sources played by the Pi, sample rate, switching outputs to USB |
| Bluetooth | Pairing phones, pairing and routing headphones/speakers |
| Streaming | Network receivers on/off, server addresses |
| Scenes & Actions | Sleep timer, input priority, headphone profiles, scenes, actions |
| Headphone EQ | Headphone EQ Generator |
| System | Bridge name, language; *Volume*: per output the highest volume, the level at start and the quick levels, rise speed, linked outputs; volume from the sender, shutdown with the ADI-2, UPS HAT, access key, MQTT, ADI-2-Pi updates, system updates, backup/restore, Debug tab switch |
| Debug | Shown when enabled under System (per browser): changes sent to the unit with their origin, parameters not in the schema, MIDI monitor, connection log, parameter table, status recorder |

Device, Pi Playback, Bluetooth, Streaming, Scenes & Actions and System are lists of sections: on a
wide screen with a section list (and search) beside them, on a phone as a grouped list with the
current value of each section; a section opens full screen. Explanations sit behind the ⓘ next to
a section's title (on hover with a mouse, on tap otherwise). Settings on the System tab are saved as
they are changed; the access key, UPS HAT and MQTT settings have their own Save button.

Controls: volume knobs react to dragging (Shift = fine), scroll wheel and arrow keys;
double-click mutes. EQ curve points are dragged for frequency and gain, the scroll wheel changes
Q, double-click resets the gain.

Parameters the connected unit does not report (e.g. Phones 1/2 Mute on the ADI-2 Pro EX) are not
shown.

**Language:** System → *Language*, per browser; without a choice the page follows the browser's
language. English and German are included; other languages are one JSON file each, see
[web/lang/README.md](web/lang/README.md). The bridge's own messages and the Headphone EQ Generator
are English.

## Operation

### Communication with the unit

- SysEx over the unit's USB-MIDI port (`/dev/snd/midiC*D0`), see [Protocol](#protocol).
- On connect, the bridge requests all settings, setup names and the 20 EQ presets. Changes made
  on the unit arrive as they happen.
- The unit does not echo values received over MIDI. The bridge applies a change to its model,
  broadcasts it, and reads the unit back 1.5 s after the last change. A full read runs every 30 s.
- The unit sends a status message about once per second. If none arrives for 4 s, the unit is
  treated as not answering (MIDI Control off); changes are refused until it answers again.
- Only one program can open the MIDI port at a time.

### Sample rate

On USB, the host sets the ADI-2's sample rate. With the audio service, the rate follows the
playing source or is fixed on the Pi Playback tab (PipeWire `clock.force-rate`). Without the
audio service (`--no-bluetooth`), the Device tab sets it by opening the playback device at the
selected rate (`aplay`).

### Bluetooth

- **Phones → ADI-2:** *Make visible* opens a 2-minute pairing window; pairing is refused outside
  it. Paired devices reconnect automatically and are trusted for audio profiles (A2DP, AVRCP)
  only. Playback reaches every output whose Source is Auto or USB.
- **ADI-2 → headphones/speakers:** *Search*, then *Pair*. Source options:
  - *Line Out* or *Phones 3/4, after its DSP:* while a Bluetooth output is connected, the
    output's Loopback is set to "Post FX −6 dB" (USB record 1/2 carries the output after EQ,
    bass/treble and crossfeed, before volume). The previous Loopback value is restored on
    disconnect.
  - *Analog input*, or *off*.
  - *Level* (default +6 dB) is applied on the Pi and compensates the −6 dB of the Loopback.
- Codecs to headphones: LDAC, aptX HD, aptX, SBC-XQ, SBC. From phones: aptX HD, aptX, SBC-XQ,
  SBC (no AAC in Raspberry Pi OS's PipeWire). Rate: 44.1 or 48 kHz.
- The Pi 4's Bluetooth shares the antenna with 2.4 GHz Wi-Fi; use Ethernet or 5 GHz Wi-Fi for LDAC.
- The installer sets the Bluetooth device class to audio (`Class = 0x200414` in
  `/etc/bluetooth/main.conf`, backup kept) so that phones list the Pi, and configures desktop
  sessions on the Pi to leave Bluetooth audio and the ADI-2 to `adi2-pi-audio`.

### Network receivers

| Receiver | Clients | Package |
|---|---|---|
| AirPlay | iOS, macOS, AirPlay apps | `shairport-sync` (Raspberry Pi OS); AirPlay 2 with `--with-airplay2` |
| UPnP / DLNA renderer | UPnP control points (e.g. BubbleUPnP, Linn Kazoo) | `gmediarender` |
| Squeezelite | Lyrion Music Server | `squeezelite` |
| Snapcast client | Snapcast server | `snapclient` |
| Spotify Connect | Spotify apps | `librespot` from raspotify, `--with-spotify` |
| Roon Bridge | Roon ("System Output" of the Pi) | Roon's installer, `--with-roon` |

Receivers are started by the bridge as child processes under the `adi2pi` user, use the bridge
name, and play into `adi2-pi-audio` through its PulseAudio socket or the ALSA device `adi2pi`.
The packages' own systemd services are masked (`uninstall.sh` unmasks them). Squeezelite and
Snapcast find their server via mDNS unless an address is set. Roon Bridge runs as its own
service; only its status is shown.

### Pi Playback

Applies to audio played by the Pi (Bluetooth inputs, network receivers); settings inside the
ADI-2 are not affected.

- **Several sources:** *newest* (default) – the most recently started source is heard, the others
  are muted until it stops; *Switch to this* selects another one. *Mix* plays all.
- **Sample rate:** *Follow what plays* (default) or a fixed rate from 44.1 to 192 kHz; with a
  fixed rate, PipeWire resamples all sources.
- **USB while the Pi plays** (Line Out, Phones 3/4; default on): when a source starts, the
  output's Source is set to USB 1/2; 10 s after the last source stops, the previous Source is
  restored. An output whose Source is changed manually during playback is not restored. The
  previous value is stored in the settings and survives a restart.
- A connected Snapcast client counts as playing while connected.

### Shutdown with the ADI-2

System → *Shut down with the ADI-2*. The Pi shuts down after the ADI-2 has been off for a set time
(10 s, 30 s, 1 min, 5 min). The ADI-2 is detected as off in one of two ways (*Detect standby by*):

| | USB connection | 12 V trigger on a GPIO |
|---|---|---|
| Off when | the ADI-2's USB MIDI port disappears or the unit stops answering (standby, power off, cable unplugged, MIDI Control off) | Trigger Out is off |
| Wiring | none | optocoupler, see below |
| Pi starts again with the ADI-2 | no | Pi 4 and 3, trigger on GPIO3 only |

By default the Pi only shuts down after it has seen the ADI-2 on: a Pi started while the ADI-2 is
off stays on. *Started with the ADI-2 off* changes that: the Pi shuts down 5, 15, 30 or 60 minutes
after it started if the ADI-2 hasn't been switched on by then (for example when power returns after
an outage, or after a reboot). Only a start together with the Pi counts – restarting ADI-2-Pi later
(e.g. by running the installer) doesn't. A running countdown can be cancelled on the System tab.

A package update in progress (dpkg, apt, unattended-upgrades, [System updates](#system-updates))
is finished before the Pi shuts down; after 30 minutes it shuts down anyway.

#### 12 V trigger

*Trigger input* selects the GPIO: GPIO3 (pin 5, default) or GPIO4, 17, 22, 23, 24, 25, 27. Only
GPIO3 also starts a halted Pi. With I²C switched on (a UPS HAT), GPIO3 is SCL and can't be used:
choose another GPIO, which uses the Pi's internal pull-up; the Pi then shuts down with the ADI-2
but doesn't start with it.

The ADI-2's Trigger Out (3.5 mm mono jack; tip = supply voltage, 9–16 V; ring and sleeve =
ground) is on while the unit is on. Connected to GPIO3 through an optocoupler, the bridge shuts
the Pi down after the trigger has been off for the set time. A halted Raspberry Pi 4 or 3 boots when GPIO3 is pulled low, so switching the ADI-2 on
starts the Pi (bootloader defaults `WAKE_ON_GPIO=1`, `POWER_OFF_ON_HALT=0`; not on the Pi 5).

```
ADI-2 Trigger Out                          Raspberry Pi
 tip  ──[ 2.2 kΩ ]──►|── LED  ┐  PC817  ┌── collector ── GPIO3 (pin 5)
 sleeve ──────────────────────┘         └── emitter  ── GND   (pin 6)
        (1N4148 in reverse across the LED)
```

Alternatively a PC817 optocoupler module with 12 V input: IN+ to tip, IN− to sleeve, OUT to
GPIO3, GND to GND, output VCC to 3.3 V (pin 1; not 5 V).

A trigger wired to GPIO3 is recognised while the ADI-2 is on and answers over USB: the installer
says so, and System → *Shut down with the ADI-2* offers to use it. With the trigger in use, the
USB connection serves as a second opinion: while the ADI-2 answers over USB it counts as on, so a
loose wire doesn't shut the Pi down – the card then reports that the GPIO gets no trigger signal.

**Power switching (all models, including the Pi 5; untested).** For models that cannot be woken
through GPIO3, a 12 V delay-off timer relay module switches the Pi's supply in addition to the
optocoupler connection above:

```
ADI-2 Trigger Out ──┬── optocoupler ── GPIO3 / GND        (shutdown signal, as above)
                    └── delay-off relay module (12 V)
                          contacts in the Pi's 5 V supply line
```

- Trigger on: the relay closes, the Pi boots on power-up.
- Trigger off: ADI-2-Pi shuts the Pi down after the set delay; the relay opens after its own
  off-delay. The relay's off-delay must exceed ADI-2-Pi's delay plus the shutdown time
  (e.g. 10 s + 30 s → 60 s).
- The Trigger Out supplies at most 150 mA for the relay module and the optocoupler together.
- The relay contacts go into the 5 V line between power supply and Pi and must carry the Pi's
  supply current (Pi 4: 3 A, Pi 5: 5 A).

Behaviour:

- A shutdown happens only after the trigger has been seen on since the bridge started: a Pi
  booted while the ADI-2 is in standby stays on (unless *Started with the ADI-2 off* is set).
- Power loss affects both devices at once; the trigger does not cover it.
- With Auto Standby enabled on the ADI-2, the Pi shuts down with it.
- GPIO3 is also I²C SCL; it is unavailable while I²C is enabled (UPS HAT or another HAT). The
  installer switches I²C on only with `--with-ups`.
- GPIO is read with `gpioget` (libgpiod 1.x and 2.x); the shutdown uses `systemctl poweroff`,
  permitted for `adi2pi` by `/etc/polkit-1/rules.d/50-adi2-pi.rules`.

### UPS HAT

Supported: Waveshare UPS HAT and UPS HAT (B) (INA219 at 0x42, two cells), UPS HAT (C) and (D)
(INA219 at 0x43, one cell), UPS HAT (E) (controller at 0x2D).

To set one up, run the installer with `--with-ups`: it switches I²C on, looks at these
addresses and keeps I²C on when a HAT answers (otherwise I²C is off again after the next start).
I²C uses GPIO2/3, so a 12 V trigger then has to use another GPIO and can't start the Pi. Without the
option the installer doesn't switch I²C on; when I²C is on already, it looks quietly and only
mentions a HAT it found.

System → *UPS HAT* shows the power source, battery level, voltage and current; the (E) also input
voltage, remaining capacity and time to empty/full. On the INA219 models the level is estimated
from the battery voltage (6.0–8.4 V or 3.0–4.2 V, as in Waveshare's scripts); a negative current
means the battery supplies the Pi.

*Shut down on battery* (on by default): when the HAT runs on battery, the Pi shuts down after the
set time (10 s … 10 min) unless power returns, or earlier when the battery reaches the set level
(5–50 %, default 10 %). This works next to *Shut down with the ADI-2*.

Starting again: the UPS HAT (E) is told to switch its output off at the end of a power-off on
battery (`/usr/lib/systemd/system-shutdown/adi2-pi-ups-off`) and starts the Pi when power
returns. The other models keep the halted Pi powered from the battery; it starts again when power
is switched off and on, or with the HAT's switch.

### Updates

System → *ADI-2-Pi updates*. *Check for updates daily* (off by default) asks GitHub for the latest
release of ADI-2-Pi once a day; *Check now* asks once. A newer version is shown on the System tab
with a link to its release page, and with MQTT as a Home Assistant update entity. The check
downloads and installs nothing.

Ways to update – each one installs only a release whose signature matches the release key of the
installed version:

- **Download and install** (shown with a newer release): the Pi downloads
  `adi2-pi-<version>.tar.gz` and its `.sig` from the GitHub release and installs them like a file
  (below).
- **Install updates automatically** (off by default; switches the daily check on): after a check
  finds a newer release, the Pi installs it by itself once nothing plays on it (nothing playing
  into the ADI-2, no Bluetooth headphones connected; otherwise it tries again every 30 minutes).
  New releases then run as root on the Pi without asking. A version whose installation failed is
  left to the user.

Or download the release from
[github.com/shells-dw/adi2-pi/releases](https://github.com/shells-dw/adi2-pi/releases), then either:

- **Install from a file** (System → *ADI-2-Pi updates*): choose `adi2-pi-<version>.tar.gz` and
  `adi2-pi-<version>.tar.gz.sig` together. The Pi doesn't go online for this. It accepts only a
  release whose signature matches the release key of the installed version, shows the version,
  and installs it after *Install*: a root service (`adi2-pi-self-update.service`) checks the
  signature again on its own copy and runs the release's `install.sh -y --same-options`.
  ADI-2-Pi restarts during the installation and the page reloads with the new version. Output:
  `/var/log/adi2-pi/self-update.log`.
- or unpack it on the Pi and run `sudo ./install.sh` (add `--same-options` for the options of
  the previous run).

Settings are kept either way. Without internet access the installer uses the installed packages
(`--offline`, also chosen by itself when the package sources can't be reached); it stops if a
package the new version needs is missing.

### System updates

System → *System updates* keeps the Pi's software up to date: all packages of its apt sources –
Raspberry Pi OS and Debian, Node.js from NodeSource, the receivers' repositories – the same as
`sudo apt full-upgrade`.

| *Automatically* | |
|---|---|
| off – only when asked (default) | *Check now* and *Install updates* on the System tab |
| check and show | checks 5 minutes after the Pi starts, then every 24 hours; available updates are listed there and on the Overview |
| install | checks and installs 5 minutes after the Pi starts, then every 24 hours |

apt's own daily jobs run at fixed times of day with a random delay of up to 12 hours, which a Pi
that is only on while the ADI-2 is often misses; this runs after each start instead. The installer
options `--auto-updates` / `--no-auto-updates` set *install* / *off*.

- The list shows each package with its versions and source; security updates are marked.
- Installing is non-interactive; changed configuration files are kept (the package's new
  default is saved next to them as `.dpkg-dist`). An interrupted dpkg run is finished first.
- The Pi isn't restarted by itself. When a newer kernel is installed, the card says so and has a
  *Restart the Pi* button. After a Node.js update ADI-2-Pi restarts on the new version by itself.
- While updates are being installed the Pi doesn't shut down: *Shut down with the ADI-2* waits
  for them, and the update holds a shutdown inhibitor. With *Started with the ADI-2 off* set, the
  Pi also waits for the update that is due after the start.
- How it works: ADI-2-Pi runs as an unprivileged user. The installer sets up two root services,
  `adi2-pi-os-check.service` (`apt-get update`) and `adi2-pi-os-upgrade.service`
  (`/opt/adi2-pi/lib/os-upgrade.sh`), and a polkit rule that lets ADI-2-Pi start these two and
  restart the Pi – nothing else. Which packages would change is read with `apt-get -s
  full-upgrade` (a simulation). Output: `/var/log/adi2-pi/os-check.log`, `os-upgrade.log`.
- With an access key, only clients with the key can start updates or restart the Pi.

### Volume from the sender

System → *Volume from the sender*. AirPlay and Spotify Connect play at full level; the position of
the sender's volume slider sets the volume of the chosen outputs within a range (default
−60 … −10 dB). The volume limits apply; mute on the sender mutes the outputs. One way only: the
unit's knob doesn't move the slider on the phone. Spotify Connect needs a librespot version with
`--volume-ctrl fixed` (the Streaming tab shows when it can't). UPnP, Squeezelite, Snapcast and
Bluetooth keep their own volume.

### Start volume

System → *Volume* → *At start* per output and *Turn down at start*: when the ADI-2 is switched on
or reconnects, outputs louder than their level are turned down to it. Empty = left as it is.

### Input priority

Tab *Scenes & Actions* → *Input priority* (default off). With the Pi on USB, the unit's Basic Mode
Auto stays in USB mode, and in AD/DA mode the Source doesn't fall back to Analog when a digital
input loses its signal; this does it from the Pi.

- A list of inputs (AES, SPDIF, Analog, USB 1/2), e.g. *AES, Analog* or *AES, SPDIF, Analog*. The
  chosen outputs (Line Out, Phones 3/4) get the Source of the first input that has a signal.
- AES and SPDIF are detected from the unit's status (ADI-2 Pro models; SPDIF = the input chosen
  under SPDIF In). Analog and USB can't be detected and count as always available, so the list
  ends with the first of them. With only AES/SPDIF in the list and neither has a signal, nothing
  changes.
- *Delay* (default 2 s, up to 24 h): an input must have had, or lost, its signal this long before
  the outputs switch – a sample-rate change re-locks the input briefly.
- ADI-2-Pi only switches when the first available input changes: a Source picked by hand stays
  until a signal comes or goes.
- An output switched to USB while the Pi plays (see *Pi Playback*) stays on USB; the input it
  returns to afterwards is updated.

### Quick levels

System → *Volume* → *Quick levels*: up to four volume buttons per output (dB), shown under the knob
on the Overview and the output pages. The volume limits apply.

### Headphone profiles

Tab *Scenes & Actions* → *Headphone profiles*. A profile holds values of one output – EQ (on/off,
preset, bands, Dual EQ), bass/treble, loudness, crossfeed, optionally the output settings (Ref
Level, filters) – and optionally a volume limit. It is taken from an output and can be applied to
any output: the values are written to that output, the limit becomes the output's limit. The
profile applied last is shown on the output's card, in the API (`settings.activeProfile`) and as
an MQTT select; it is cleared when one of the profile's values is changed another way. Values the
output doesn't have (crossfeed on Line Out) are skipped. Apps and the Stream Deck plugin use the
same list (`GET /api/profiles`, `POST /api/profile`).

### Scenes, actions and sleep timer

Tab *Scenes & Actions*.

- **Scene:** set the unit as wanted, tick what the scene holds (volume, mute, dim, source, EQ, EQ
  preset, bass/treble, loudness, crossfeed per output) and save. Applying it changes only these
  values. Scenes can be applied from the page, the API, MQTT and actions. The Overview names the
  scenes whose values all match the unit at the moment, however they were set.
- **Action:** applies a scene when the ADI-2 is switched on, a Bluetooth device connects or
  disconnects, a source starts or stops playing on the Pi, the Pi has played nothing for a set
  number of minutes (once per quiet period), the AES or SPDIF input gets or loses its signal (Pro
  models; carrier lock, not whether audio plays), or at a time of day (Pi local time). A time
  action can have an end time with a second scene, e.g. 22:00 → *Night*, 07:00 → *Day*.
  Each action has a delay (0 s … 24 h): the scene follows that much later, and the opposite event
  in the meantime (input signal back, the source plays again, the device reconnects, the ADI-2 goes
  off) drops it. Waiting actions are shown with a countdown and are not kept across a restart.
- **Sleep timer:** 15 … 90 minutes or any time up to 24 h. The chosen outputs fade down by 40 dB
  over the fade time, are muted, and get their volume back, so unmuting plays as before.

### Now playing

Pi Playback → *Track*: title, artist, album and play state of what the Pi plays – from AirPlay
(shairport-sync's metadata pipe, with cover art), Spotify Connect (librespot's events; librespot
0.4 reports no titles) and Bluetooth (AVRCP). UPnP, Squeezelite, Snapcast and Roon report
nothing. Also `GET /api/nowplaying`, the `nowplaying` WebSocket message and an MQTT sensor.

### Backup and restore

System → *Backup*: a JSON file with every setting the unit reports, its 20 EQ presets, the setup
names and ADI-2-Pi's settings (without access key and MQTT password). The content of the unit's
9 setups is not readable over MIDI and not included. *Restore* takes a file and the parts to
restore; unit settings only go back to the same model.

### Access key

System → *Access key*. With a key set, the web page asks for it once per browser; apps and the
Stream Deck plugin send it as `X-ADI2PI-Key` header or `?key=` (see [docs/API.md](docs/API.md#security)).
Programs on the Pi itself don't need it. The connection stays plain HTTP: the key keeps others on
the network out, it doesn't encrypt.

*Needed for: changes only* lets anyone on the network see the page and the state (for a wall
tablet); every change asks for the key. Without it, nothing is served except `/api/info`.

### MQTT / Home Assistant

System → *MQTT*: server, port, user name, password, topic. With *Home Assistant discovery*, the
outputs' volume, mute, dim, source, EQ, EQ preset, bass/treble, loudness and crossfeed, the
setups, the scenes and the sleep timer appear in Home Assistant by themselves (MQTT integration).
Plain MQTT without TLS, for a server in the local network. Topics: [docs/API.md](docs/API.md#mqtt).

### MIDI port

The PipeWire instance of a Raspberry Pi OS desktop session opens all ALSA MIDI ports, which
blocks the ADI-2's port. The installer disables WirePlumber's ALSA MIDI monitor for desktop
sessions; `--keep-pipewire-midi` skips this.

### Network access

The web interface loads no external resources. With MQTT switched on, ADI-2-Pi connects to the
MQTT server that is set. With the update check switched on (off by default), it asks
`api.github.com` once a day for the latest release; *Check now* asks once. The Headphone EQ Generator's *Check for updated
headphone data* contacts `api.github.com` and `raw.githubusercontent.com` (AutoEq repository)
and stores new or changed files in `/var/lib/adi2-pi/eq`; *Back to the shipped data* deletes
them. The installer uses the package repositories, NodeSource's repository (`deb.nodesource.com`,
without `--system-node`) and, for `--with-*` options, GitHub, the raspotify repository or Roon's
download server.

### Files written

`/var/lib/adi2-pi/settings.json` (written when a bridge setting changes; holds scenes, actions,
the access key's hash and the MQTT password), downloaded headphone
data in `/var/lib/adi2-pi/eq`, the audio service's state in `/var/lib/adi2-pi/audio-state`,
the AirPlay metadata pipe `/var/lib/adi2-pi/shairport-sync-metadata`, and with `--with-roon`
Roon Bridge's ALSA configuration in `/var/lib/adi2-pi/roon-home`.
Unit settings are not stored on the Pi.

## Troubleshooting

```sh
journalctl -u adi2-pi -f                     # bridge log
journalctl -u adi2-pi-audio -n 50            # audio service
cat /proc/asound/cards                       # ADI-2 present?
sudo -u adi2pi XDG_RUNTIME_DIR=/run/adi2-pi-audio wpctl status   # PipeWire graph
bluetoothctl show                            # Bluetooth adapter
```

| Message | Cause / action |
|---|---|
| `no ADI-2 found` | USB connection; try another port. |
| `does not answer` / `stopped answering` | MIDI Control is off: SETUP – Options – Device Mode – MIDI Control = ON. |
| `busy` | Another program has the MIDI port open (see [MIDI port](#midi-port)). |
| A setting changes unexpectedly | Debug tab → *Sent to the unit* lists every change sent by ADI-2-Pi and its origin. |
| `no Bluetooth adapter found` | Bluetooth disabled: check `dtoverlay=disable-bt` in `/boot/firmware/config.txt`, run `sudo rfkill unblock bluetooth`. |
| `the audio service … is not running` | `sudo systemctl restart adi2-pi-audio`, check its log. |
| Bluetooth headphones connected but silent | Bluetooth source is *off*, or the selected output is muted before its DSP. |
| Trigger: `GPIO3 is in use` | I²C is on (UPS HAT or another HAT): choose another *Trigger input* GPIO. |
| UPS HAT: `no UPS HAT found` / `I2C is off` | `sudo i2cdetect -y 1` should list 2d, 42 or 43; run the installer again with `--with-ups`. |
| Page asks for an access key | A key is set (System → Access key). Forgotten: remove `"access"` from `/var/lib/adi2-pi/settings.json` and `sudo systemctl restart adi2-pi`. |
| MQTT: `wrong user name or password` / `not authorised` | Check the user on the MQTT server (Home Assistant: Mosquitto add-on, a Home Assistant user). |

## Protocol

RME "MIDI-Protocol for ADI-2 DAC, ADI-2 Pro and ADI-2/4 Pro SE" v0.2, extended with behaviour
observed on an ADI-2 Pro EX:

- Device IDs 0x71 (DAC), 0x72 (Pro, Pro EX), 0x73 (2/4 Pro SE; the 2/4 Pro EX is expected on the same ID, as the Pro EX kept the Pro's).
- EQ preset store: data on addresses 13/14, then the flags word as a separate message at
  address 13 **index 2** (the unit sends it at index 1 and ignores it there on receive). B/T
  Enable (13.20) and Load B/T (13.27) must not be part of a store: the unit switches MIDI Control
  off.
- Device parameter 16 (sample rate, read-only): index into 44.1 … 768 kHz.
- Device parameter 62 (not in v0.2): Load Volume with Setup (0 = disabled, 1 = with Setup).
- The ADI-2 Pro EX does not report Phones 1/2 Mute, Dim, Width, Lock Volume, Source, Mono, DA
  Filter, De-Emphasis, Loopback, DC Protection, or input Bass/Treble.
- ADI-2/4 Pro EX (untested): its manual (v2.0) lists values the 2/4 Pro SE doesn't have and v0.2
  doesn't number – input Ref Level −5 … −35 dBu (digital gain), RIAA 0 dB, DC Filter ADC,
  Bal. Impedance 94 k / 47 k, Phones 3/4 Source ADAT 3/4, Remap Keys RIAA Mode + / − and RIAA
  Mono B. Values the bridge has no name for are shown as `#<number>`; Debug → *Settings ADI-2-Pi can’t
  name yet* lists them and the parameters the bridge doesn't know.

## Development

No npm dependencies, no build step. Node.js 18 or later; the installer sets up Node.js 24.

```sh
npm run mock    # bridge with a simulated ADI-2, Bluetooth, audio and receivers on http://localhost:8080
npm test        # unit, API and integration tests (Node.js 20.10 or later)
```

Integration tests run against a fake BlueZ on a private D-Bus (python3-dbus, dbus-daemon), a
private PipeWire/WirePlumber instance (pipewire, wireplumber, pipewire-pulse) and real receivers
(gmediarender, snapserver/snapclient); they are skipped when those programs are missing.

```
bin/adi2-pi.js          entry point, command line options
lib/protocol.js         SysEx encoding and decoding
lib/schema.json         parameter definitions (addresses, ranges, value names)
lib/catalog.js          parameter names ↔ addresses
lib/device.js           unit model: identification, sync, sets, limits, linking, watchdog
lib/transport-alsa.js   ALSA raw MIDI device, hot-plug
lib/server.js, ws.js    HTTP and WebSocket API, static files
lib/settings.js         bridge settings
lib/audio.js            PipeWire routing, source arbitration, sample rate, Loopback
lib/autosource.js       output Source switching while the Pi plays
lib/bluetooth.js        Bluetooth control via lib/bt-helper.py (BlueZ D-Bus, pairing agent)
lib/receivers.js        network receivers: processes, status
lib/trigger.js          shutdown with the ADI-2: USB connection or trigger GPIO
lib/ups.js              Waveshare UPS HAT: readings over I²C, shutdown on battery
lib/automation.js       scenes, actions, sleep timer, start volume
lib/streamvol.js        sender volume (AirPlay, Spotify Connect) → ADI-2 volume; bin/adi2-pi-hook.js posts it
lib/backup.js           backup file, restore
lib/mqtt.js, mqtt-bridge.js  MQTT client, entities, Home Assistant discovery
lib/updates.js          update check (GitHub releases)
lib/selfupdate.js       install from a file; lib/release-verify.js checks release signatures
lib/osupdates.js        system updates (apt) through root services
lib/nowplaying.js       now playing: AirPlay metadata pipe, librespot events, Bluetooth AVRCP
lib/usb-audio.js        sample rate via the USB playback device (without audio service)
lib/eq-data.js          headphone data: bundled files, update on request
lib/mock-adi.js         simulated unit; lib/bt-mock.js simulated Bluetooth, audio, receivers
clients/                reference API client
audio/                  audio service start script, PipeWire/WirePlumber configuration
systemd/                service units, mDNS service definition
web/                    web interface; web/lang/ languages; web/eq/ Headphone EQ Generator and its data
tools/                  i18n-keys.js: lists the page's translatable texts; release.js: signed release files
test/                   tests
```

### Releases

*Install from a file* accepts releases signed with the key whose public part is
`lib/release-key.pub` in the installed version.

```sh
node tools/release.js key     # once: signing key in ~/.config/adi2-pi/release-key.pem (keep a copy),
                              # public key to lib/release-key.pub – commit it
node tools/release.js build   # dist/adi2-pi-<version>.tar.gz, .zip and .tar.gz.sig from HEAD
```

Attach all three files to the GitHub release. With a lost key, installations need one manual
update to a release with the new public key. Works on Linux, macOS and Windows (Node.js 18+, git;
on Windows the key is in `%USERPROFILE%\.config\adi2-pi\`). The archives always get Unix line
endings (`.gitattributes`), whatever `core.autocrlf` says.

## Support

If ADI-2-Pi is useful to you: [![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dwshells) [!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/dwshells)

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). Third-party content: [NOTICE.md](NOTICE.md).

RME, ADI-2 and TotalMix are trademarks of RME Intelligent Audio Solutions / Audio AG. This
project is not affiliated with RME.
