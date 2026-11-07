# User guide

## Web interface

| Tab | Content |
|---|---|
| Overview | Signal path: the unit's sources (AES/SPDIF signal and rate, what the Pi plays) and each output's source, volume and level; matching scenes, headphone profiles, sleep timer, UPS, updates. Below: volume, Mute/Dim, quick levels and DSP switches per output. |
| Line Out, Phones 1/2, Phones 3/4 | Level, parametric EQ, bass/treble, loudness, output settings |
| Input | Analog input (Pro models) |
| EQ Presets | The unit's 20 EQ presets: edit, apply, store, load |
| Device | Device settings, setups, sample rate |
| Pi Playback | What plays, its sources, sample rate, switching outputs to USB |
| Bluetooth | Phones and headphones/speakers |
| Streaming | Network receivers |
| Scenes & Actions | Sleep timer, input priority, headphone profiles, scenes, actions |
| Headphone EQ | [Headphone EQ Generator](eq-generator.md) |
| System | Name, language, volume limits, shutdown with the ADI-2, UPS, access key, MQTT, updates, backup, the Pi's state (temperature, load, memory, power supply) |
| Debug | Enabled under System: changes sent to the unit and their origin, unknown parameters, MIDI monitor, status recorder |

Explanations sit behind the ⓘ next to a section title. Volume knobs: drag (Shift = fine),
scroll wheel, arrow keys, double-click mutes. EQ points: drag for frequency and gain, scroll for Q,
double-click resets the gain. Settings the unit doesn't report (e.g. Phones 1/2 Mute on the ADI-2
Pro EX) aren't shown.

Language: System → *Language*, per browser (default: the browser's). English and German are
included; more are one JSON file each, see [web/lang/README.md](../web/lang/README.md).

## The unit

- SysEx over the unit's USB-MIDI port. On connect ADI-2-Pi reads all settings, setup names and the
  20 EQ presets; changes made on the unit arrive as they happen.
- The unit doesn't echo values received over MIDI: ADI-2-Pi reads it back 1.5 s after the last
  change, and everything every 30 s.
- No status message for 4 s: the unit counts as not answering (MIDI Control off) and changes are
  refused until it answers.
- Only one program can open the MIDI port at a time. A desktop session's PipeWire opens all MIDI
  ports; the installer switches that off (`--keep-pipewire-midi` keeps it).

## Sample rate

On USB the host sets the ADI-2's rate, also for the analog input; the unit's own menu is locked.
With the audio service the rate follows what plays, or is fixed (Pi Playback or Device tab): then
everything is resampled to it, and an idle ADI-2 is switched right away. A unit clocked from AES or
SPDIF keeps that input's rate.

## Pi Playback

For audio the Pi plays (Bluetooth, network receivers); the ADI-2's own settings aren't touched.

- **Several sources:** the newest one is heard and the others are muted until it stops (*Switch to
  this* picks another); or *Mix*.
- **USB while the Pi plays** (Line Out, Phones 3/4; on by default): the output switches to USB 1/2
  when a source starts and back 10 s after the last one stops. Changed by hand meanwhile: stays.
- **Now playing:** title, artist, album, cover from AirPlay, Spotify Connect (librespot 0.5+) and
  Bluetooth. UPnP, Squeezelite, Snapcast and Roon report nothing.

## Bluetooth

- **Phones → ADI-2:** *Make visible* opens pairing for 2 minutes. Paired phones reconnect by
  themselves and play to every output on Auto or USB.
- **ADI-2 → headphones/speakers:** *Search*, *Pair*. Source: Line Out or Phones 3/4 after its DSP
  (its Loopback is set to Post FX −6 dB while connected and restored afterwards; *Level*, default
  +6 dB, makes up for the −6 dB), the analog input, or off.
- Codecs to headphones: LDAC, aptX HD, aptX, SBC-XQ, SBC; from phones aptX HD, aptX, SBC-XQ, SBC.
- The Pi 4 shares its antenna with 2.4 GHz Wi-Fi: use Ethernet or 5 GHz for LDAC.

## Network receivers

| Receiver | For | Package |
|---|---|---|
| AirPlay | iOS, macOS | `shairport-sync`; AirPlay 2 with `--with-airplay2` |
| UPnP / DLNA | BubbleUPnP, Linn Kazoo … | `gmediarender` |
| Squeezelite | Lyrion Music Server | `squeezelite` |
| Snapcast | Snapcast server | `snapclient` |
| Spotify Connect | Spotify | librespot, `--with-spotify` |
| Roon Bridge | Roon | `--with-roon` |

They run as ADI-2-Pi's child processes under the bridge's name (their own services are masked).
Squeezelite and Snapcast find their server via mDNS unless an address is set.

**Volume from the sender** (System): AirPlay and Spotify Connect play at full level, and the
sender's slider sets the chosen outputs' volume within a range (default −60 … −10 dB), one way
only.

## Volume

System → *Volume*, per output: highest volume, rise-speed limit, linked outputs, *At start* (louder
outputs are turned down to it when the unit comes on) and up to four *quick levels* (buttons under
the knob).

## Input priority

Scenes & Actions → *Input priority*: the chosen outputs play the first input of a list that has a
signal, e.g. AES, else Analog. AES and SPDIF are detected from the unit's status; Analog and USB
can't be and count as always there, so the list ends with them. *Delay* (default 2 s): how long a
signal must be there or gone before switching. A source picked by hand stays until a signal comes
or goes.

## Headphone profiles, scenes, actions, sleep timer

- **Headphone profile:** an output's EQ, bass/treble, loudness, crossfeed (optionally output
  settings and a volume limit), taken from one output, applied to any.
- **Scene:** the values you tick (volume, mute, source, EQ, preset … per output). Applied from the
  page, the API, MQTT or an action. The Overview names scenes that match the unit right now.
- **Action:** applies a scene when the unit comes on, a Bluetooth device connects, a source starts
  or stops, the Pi has been quiet for a while, an AES/SPDIF input gets or loses its signal, or at a
  time of day (optionally with an end time and a second scene). Each can have a delay; the opposite
  event meanwhile cancels it.
- **Sleep timer:** 15 min … 24 h; the outputs fade down, mute, and get their volume back for later.

## Shutdown with the ADI-2

System → *Shut down with the ADI-2*: the Pi shuts down when the ADI-2 has been off for 10 s … 5 min.

| *Detect standby by* | USB connection | 12 V trigger on a GPIO |
|---|---|---|
| Off when | the unit's USB MIDI port disappears or stops answering | Trigger Out is off |
| Wiring | none | optocoupler, below |
| Pi starts with the ADI-2 | no | Pi 4 and 3, on GPIO3 |

- The Pi only shuts down after it has seen the ADI-2 on, unless *Started with the ADI-2 off* is set
  (then 5 … 60 min after the start).
- Package updates in progress finish first (at most 30 min).
- With the trigger, USB answering still counts as on, so a loose wire doesn't shut the Pi down; the
  card then says the GPIO gets no signal.

### Wiring the 12 V trigger

The ADI-2's Trigger Out (3.5 mm mono: tip = supply voltage, 9–16 V; sleeve = ground) is on while
the unit is on. Through an optocoupler to GPIO3, switching the ADI-2 on also starts a halted Pi 4
or 3 (not the Pi 5).

```
ADI-2 Trigger Out                          Raspberry Pi
 tip  ──[ 2.2 kΩ ]──►|── LED  ┐  PC817  ┌── collector ── GPIO3 (pin 5)
 sleeve ──────────────────────┘         └── emitter  ── GND   (pin 6)
        (1N4148 in reverse across the LED)
```

Or a PC817 module with 12 V input: IN+ to tip, IN− to sleeve, OUT to GPIO3, GND to GND, VCC to
3.3 V (pin 1, not 5 V).

*Trigger input* can also be GPIO4, 17, 22, 23, 24, 25 or 27 (then the Pi shuts down with the ADI-2
but doesn't start with it). With I²C on (UPS HAT), GPIO3 is taken. A trigger on GPIO3 is
recognised while the ADI-2 is on; the installer and the System tab say so.

**Pi 5 and other models (untested):** add a 12 V delay-off relay module on Trigger Out, its
contacts in the Pi's 5 V line, with an off-delay longer than ADI-2-Pi's delay plus the shutdown
(e.g. 60 s). Trigger Out supplies at most 150 mA for relay and optocoupler together.

## UPS HAT

Waveshare UPS HAT and (B) (INA219 at 0x42), (C) and (D) (0x43), (E) (0x2D). Set up with
`install.sh --with-ups`, which switches I²C on and keeps it on when a HAT answers. I²C uses
GPIO2/3, so a trigger then needs another GPIO.

System → *UPS HAT* shows power source, battery level, voltage and current. *Shut down on battery*
(on by default): after a set time on battery, or earlier at a set level (default 10 %). The (E)
switches off at the end and starts the Pi when power returns; the others keep the halted Pi on
battery until power is switched off and on.

## Backup, access key, MQTT

- **Backup** (System): a JSON file with every setting the unit reports, its EQ presets, setup names
  and ADI-2-Pi's settings (without key and MQTT password). The content of the unit's 9 setups
  can't be read over MIDI. Unit settings restore to the same model only.
- **Access key** (System): the page asks for it once per browser; apps send it as `X-ADI2PI-Key`
  or `?key=` ([API](API.md#security)). *Changes only* lets everyone look (a wall tablet). Plain
  HTTP: it keeps others out, it doesn't encrypt.
- **MQTT** (System): server, user, topic. With *Home Assistant discovery*, volume, mute, source,
  EQ, setups, scenes and the sleep timer appear in Home Assistant. Plain MQTT, for the local
  network. Topics: [API](API.md#mqtt).
