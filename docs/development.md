# Development

No npm dependencies, no build step. Node.js 18 or later (tests: 20.10 or later).

```sh
npm run mock    # bridge with a simulated ADI-2, Bluetooth, audio and receivers on http://localhost:8080
npm test        # unit, API and integration tests
```

Integration tests use a fake BlueZ on a private D-Bus (python3-dbus, dbus-daemon), a private
PipeWire/WirePlumber (pipewire, wireplumber, pipewire-pulse) and real receivers (gmediarender,
snapserver/snapclient); they're skipped when those are missing.

```
bin/adi2-pi.js          entry point, command line options
lib/protocol.js         SysEx encoding and decoding
lib/schema.json         parameter definitions (addresses, ranges, value names)
lib/catalog.js          parameter names ↔ addresses, value names per model
lib/device.js           unit model: identification, sync, sets, limits, linking, watchdog
lib/transport-alsa.js   ALSA raw MIDI device, hot-plug
lib/server.js, ws.js    HTTP and WebSocket API, static files
lib/settings.js         bridge settings
lib/audio.js            PipeWire routing, source arbitration, sample rate, Loopback
lib/autosource.js       output Source switching while the Pi plays
lib/inputprio.js        input priority
lib/bluetooth.js        Bluetooth via lib/bt-helper.py (BlueZ D-Bus, pairing agent)
lib/receivers.js        network receivers
lib/nowplaying.js       now playing: AirPlay metadata pipe, librespot events, AVRCP
lib/streamvol.js        sender volume → ADI-2 volume (bin/adi2-pi-hook.js posts it)
lib/trigger.js          shutdown with the ADI-2: USB connection or trigger GPIO
lib/ups.js              Waveshare UPS HAT over I²C
lib/automation.js       scenes, actions, sleep timer, start volume
lib/backup.js           backup and restore
lib/mqtt.js, mqtt-bridge.js  MQTT client, entities, Home Assistant discovery
lib/updates.js          update check (GitHub releases)
lib/selfupdate.js       installing releases; lib/release-verify.js checks signatures
lib/osupdates.js        system updates (apt) through root services
lib/usb-audio.js        sample rate via the USB playback device (without audio service)
lib/eq-data.js          headphone data: bundled files, update on request
lib/mock-adi.js         simulated unit; lib/bt-mock.js simulated Bluetooth, audio, receivers
clients/                reference API client
audio/                  audio service start script, PipeWire/WirePlumber configuration
systemd/                service units, mDNS service definition
web/                    web interface; web/lang/ languages; web/eq/ Headphone EQ Generator
tools/                  release.js (signed releases), i18n-keys.js (translatable texts)
```

## Releases

Installations accept releases signed with the key whose public part is `lib/release-key.pub` in
the installed version.

```sh
node tools/release.js key     # once: signing key in ~/.config/adi2-pi/release-key.pem (keep a copy),
                              # public key to lib/release-key.pub – commit it
node tools/release.js build   # dist/adi2-pi-<version>.tar.gz, .zip and .tar.gz.sig from HEAD
```

Attach all three to the GitHub release. With a lost key, installations need one manual update to
a release with the new public key. Works on Linux, macOS and Windows (on Windows the key is in
`%USERPROFILE%\.config\adi2-pi\`); the archives always get Unix line endings.

## Protocol

RME "MIDI-Protocol for RME ADI-2 DAC, ADI-2 Pro and ADI-2/4 Pro SE/EX" v1.0 (2026-10-29), plus what
an ADI-2 Pro EX does:

- Device IDs 0x71 (DAC), 0x72 (Pro, Pro EX), 0x73 (2/4 Pro SE and EX; device revision 1 in the
  status message = EX).
- ADI-2/4 Pro EX: input Ref Level −35 … +24 dBu (values −6 … 4), DC Filter ADC/RME/none, RIAA with
  0 dB, Bal. Impedance, Source ADAT 3/4. Basic Mode DAC: Source lists SPDIF coax and optical
  separately. Untested on the units.
- EQ preset store: data on addresses 13/14, then the flags word separately at address 13
  **index 2** (sent by the unit at index 1, ignored there on receive). B/T Enable (13.20) and Load
  B/T (13.27) must not be part of a store: the unit switches MIDI Control off.
- Device parameter 16 (sample rate, read-only): index into 44.1 … 768 kHz. Device parameter 63
  (Do Toggle Outputs, receive only, value 0).
- Status message: the 28-bit words are numbered from the first byte's bit 0. The ADI-2 Pro EX
  reports protocol revision 2 and sends one byte more than the table lists.
- The ADI-2 Pro EX doesn't report Phones 1/2 Mute, Dim, Width, Lock Volume, Source, Mono, DA
  Filter, De-Emphasis, Loopback, DC Protection, or input Bass/Treble.
- Values without a name show as `#<number>`; Debug → *Settings ADI-2-Pi can't name yet* lists them.
