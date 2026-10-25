<img src="docs/logo/wordmark-light.png" alt="ADI-2-Pi" width="420">

Network remote and audio bridge for RME ADI-2 series converters (ADI-2 DAC, ADI-2 Pro / Pro EX,
ADI-2/4 Pro SE). Runs on a Raspberry Pi connected to the unit by USB.

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
  update, the optional update check, and the MQTT server when MQTT is switched on.

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
| `--with-airplay2` | Builds shairport-sync with AirPlay 2 and nqptp from source (github.com/mikebrady), about 10 minutes on a Pi 4. Skipped if the installed build matches the current sources. An existing AirPlay 2 build stays in use when the option is omitted. |
| `--rebuild-airplay2` | Rebuilds AirPlay 2 unconditionally. |
| `--with-spotify` | Spotify Connect: adds the raspotify apt repository and installs librespot. |
| `--with-roon` | Roon Bridge: runs Roon's installer. |
| `--keep-pipewire-midi` | Leaves the MIDI bridge of the desktop session's PipeWire enabled (see [MIDI port](#midi-port)). |
| `--journal-ram` | Keeps the system journal in RAM only. |
| `--with-ups` | Switches I²C on for a UPS HAT even when the ADI-2 trigger is set to GPIO3 (and keeps I²C on if no HAT answers). |
| `--no-ups` | Doesn't look for a UPS HAT. |
| `--system-node` | Node.js from Raspberry Pi OS instead of NodeSource; removes NodeSource's repository if present. Without the option, a later run switches to Node.js 24 again. |
| `-y`, `--yes` | No questions. |

Uninstall: `sudo /opt/adi2-pi/uninstall.sh` (`--purge` also removes settings and the service user).

## Web interface

| Tab | Content |
|---|---|
| Overview | All outputs: volume, mute, dim, quick levels, headphone profile, source, DSP switches |
| Line Out, Phones 1/2, Phones 3/4 | Level, EQ, bass/treble, loudness, settings of the output |
| Input | Analog input (Pro models) |
| EQ Presets | The unit's 20 EQ presets: editor, apply to an output, store, load |
| Device | Device settings, setups |
| Pi Playback | Title and artist of what plays, sources played by the Pi, sample rate, switching outputs to USB |
| Bluetooth | Pairing phones, pairing and routing headphones/speakers |
| Streaming | Network receivers on/off, server addresses |
| State | Device and output status overview |
| Scenes & Actions | Sleep timer, headphone profiles, scenes, actions |
| Headphone EQ | Headphone EQ Generator |
| System | Bridge name, language, volume limits, quick levels, start volume, volume from the sender, shutdown with the ADI-2, UPS HAT, updates, backup/restore, access key, MQTT, Debug tab switch |
| Debug | Shown when enabled under System (per browser): changes sent to the unit with their origin, parameters not in the schema, MIDI monitor, connection log, parameter table, status recorder |

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

In both cases the Pi only shuts down after it has seen the ADI-2 on: a Pi started while the
ADI-2 is off stays on. A running countdown can be cancelled on the System tab.

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
  booted while the ADI-2 is in standby stays on.
- Power loss affects both devices at once; the trigger does not cover it.
- With Auto Standby enabled on the ADI-2, the Pi shuts down with it.
- GPIO3 is also I²C SCL; it is unavailable while I²C is enabled (UPS HAT or another HAT).
- GPIO is read with `gpioget` (libgpiod 1.x and 2.x); the shutdown uses `systemctl poweroff`,
  permitted for `adi2pi` by `/etc/polkit-1/rules.d/50-adi2-pi.rules`.

### UPS HAT

Supported: Waveshare UPS HAT and UPS HAT (B) (INA219 at 0x42, two cells), UPS HAT (C) and (D)
(INA219 at 0x43, one cell), UPS HAT (E) (controller at 0x2D). The installer switches I²C on for a
moment, looks at these addresses and keeps I²C on when a HAT answers. If the ADI-2 trigger is set
to GPIO3, it asks first (I²C uses GPIO2/3).

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

System → *Updates*. *Check for updates daily* (off by default) asks GitHub for the latest release
of ADI-2-Pi once a day; *Check now* asks once. A newer version is shown on the System tab with a
link to its release page, and with MQTT as a Home Assistant update entity. Nothing is downloaded
or installed. To update, download the release from
[github.com/shells-dw/adi2-pi/releases](https://github.com/shells-dw/adi2-pi/releases), unpack
it and run `sudo ./install.sh` with the options used before; settings are kept.

### Volume from the sender

System → *Volume from the sender*. AirPlay and Spotify Connect play at full level; the position of
the sender's volume slider sets the volume of the chosen outputs within a range (default
−60 … −10 dB). The volume limits apply; mute on the sender mutes the outputs. One way only: the
unit's knob doesn't move the slider on the phone. Spotify Connect needs a librespot version with
`--volume-ctrl fixed` (the Streaming tab shows when it can't). UPnP, Squeezelite, Snapcast and
Bluetooth keep their own volume.

### Start volume

System → *Start volume*: when the ADI-2 is switched on or reconnects, outputs louder than their
level are turned down to it.

### Quick levels

System → *Quick levels*: up to four volume buttons per output (dB), shown under the knob on the
Overview and the output pages. The volume limits apply.

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
  values. Scenes can be applied from the page, the API, MQTT and actions.
- **Action:** applies a scene when the ADI-2 is switched on, a Bluetooth device connects or
  disconnects, a source starts or stops playing on the Pi, the Pi has played nothing for a set
  number of minutes (once per quiet period), the AES or SPDIF input gets or loses its signal (Pro
  models; carrier lock, not whether audio plays), or at a time of day (Pi local time). A time
  action can have an end time with a second scene, e.g. 22:00 → *Night*, 07:00 → *Day*.
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
data in `/var/lib/adi2-pi/eq`, and the audio service's state in `/var/lib/adi2-pi/audio-state`.
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
| UPS HAT: `no UPS HAT found` / `I2C is off` | `sudo i2cdetect -y 1` should list 2d, 42 or 43; run the installer again (`--with-ups`). |
| Page asks for an access key | A key is set (System → Access key). Forgotten: remove `"access"` from `/var/lib/adi2-pi/settings.json` and `sudo systemctl restart adi2-pi`. |
| MQTT: `wrong user name or password` / `not authorised` | Check the user on the MQTT server (Home Assistant: Mosquitto add-on, a Home Assistant user). |

## Protocol

RME "MIDI-Protocol for ADI-2 DAC, ADI-2 Pro and ADI-2/4 Pro SE" v0.2, extended with behaviour
observed on an ADI-2 Pro EX:

- Device IDs 0x71 (DAC), 0x72 (Pro, Pro EX), 0x73 (2/4 Pro SE).
- EQ preset store: data on addresses 13/14, then the flags word as a separate message at
  address 13 **index 2** (the unit sends it at index 1 and ignores it there on receive). B/T
  Enable (13.20) and Load B/T (13.27) must not be part of a store: the unit switches MIDI Control
  off.
- Device parameter 16 (sample rate, read-only): index into 44.1 … 768 kHz.
- Device parameter 62 (not in v0.2): Load Volume with Setup (0 = disabled, 1 = with Setup).
- The ADI-2 Pro EX does not report Phones 1/2 Mute, Dim, Width, Lock Volume, Source, Mono, DA
  Filter, De-Emphasis, Loopback, DC Protection, or input Bass/Treble.

## Development

No npm dependencies, no build step. Node.js 18 or later; the installer sets up Node.js 24.

```sh
npm run mock    # bridge with a simulated ADI-2, Bluetooth, audio and receivers on http://localhost:8080
npm test        # unit, API and integration tests
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
lib/nowplaying.js       now playing: AirPlay metadata pipe, librespot events, Bluetooth AVRCP
lib/usb-audio.js        sample rate via the USB playback device (without audio service)
lib/eq-data.js          headphone data: bundled files, update on request
lib/mock-adi.js         simulated unit; lib/bt-mock.js simulated Bluetooth, audio, receivers
clients/                reference API client
audio/                  audio service start script, PipeWire/WirePlumber configuration
systemd/                service units, mDNS service definition
web/                    web interface; web/lang/ languages; web/eq/ Headphone EQ Generator and its data
tools/                  i18n-keys.js: lists the page's translatable texts
test/                   tests
```

## Support

If ADI-2-Pi is useful to you: [![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dwshells) [!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/dwshells)

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). Third-party content: [NOTICE.md](NOTICE.md).

RME, ADI-2 and TotalMix are trademarks of RME Intelligent Audio Solutions / Audio AG. This
project is not affiliated with RME.
