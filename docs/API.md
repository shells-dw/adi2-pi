# ADI-2-Pi API (version 1)

One API for the web page, the Stream Deck plugin and apps. Everything the page can do goes
through this API.

- **Base URL:** `http://<pi>.local` (port 80 unless installed with another port)
- **Discovery:** mDNS/Bonjour service `_adi2._tcp`, TXT `path=/ws`, `api=1`
- **Security:** no login, local network only. Browser requests from other web sites are refused
  (see [Security](#security)).

## Parameters

Every ADI-2 setting has a protocol address `addr.idx` and an integer value, exactly as the unit
uses it. `GET /api/schema` describes all of them: label, range, scale, unit, value names per
model, and which channel and address they belong to. Display value = value × `scale`
(volume −205 × 0.1 = −20.5 dB). EQ frequencies are always plain Hz.

| addr | | addr | |
|---|---|---|---|
| 0 | Analog input | 6 | Phones 1/2 (DAC: Phones) |
| 1 / 2 | Input EQ L / R | 7 / 8 | Phones 1/2 EQ L / R |
| 3 | Line out | 9 | Phones 3/4 (DAC: IEM) |
| 4 / 5 | Line EQ L / R | 10 / 11 | Phones 3/4 EQ L / R |
| 12 | Device | | |

Instead of addresses you can use **names**: channel `line`, `ph12`, `ph34`, `in` or `device`,
plus the parameter `id` from the schema (`vol`, `mute`, `b3f` …). With names, values are in
**display units** (dB, Hz, Q). For EQ parameters, `side` is `"L"` (default) or `"R"`. The right
side only matters when Dual EQ is on.

The unit's device IDs map to models: 113 = `dac`, 114 = `pro` (also Pro EX), 115 = `se`.

## WebSocket `/ws`

JSON text messages, each one object with `t`. Add `"rid": <anything>` to a command to get a reply
carrying the same `rid`. Without `rid`, commands that only answer `ok` are silent (you see the
effect in the broadcast); commands that return data (`get`, `ping`, `bt`, `routing`, `settings` …)
always answer. Errors always answer: `{ "t": "err", "rid", "status", "error" }`, where `status` is
the HTTP status the same request would get (see [Errors](#errors)).

The bridge pings every 25 s (WebSocket ping frames); clients that don't answer are dropped.
Standard WebSocket libraries answer by themselves.

### Bridge → client

| `t` | Fields | When |
|---|---|---|
| `hello` | `api`, `bridge {name, version, host}`, `device` | on connect |
| `state` | `device`, `p {"addr.idx": value}`, `setups [9 names]`, `eqPresets [20]`, `status`, `statusInfo`, `silences`, `bluetooth`, `streaming`, `routing`, `trigger` | on connect, on `get` |
| `settings` | `settings` | on connect and when settings change |
| `p` | `p {"addr.idx": value}`, `origin` | values changed. `origin`: `device` = on the unit (knob, remote, read-back), `client` = through the bridge, `auto` = the bridge switching outputs to USB while the Pi plays |
| `device` | `device` | ADI-2 connected / identified / ready / gone |
| `setups` | `setups` | setup names read from the unit |
| `eqpresets` | `eqPresets` | the unit's 20 EQ presets changed (see below) |
| `status` | `status` (hex), `info` | the unit's status message **changed** (the current one is in `state`) |
| `silences` | `silences` | the unit stopped answering, or answers again (see below) |
| `bluetooth` | `bluetooth` | Bluetooth devices, connections, pairing window, search (see below) |
| `streaming` | `streaming` | streaming receivers changed (see below) |
| `routing` | `routing` | sources playing, which is heard, sample rate (see below) |
| `trigger` | `trigger` | shut down with the ADI-2: trigger state, countdown (see below) |
| `midi` | `dir` (`rx`/`tx`), `hex` | raw SysEx, only after `monitor` |
| `ok` / `err` | `rid`, `applied`, `errors?` / `status`, `error` | replies |

`device` object: `{ connected, ready, answering, id, model, modelName, port, card, problem }`.
`ready` turns true once all settings have been read. `answering` turns false when the unit's
status messages stop for 4 s (MIDI Control switched off on the unit); sets, setups and preset
stores are then refused with an error, and it turns true again by itself. `problem` is
`{code, text}` while not connected or not answering; codes are `notfound`, `busy`, `access`,
`silent` (unit doesn't answer: MIDI Control off) and `disconnected`.

`silences`: the last five times the unit stopped answering,
`[{ lastRx, at, back, sent: [{ at, what, hex }] }]`. `sent` lists what the bridge sent in the 20 s
before (routine re-reads left out), `what` in plain words such as `store EQ preset 3 (flags word)`.

### Client → bridge

```jsonc
{ "t": "set", "ch": "ph34", "id": "vol", "value": -20.5 }           // by name, display units
{ "t": "set", "ch": "ph34", "id": "vol", "delta": 0.5 }             // relative; on toggles: flip; on selects: next/previous
{ "t": "set", "ch": "line", "id": "b3g", "side": "R", "value": 2 }
{ "t": "set", "set": [ { "ch": "line", "id": "mute", "value": 1 }, { "ch": "ph12", "id": "dim", "value": 1 } ] }
{ "t": "set", "p": { "9.12": -205, "12.15": 1 } }                   // by address, protocol integers
{ "t": "setup", "action": "load", "n": 3 }                         // load | save (n = 1…9) | factory
{ "t": "setup", "action": "save", "n": 3, "name": "Speakers" }     // save the current state; name optional (max. 14 characters)
{ "t": "setup", "action": "rename", "n": 3, "name": "Speakers" }   // name only, the setup's content stays
{ "t": "storePreset", "n": 3, "name": "HD 650", "L": { "4": 12, "5": 76 }, "dual": false }  // store EQ preset 1–20
{ "t": "renamePreset", "n": 3, "name": "HD 650 bass" }            // name only (max. 14 characters)
{ "t": "usb" }                                                     // → { t: "usb", usb: { available, open, rate, owner, lastSet } }
{ "t": "usbRate", "rate": 48000 }                                  // without the audio service only (--no-bluetooth); otherwise use routing rate
{ "t": "bt", "action": "pairing", "seconds": 120 }                 // Pi visible for phones to pair (0 = stop)
{ "t": "bt", "action": "scan", "seconds": 30 }                     // search for headphones/speakers (0 = stop)
{ "t": "bt", "action": "pair", "address": "14:3F:A6:01:02:03" }    // pair, trust and connect
{ "t": "bt", "action": "connect" | "disconnect" | "forget", "address": "…" }
{ "t": "bt", "action": "volume", "address": "…", "value": 0.6 }   // Bluetooth output volume, 0–1.5 (cubic, like wpctl)
{ "t": "bt", "action": "outSource", "value": "line" }             // what headphones play: line | ph34 | analog | off
{ "t": "bt", "action": "gain", "value": 6 }                        // level to Bluetooth outputs, 0…+20 dB (default +6)
{ "t": "receiver", "id": "squeezelite", "enabled": true, "server": "lms.local" }  // streaming receiver on/off, server ('' = automatic)
{ "t": "routing", "action": "switch", "key": "node:93" }            // make a playing source the heard one
{ "t": "routing", "action": "mode", "value": "newest" }            // newest | mix
{ "t": "routing", "action": "rate", "value": 96000 }               // 0 = follow what plays, or 44100 … 192000
{ "t": "routing", "action": "usb", "value": { "ph34": false } }    // switch these outputs to USB while the Pi plays
{ "t": "trigger", "enabled": true, "delaySec": 10 }                // shut down with the ADI-2 (10 | 30 | 60 | 300 s)
{ "t": "trigger", "cancel": true }                                 // stop a running countdown
{ "t": "get" }                                                     // full state again
{ "t": "refresh" }                                                 // re-read everything from the unit
{ "t": "settings", "patch": { "limits": { "ph12": -6 } } }         // bridge settings, see below
{ "t": "monitor", "on": true }                                     // receive raw MIDI traffic
{ "t": "raw", "hex": "F0 00 20 0D 72 03 09 F7" }                   // send raw SysEx (RME messages only)
{ "t": "ping" }                                                    // → { "t": "pong" }
{ "t": "sentlog" }                                                 // → { "t": "sentlog", "sent": [{ at, by, what }] }
```

Set values are clamped to the parameter's range and to the bridge's volume limits. The reply's
`applied` shows what was really sent, as `addr.idx` → integer. Several sets in one message, or
in quick succession, are combined into one SysEx message.

A set is refused (400) when: the name or address is unknown; the value isn't a number; a select
value is outside its list (`delta` on a select steps and wraps instead); the parameter is
read-only (`srate`); the address is EQ preset data (13/14 – use `storePreset`); or the unit,
after reading out its settings, doesn't have that parameter (on an ADI-2 Pro EX: Phones 1/2
Mute, Dim, Source …). With several items, the good ones are applied and the reply is `ok` with
`applied` plus `errors: ["…"]` for the others; only when nothing could be applied is it an `err`.
While the unit is not connected or not answering, sets are refused with 409.

## HTTP

| Request | Body / query | Response |
|---|---|---|
| `GET /api/info` | | `{ api, bridge, device }` |
| `GET /api/schema` | | parameter schema |
| `GET /api/state` | `?view=named` for display values by name | the same as the WebSocket `state` (`device`, `p`, `setups`, `eqPresets`, `status`, `statusInfo`, `silences`, `bluetooth`, `streaming`, `routing`) / `{ device, state: { line: { vol: -20, …, eq: { L: {…}, R: {…} } }, device: {…} }, setups }` |
| `POST /api/set` | same as the WebSocket `set` without `t` | `{ t: "ok", applied, errors? }` |
| `POST /api/setup` | `{ action, n, name? }` (`load`, `save`, `rename`, `factory`) | `{ t: "ok" }` |
| `POST /api/refresh` | | `{ t: "ok" }` |
| `GET /api/eqpresets` | | the unit's 20 EQ presets |
| `POST /api/eqpresets/store` | `{ n, name?, L, R?, dual? }` | stores preset `n` on the unit |
| `POST /api/eqpresets/rename` | `{ n, name }` | renames preset `n` |
| `GET /api/sent` | | changes sent to the unit since start, oldest first: `[{ at, by, what }]` (`by`: web page / app + address, or ADI-2-Pi itself) |
| `GET /api/status` | | `{ status, info, answering, silences }`: last status message, raw and decoded |
| `GET /api/bluetooth` | | Bluetooth view (see below) |
| `POST /api/bluetooth` | `{ action, … }` as the WebSocket `bt` | the Bluetooth view after the action |
| `GET /api/routing` | | routing (see below) |
| `POST /api/routing` | `{ action, key? , value? }` as the WebSocket `routing` | routing after the change |
| `GET /api/streaming` | | streaming receivers (see below) |
| `POST /api/streaming` | `{ id, enabled?, server? }` | receivers after the change |
| `GET /api/trigger` | | trigger (see below) |
| `POST /api/trigger` | `{ enabled?, delaySec?, cancel? }` | trigger after the change |
| `GET /api/usb` | | `{ available, card, open, rate, channels, owner, lastSet }`: the ADI-2's USB playback device |
| `POST /api/usb/rate` | `{ rate }` | sets the sample rate (Hz) by opening the playback device at it; 409 while a player uses it |
| `GET /api/settings` | | settings |
| `POST /api/settings` | partial settings | settings |
| `GET /api/eq/index` | | headphone and target list, plus `origin { ref, generated, source: bundled\|updated }` |
| `GET /api/eq/file?path=…` | a `path` from the list | measurement / target CSV, from the Pi (never the internet) |
| `POST /api/eq/update` | `{}` | starts downloading new/changed measurements from GitHub; the **only** request that uses the internet |
| `GET /api/eq/update` | | progress: `{ state: idle\|running\|done\|error, step, done, total, added, changed, message }` |
| `POST /api/eq/reset` | `{}` | deletes downloaded updates, back to the shipped data |

POST requests need `Content-Type: application/json` and a JSON object as body (max. 64 KB).

### Errors

Errors return `{ "error": "…" }` (WebSocket: `{ t: "err", status, error }`) with:

| Status | Meaning | What a client should do |
|---|---|---|
| 400 | bad request: unknown command/parameter, value out of list, not a number, invalid JSON | fix the request; don't retry |
| 403 | `Origin` of another web site | – |
| 404 | no such route | – |
| 409 | the unit can't do it right now: not connected, not answering (MIDI Control off), value not read yet; or Bluetooth/streaming/audio not installed or the device unreachable | show the reason, retry later (watch `device`) |
| 413 | body larger than 64 KB | – |
| 415 | POST without `Content-Type: application/json` | – |

```sh
curl http://adi2.local/api/state?view=named
curl -X POST http://adi2.local/api/set -H 'Content-Type: application/json' -d '{"ch":"ph34","id":"vol","delta":-1}'
```

## EQ presets

The unit holds 20 EQ presets that every output can load (its EQ Preset select, schema id
`eqpreset`: 0 Manual, 1 Temp, 2–21 = preset 1–20). ADI-2-Pi reads them after connecting and
every 2 minutes, and after a setup is loaded.

```jsonc
{ "n": 3, "name": "HD 650", "empty": false, "dual": false,
  "L": { "3": 1, "4": 12, "5": 76, "6": 8, …, "19": 10, "21": 0, "22": 85, … "26": 7 },  // EQ index → protocol integer
  "R": { "3": 1, "4": 12, … "19": 10 } }
```

A preset holds what the unit itself sends for one: `L` the bands (EQ indices 3–19) and Bass/Treble
gain, frequency and Q (21–26), `R` only the bands. B/T Enable (20) and "Load B/T with preset"
(27) are settings of each output, not preset data, and are never sent in a store (an ADI-2 Pro EX
switches MIDI Control off when a store contains them). When an output loads a preset,
Bass/Treble come along only if that output's "Load B/T with preset" is on.

Values are protocol integers (gain 12 = +6 dB, Q 8 = 0.8, frequencies in Hz). When storing,
missing values are filled with RME's defaults (`schema.eqDefaults`); without `dual`, the right
side gets the left bands. Names are at most 14 characters. Storing: data on addresses 13/14,
the name (command 06), then the flags word, and ADI-2-Pi reads the preset back. The flags word
goes to the unit at address 13 **index 2**; the unit itself sends it at index 1 (and ignores a
received index 1).

## Status message

The unit sends a status message about once a second. `info` holds what RME's table documents:
`activeOut` (bits 1–0 of byte 6), `revision`, `activeLine`, `ph34Active` (RME's name for bit 6;
it does not indicate playback on Phones 3/4), `mode` (current device mode), `balanced`, `dsd`,
`protocol`, the two 28-bit words `io1` / `io2` (undocumented by RME) and `extra` (bytes the ADI-2
Pro EX sends beyond the documented length). Device parameter `srate` (index 16, read-only) is
the current sample rate: 0–9 = 44.1, 48, 88.2, 96, 176.4, 192, 352.8, 384, 705.6, 768 kHz.

## Bluetooth

```jsonc
{
  "available": true, "reason": null,
  "adapter": { "address": "DC:A6:32:…", "name": "ADI-2-Pi", "powered": true, "discoverable": false, "pairable": false, "discovering": false },
  "pairingUntil": null,            // ms timestamp while phones can pair
  "scanUntil": null,               // ms timestamp while searching
  "devices": [{
    "address": "14:3F:A6:01:02:03", "name": "WH-1000XM5", "icon": "audio-headphones",
    "paired": true, "trusted": true, "connected": true, "rssi": null, "battery": 80,
    "canReceive": true,            // headphones/speaker: the ADI-2 can play to it
    "canSend": false,              // phone/computer: it can play into the ADI-2
    "audioIn": null,               // { codec, state, linked } while it plays into the ADI-2
    "audioOut": { "codec": "ldac", "state": "running", "linked": true, "volume": 0.7, "mute": false }
  }],
  "audio": { "available": true, "reason": null, "adi": { "sink": {…}, "source": {…} } },
  "outSource": "line",
  "gainDb": 6,                     // added on the ADI-2's record side (only Bluetooth outputs use it)
  "loopback": { "line": 3 }        // the Loopback values ADI-2-Pi has set for Bluetooth out (null = none)
}
```

Listed devices: paired ones, plus audio devices found by a running search. Pairing from other
devices is only accepted while the pairing window is open; paired devices may use audio services
(A2DP, AVRCP) only. With `outSource` `line` or `ph34`, connecting Bluetooth headphones sets that
output's Loopback (index 17) to 3 = “post FX −6 dB” and frees USB record 1/2 from the other
output; the earlier values come back when no Bluetooth output is connected.

## Streaming

```jsonc
{
  "audio": true,                   // the audio service's PulseAudio socket is there
  "name": "ADI-2-Pi",              // what apps see
  "receivers": [{
    "id": "airplay",               // airplay | spotify | upnp | squeezelite | snapcast | roon
    "label": "AirPlay", "about": "…",
    "installed": true, "enabled": true, "running": true, "since": 1792690968116,
    "playing": true, "rate": 44100,            // from its PipeWire stream
    "error": null,                             // last problem in plain words, while enabled
    "variant": "AirPlay (classic)",            // or "AirPlay 2" (airplay only)
    "hasServer": false, "server": undefined     // squeezelite, snapcast: '' = find automatically
  }, …, { "id": "roon", "external": true, … }] // Roon Bridge: status only (its own service)
}
```

## Routing

```jsonc
{
  "available": true, "reason": null,
  "mode": "newest",                // newest | mix
  "rate": 0,                       // setting: 0 = follow what plays, else fixed
  "forceRate": 0,                  // what PipeWire currently forces (clock.force-rate)
  "current": 44100,                // the ADI-2's rate while something plays
  "sources": [{
    "key": "bt:AC:37:43:AA:BB:CC", // bt:<address> or node:<PipeWire node id>
    "kind": "bluetooth",           // bluetooth | receiver | app
    "receiver": null,              // airplay | spotify | upnp | squeezelite | snapcast | roon
    "label": "Pixel 8", "playing": true, "active": false, "muted": true, "rate": 44100
  }],
  "auto": {                        // outputs switched to USB while the Pi plays
    "usb": { "line": true, "ph34": true },  // setting
    "held": { "line": 0, "ph34": null },    // source to go back to (null: not switched)
    "active": true,                // the Pi plays, or stopped less than ~10 s ago
    "last": { "at": 1761200000000, "what": "usb", "outputs": ["line"] }
  }
}
```

With `newest`, the source that started playing last is heard; ADI-2-Pi mutes the other playing
ones (PipeWire stream/node mute) and unmutes them when they become the newest again.

Parameter changes made by the USB switching are broadcast with `origin: "auto"`.

## Trigger

```jsonc
{
  "enabled": true, "delaySec": 10, "pin": 3,
  "model": "Raspberry Pi 4 Model B Rev 1.5", "canWake": true,   // Pi 4/3 start when GPIO3 goes low
  "available": true, "reason": null,       // e.g. "GPIO3 is in use by something else – usually I²C …"
  "adiOn": true,                           // trigger on (GPIO3 low); null while off or unreadable
  "armed": true,                           // the ADI-2 was seen on: a standby will shut the Pi down
  "shutdownAt": null,                      // ms timestamp of the shutdown while counting down
  "shuttingDown": false
}
```

## Bridge settings

```jsonc
{
  "name": "ADI-2-Pi",
  "port": 80,                                          // set by the installer
  "limits": { "line": null, "ph12": 0, "ph34": 0 },    // max dB the bridge will set, null = none
  "riseDbPerSec": 0,                                   // limit how fast volume may rise, 0 = off
  "link": [],                                          // e.g. ["ph12","ph34"]: these volumes move together
  "bluetooth": { "outSource": "line", "gainDb": 6 },   // what Bluetooth headphones play: line | ph34 | analog | off; their level 0…+20 dB
  "receivers": { "airplay": { "enabled": true }, "spotify": { "enabled": true }, "upnp": { "enabled": true, "uuid": "…" },
                 "squeezelite": { "enabled": false, "server": "" }, "snapcast": { "enabled": false, "server": "" } },
  "routing": { "mode": "newest", "rate": 0, "usb": { "line": true, "ph34": true }, "held": { "line": null, "ph34": null } },
  "trigger": { "enabled": false, "delaySec": 10 }
}
```

Limits, rise speed and link apply to everything that goes through the bridge, but not to the
knob on the unit. Saved in `/var/lib/adi2-pi/settings.json`, written only when changed.

## Behaviour worth knowing

- The ADI-2 does not echo values set over MIDI. The bridge updates its model and broadcasts
  immediately, then reads the unit back 1.5 s after the last change, and does a full re-read
  every 30 s. If the unit didn't accept a value, the read-back corrects it.
- Changes made on the unit itself (knob, keys, IR remote) arrive as `p` with `origin: "device"`.
- Only one program can use the ADI-2's MIDI port at a time. The bridge is that program, so
  apps should talk to the bridge, not to the unit.

## Security

There is no login: anyone on your network can control the unit, like with the IR remote. Two
things stop *web pages* from other sites doing it through your browser:

- POST requests must be `application/json`, which browsers can't send cross-site without permission.
- Requests and WebSocket connections whose `Origin` is a different site are refused.

Native apps and the Stream Deck plugin send no `Origin` and are not affected; neither are pages
loaded from files (`Origin: null`, e.g. the Stream Deck property inspector). A browser-based app
hosted elsewhere can be allowed with `--allow-origin https://example.org`.

## Writing a client

`clients/adi2pi-client.js` is a client without dependencies that implements the steps below;
`test/client.test.js` tests it against the bridge.

1. Find the bridge: mDNS `_adi2._tcp` (TXT `path=/ws`, `api=1`), or a configured host name.
2. Connect to `ws://<host>:<port>/ws`. Check `hello.api` (1). Node.js before version 22 has no
   built-in WebSocket client; use the `ws` package there.
3. Fetch `GET /api/schema` once for labels, ranges, value names and names → addresses.
4. Keep the values: `state.p` on connect, then apply every `p` broadcast. Use them only while
   `device.connected && device.ready && device.answering !== false`; after `device` turns ready
   again, send `{ t: "get" }` for fresh values.
5. Send changes by name with a `rid`: `{ t: "set", ch: "ph34", id: "vol", delta: 0.5, rid }`. For
   dials, send `delta` steps; the bridge combines quick steps into one MIDI message and applies
   the volume limits and the rise-speed limit.
6. On close, reconnect with a backoff (1 s … 15 s).

```js
const { Adi2PiClient } = require('./adi2pi-client');
const c = new Adi2PiClient({ url: 'ws://adi2-pi.local/ws', WebSocket: require('ws') });
c.on('ready', async () => {
  await c.loadSchema();
  console.log('Phones 3/4:', c.get('ph34', 'vol'), 'dB');
  await c.set('ph34', 'vol', { delta: -1 });             // rejects with err.status 400 / 409
});
c.on('param', (key, value, origin) => { /* update the key image */ });
c.start();
```
