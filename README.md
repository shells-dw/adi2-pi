<img src="docs/logo/wordmark-light.png" alt="ADI-2-Pi" width="420">

Network remote and audio bridge for RME ADI-2 series converters (ADI-2 DAC, ADI-2 Pro / Pro EX,
ADI-2/4 Pro SE). Runs on a Raspberry Pi connected to the unit by USB.

- **Web interface:** all output, input and device settings, parametric EQ with a draggable curve,
  bass/treble, loudness, setups, the unit's 20 EQ presets (edit, store, load).
- **API:** WebSocket and HTTP, used by the web interface, a Stream Deck plugin and other clients.
  See [docs/API.md](docs/API.md). Reference client: [clients/adi2pi-client.js](clients/adi2pi-client.js).
- **Volume safety:** volume limit per output, rise-speed limit, linked volumes.
- **Bluetooth (A2DP), both directions** on the Pi's built-in adapter: phones play into the ADI-2;
  Bluetooth headphones/speakers receive Line Out or Phones 3/4 after its DSP. Codecs: LDAC,
  aptX HD, aptX, SBC-XQ, SBC.
- **Network receivers:** AirPlay (optionally AirPlay 2), UPnP/DLNA, Squeezelite, Snapcast;
  Spotify Connect and Roon Bridge as install options.
- **Headphone EQ Generator** at `/eq/`: fits a parametric EQ for the ADI-2 or TotalMix FX Room
  EQ to oratory1990's measurements and writes it to an output. See [docs/eq-generator.md](docs/eq-generator.md).
- **Trigger input (optional):** shuts the Pi down when the ADI-2 goes to standby, using the
  unit's 12 V Trigger Out.
- Works offline. The only outgoing connection made by ADI-2-Pi itself is the optional headphone
  data update.

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

- installs the required packages from the Raspberry Pi OS repositories (Node.js, avahi, ALSA
  utilities, gpiod; with audio: PipeWire, WirePlumber, BlueZ, Python D-Bus bindings; with
  streaming: the receivers)
- creates the system user `adi2pi` and the services `adi2-pi` (bridge) and `adi2-pi-audio`
  (a dedicated PipeWire instance for the ADI-2 and Bluetooth)
- copies the program to `/opt/adi2-pi`; settings are kept in `/var/lib/adi2-pi`
- announces the bridge via mDNS (`_adi2._tcp`, `_http._tcp`)
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
| `-y`, `--yes` | No questions. |

Uninstall: `sudo /opt/adi2-pi/uninstall.sh` (`--purge` also removes settings and the service user).

## Web interface

| Tab | Content |
|---|---|
| Overview | All outputs: volume, mute, dim, source, DSP switches |
| Line Out, Phones 1/2, Phones 3/4 | Level, EQ, bass/treble, loudness, settings of the output |
| Input | Analog input (Pro models) |
| EQ Presets | The unit's 20 EQ presets: editor, apply to an output, store, load |
| Device | Device settings, setups |
| Pi Playback | Sources played by the Pi, sample rate, switching outputs to USB |
| Bluetooth | Pairing phones, pairing and routing headphones/speakers |
| Streaming | Network receivers on/off, server addresses |
| State | Device and output status overview |
| Headphone EQ | Headphone EQ Generator |
| System | Bridge name, volume limits, trigger, Debug tab switch |
| Debug | Shown when enabled under System (per browser): changes sent to the unit with their origin, parameters not in the schema, MIDI monitor, connection log, parameter table, status recorder |

Controls: volume knobs react to dragging (Shift = fine), scroll wheel and arrow keys;
double-click mutes. EQ curve points are dragged for frequency and gain, the scroll wheel changes
Q, double-click resets the gain.

Parameters the connected unit does not report (e.g. Phones 1/2 Mute on the ADI-2 Pro EX) are not
shown.

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

### Trigger: shutdown with the ADI-2

The ADI-2's Trigger Out (3.5 mm mono jack; tip = supply voltage, 9–16 V; ring and sleeve =
ground) is on while the unit is on. Connected to GPIO3 through an optocoupler, the bridge shuts
the Pi down after the trigger has been off for a set time (10 s, 30 s, 1 min, 5 min; System →
Trigger). A halted Raspberry Pi 4 or 3 boots when GPIO3 is pulled low, so switching the ADI-2 on
starts the Pi (bootloader defaults `WAKE_ON_GPIO=1`, `POWER_OFF_ON_HALT=0`; not on the Pi 5).

```
ADI-2 Trigger Out                          Raspberry Pi
 tip  ──[ 2.2 kΩ ]──►|── LED  ┐  PC817  ┌── collector ── GPIO3 (pin 5)
 sleeve ──────────────────────┘         └── emitter  ── GND   (pin 6)
        (1N4148 in reverse across the LED)
```

Alternatively a PC817 optocoupler module with 12 V input: IN+ to tip, IN− to sleeve, OUT to
GPIO3, GND to GND, output VCC to 3.3 V (pin 1; not 5 V).

- A shutdown happens only after the trigger has been seen on since the bridge started: a Pi
  booted while the ADI-2 is in standby stays on.
- Power loss affects both devices at once; the trigger does not cover it.
- With Auto Standby enabled on the ADI-2, the Pi shuts down with it.
- GPIO3 is also I²C SDA; it is unavailable if I²C is enabled or used by a HAT.
- GPIO is read with `gpioget` (libgpiod 1.x and 2.x); the shutdown uses `systemctl poweroff`,
  permitted for `adi2pi` by `/etc/polkit-1/rules.d/50-adi2-pi.rules`.

### MIDI port

The PipeWire instance of a Raspberry Pi OS desktop session opens all ALSA MIDI ports, which
blocks the ADI-2's port. The installer disables WirePlumber's ALSA MIDI monitor for desktop
sessions; `--keep-pipewire-midi` skips this.

### Network access

The web interface loads no external resources. The Headphone EQ Generator's *Check for updated
headphone data* contacts `api.github.com` and `raw.githubusercontent.com` (AutoEq repository)
and stores new or changed files in `/var/lib/adi2-pi/eq`; *Back to the shipped data* deletes
them. The installer uses the package repositories and, for `--with-*` options, GitHub, the
raspotify repository or Roon's download server.

### Files written

`/var/lib/adi2-pi/settings.json` (written when a bridge setting changes), downloaded headphone
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
| Trigger: `GPIO3 is in use` | I²C is enabled or a HAT uses GPIO3. |

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

No npm dependencies, no build step. Node.js 18 or later.

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
lib/trigger.js          trigger input on GPIO3, shutdown
lib/usb-audio.js        sample rate via the USB playback device (without audio service)
lib/eq-data.js          headphone data: bundled files, update on request
lib/mock-adi.js         simulated unit; lib/bt-mock.js simulated Bluetooth, audio, receivers
clients/                reference API client
audio/                  audio service start script, PipeWire/WirePlumber configuration
systemd/                service units, mDNS service definition
web/                    web interface; web/eq/ Headphone EQ Generator and its data
test/                   tests
```

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). Third-party content: [NOTICE.md](NOTICE.md).

RME, ADI-2 and TotalMix are trademarks of RME Intelligent Audio Solutions / Audio AG. This
project is not affiliated with RME.
