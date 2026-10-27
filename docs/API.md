# ADI-2-Pi API (version 1)

One API for the web page, the Stream Deck plugin and apps. Everything the page can do goes
through this API.

- **Base URL:** `http://<pi>.local` (port 80 unless installed with another port)
- **Discovery:** mDNS/Bonjour service `_adi2._tcp`, TXT `path=/ws`, `api=1`
- **Security:** local network only; optional access key. Browser requests from other web sites
  are refused (see [Security](#security)).

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

## Schema

`GET /api/schema` (the content of `lib/schema.json`; it doesn't change while the bridge runs):

```jsonc
{
  "api": 1, "schema": "1",
  "models": { "113": "dac", "114": "pro", "115": "se" },          // device id → model key
  "modelNames": { "dac": "ADI-2 DAC", "pro": "ADI-2 Pro / Pro EX", "se": "ADI-2/4 Pro SE / Pro EX" },
  "channels": [
    { "key": "line", "name": "Line Out", "short": "LINE", "addr": 3, "eq": 4, "eqR": 5, "kind": "output", "line": true },
    { "key": "ph12", "name": "Phones 1/2", "dacName": "Phones", "short": "PH 1/2", "addr": 6, "eq": 7, "eqR": 8, "kind": "output" },
    { "key": "ph34", "name": "Phones 3/4", "dacName": "IEM", "short": "PH 3/4", "addr": 9, "eq": 10, "eqR": 11, "kind": "output" },
    { "key": "in", "name": "Analog Input", "short": "IN", "addr": 0, "eq": 1, "eqR": 2, "kind": "input", "not": ["dac"] }
  ],
  "params": {
    "output": [ … ],   // at a channel's addr, kind "output"
    "input":  [ … ],   // at the input channel's addr
    "eq":     [ … ],   // at a channel's eq (left) or eqR (right) address, outputs and input
    "device": [ … ]    // at address 12
  },
  "groups": { "level": "Level", "peq": "Parametric EQ", … },    // group id → heading
  "setups": 9,
  "eqDefaults": { "values": { "3": 1, "4": 0, … } }               // RME's defaults per EQ index
}
```

A parameter:

| Field | |
|---|---|
| `id`, `label`, `idx` | name, display label, index at the channel's address |
| `type` | `level` (number), `toggle` (0/1), `select` (index into `names`) |
| `group` | heading it belongs to (`groups`) |
| `scale` | display value = protocol integer × `scale` (default 1) |
| `min`, `max`, `step`, `unit`, `decimals` | `level` range and display, in display units |
| `log` | `level` best shown on a log scale (frequencies) |
| `names` | value names of a `select`: a list, or an object keyed by model (`pro`, `se`, `dac`) or by output type (`line`, `phones`, each again keyed by model) |
| `hide` | select values that exist but aren't offered (EQ Preset 22 = clear) |
| `only` / `not` | models that have / don't have the parameter |
| `lineOnly` | Line Out only |
| `phonesLabel` | label on the phones outputs (`ref`: Hi-Power) |
| `readonly` | can't be set (`srate`) |
| `band`, `role` | EQ band 1–5 and `gain` / `freq` / `q` |
| `note` | what a value means where the label doesn't say it |

Resolving a name: `device` → address 12 and `params.device`; an EQ id → the channel's `eq` or
`eqR`; otherwise the channel's `addr` and `params.output` or `params.input` by `kind`. Channel
names on the ADI-2 DAC are `dacName` where given.

**What to show:** a parameter applies when the model has it (`only`/`not`, the channel's `not`,
`lineOnly`) **and** the unit reports it, i.e. its `addr.idx` is in `state.p`. The ADI-2 Pro EX,
for example, reports no Mute, Dim or Source for Phones 1/2; sets for those are refused (400).

## WebSocket `/ws`

JSON text messages, each one object with `t`. Add `"rid": <anything>` to a command to get a reply
carrying the same `rid`. Without `rid`, commands that only answer `ok` are silent (you see the
effect in the broadcast); commands that return data (`get`, `ping`, `bt`, `routing`, `settings` …)
always answer. Errors always answer: `{ "t": "err", "rid", "status", "error" }`, where `status` is
the HTTP status the same request would get (see [Errors](#errors)). `status` is a number in error
replies only; the unit's status message (hex) is `unitStatus`.

The bridge pings every 25 s (WebSocket ping frames); clients that don't answer are dropped.
Standard WebSocket libraries answer by themselves.

### Bridge → client

| `t` | Fields | When |
|---|---|---|
| `hello` | `api`, `access`, `bridge {name, version, host, auth, viewOpen}`, `device` | on connect (`auth`: an access key is set; `access`: `full`, or `read` when the connection has no valid key and `viewOpen` lets it read) |
| `access` | `access` (`full` / `read`) | the connection's access changed because the key or `viewOpen` setting changed |
| `state` | `device`, `p {"addr.idx": value}`, `setups [9 names]`, `eqPresets [20]`, `unitStatus`, `statusInfo`, `silences`, `bluetooth`, `streaming`, `routing`, `trigger`, `automation`, `mqtt`, `ups`, `updates`, `nowplaying` | on connect, on `get` |
| `settings` | `settings` | on connect and when settings change |
| `p` | `p {"addr.idx": value}`, `origin` | values changed. `origin`: `device` = on the unit (knob, remote, read-back), `client` = through the bridge, `auto` = the bridge switching outputs to USB while the Pi plays, `bridge` = Loopback for Bluetooth out, `scene` / `rule` = a scene applied by a client / by an action, `profile` = a headphone profile applied, `sleep` = sleep timer, `start` = start volume, `stream` = volume of an AirPlay/Spotify sender, `restore` = restore from a backup, `mqtt` = MQTT command |
| `device` | `device` | ADI-2 connected / identified / ready / gone |
| `setups` | `setups` | setup names read from the unit |
| `eqpresets` | `eqPresets` | the unit's 20 EQ presets changed (see below) |
| `status` | `unitStatus` (hex), `info` | the unit's status message **changed** (the current one is in `state`) |
| `silences` | `silences` | the unit stopped answering, or answers again (see below) |
| `bluetooth` | `bluetooth` | Bluetooth devices, connections, pairing window, search (see below) |
| `streaming` | `streaming` | streaming receivers changed (see below) |
| `routing` | `routing` | sources playing, which is heard, sample rate (see below) |
| `trigger` | `trigger` | shut down with the ADI-2: trigger state, countdown (see below) |
| `ups` | `ups` | UPS HAT readings or settings changed (see below) |
| `nowplaying` | `nowplaying` | title, artist, play state of what the Pi plays changed (see below) |
| `updates` | `updates` | update check switched, started or finished (see below) |
| `sleep` | `sleep` | sleep timer started, fading, ended or cancelled (`null` = off; see below) |
| `automation` | `automation { sleep, fired }` | an action was applied (`fired`: the last 20, `[{ at, rule, scene, event }]`) |
| `restore` | `restore` | restore progress (see [Backup](#backup)) |
| `mqtt` | `mqtt { enabled, connected, error, topic }` | MQTT connection changed |
| `midi` | `dir` (`rx`/`tx`), `hex` | raw SysEx, only after `monitor` |
| `ok` / `err` | `rid`, `applied`, `errors?` / `status`, `error` | replies |

`device` object: `{ connected, ready, answering, id, model, modelName, port, card, problem }`.
`ready` turns true once all settings have been read. While no unit is connected, `p` is empty,
`setups` holds nine empty names, `eqPresets` twenty empty slots and `unitStatus` is `null`; after a
reconnect everything is read from the unit again and arrives as one `p` broadcast. `answering` turns false when the unit's
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
{ "t": "trigger", "enabled": true, "delaySec": 10, "source": "usb" } // shut down with the ADI-2 (10 | 30 | 60 | 300 s; usb | gpio)
{ "t": "trigger", "cancel": true }                                 // stop a running countdown
{ "t": "trigger", "pin": 17 }                                      // trigger GPIO: 3 (also wakes the Pi), 4, 17, 22, 23, 24, 25, 27
{ "t": "ups", "shutdown": true, "delaySec": 60, "lowPct": 10 }    // UPS HAT: shut down on battery (10…600 s / 5…50 %)
{ "t": "ups", "cancel": true }                                     // stop a running UPS countdown
{ "t": "updates", "check": true }                                  // daily update check on / off
{ "t": "updates", "now": true }                                    // ask GitHub once now; answers when done (429 within 30 s of the last one)
{ "t": "scene", "action": "apply", "id": "a1b2c3d4" }             // apply a scene
{ "t": "scene", "action": "save", "name": "Late night", "params": [{ "ch": "ph34", "id": "vol" }, { "ch": "ph34", "id": "loud" }] }
                                                                   // new scene from the current values (→ { t: "scene", scene })
{ "t": "scene", "action": "save", "id": "a1b2c3d4", "name": "Late night", "items": [{ "ch": "ph34", "id": "vol", "value": -35 }] }
                                                                   // replace a scene with given values
{ "t": "scene", "action": "delete", "id": "a1b2c3d4" }            // its actions are deleted too
{ "t": "profile", "action": "apply", "id": "d456eab6", "ch": "ph34" } // headphone profile onto an output (→ ok, applied)
{ "t": "profile", "action": "save", "name": "HD 650", "from": "ph34", "groups": ["eq", "bt", "loudness", "xfeed"], "limit": -10 }
                                                                   // new profile from an output's current values (→ { t: "profile", profile })
{ "t": "profile", "action": "save", "id": "d456eab6", "name": "HD 650", "items": [{ "id": "xfeed", "value": 2 }], "limit": null }
                                                                   // replace a profile with given values; limit: number, null = no limit, absent = unchanged
{ "t": "profile", "action": "delete", "id": "d456eab6" }
{ "t": "profile", "action": "clear", "ch": "ph34" }                // the output shows no profile any more (values stay)
{ "t": "sleep", "minutes": 30 }                                    // sleep timer 1…1440 min (→ { t: "sleep", sleep })
{ "t": "sleep", "cancel": true }
{ "t": "backup" }                                                  // → { t: "backup", backup }
{ "t": "restore", "backup": { … }, "parts": { "values": true, "eqPresets": true, "setups": true, "settings": true } }
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
| `GET /api/state` | `?view=named` for display values by name | the same as the WebSocket `state` (`device`, `p`, `setups`, `eqPresets`, `unitStatus`, `statusInfo`, `silences`, `bluetooth`, `streaming`, `routing`) / `{ device, state: { line: { vol: -20, …, eq: { L: {…}, R: {…} } }, device: {…} }, setups }` |
| `POST /api/set` | same as the WebSocket `set` without `t` | `{ t: "ok", applied, errors? }` |
| `POST /api/setup` | `{ action, n, name? }` (`load`, `save`, `rename`, `factory`) | `{ t: "ok" }` |
| `POST /api/refresh` | | `{ t: "ok" }` |
| `GET /api/eqpresets` | | the unit's 20 EQ presets |
| `POST /api/eqpresets/store` | `{ n, name?, L, R?, dual? }` | stores preset `n` on the unit |
| `POST /api/eqpresets/rename` | `{ n, name }` | renames preset `n` |
| `GET /api/sent` | | changes sent to the unit since start, oldest first: `[{ at, by, what }]` (`by`: web page / app + address, or ADI-2-Pi itself) |
| `GET /api/status` | | `{ unitStatus, info, answering, silences }`: last status message, raw and decoded |
| `GET /api/bluetooth` | | Bluetooth view (see below) |
| `POST /api/bluetooth` | `{ action, … }` as the WebSocket `bt` | the Bluetooth view after the action |
| `GET /api/routing` | | routing (see below) |
| `POST /api/routing` | `{ action, key? , value? }` as the WebSocket `routing` | routing after the change |
| `GET /api/streaming` | | streaming receivers (see below) |
| `POST /api/streaming` | `{ id, enabled?, server? }` | receivers after the change |
| `GET /api/trigger` | | trigger (see below) |
| `POST /api/trigger` | `{ enabled?, delaySec?, source?, cancel? }` | trigger after the change |
| `GET /api/usb` | | `{ available, card, open, rate, channels, owner, lastSet }`: the ADI-2's USB playback device |
| `POST /api/usb/rate` | `{ rate }` | sets the sample rate (Hz) by opening the playback device at it; 409 while a player uses it |
| `GET /api/settings` | | settings |
| `POST /api/settings` | partial settings | settings |
| `GET /api/scenes` | | scenes `[{ id, name, items }]` |
| `GET /api/profiles` | | `{ profiles: [{ id, name, items, limit? }], active: { line, ph12, ph34 } }` |
| `POST /api/profile` | same as the WebSocket `profile` without `t` | apply / save / delete / clear (see below) |
| `GET /api/nowplaying` | | what the Pi plays (see below) |
| `GET /api/nowplaying/cover` | `?source=airplay` | the current AirPlay cover image (404 without one) |
| `POST /api/scene` | `{ action, id?, name?, items?, params? }` as the WebSocket `scene` | reply of the command |
| `GET /api/sleep` / `POST /api/sleep` | – / `{ minutes }` or `{ cancel: true }` | sleep timer, `null` = off |
| `GET /api/automation` | | `{ sleep, fired }` |
| `GET /api/backup` | | backup file (JSON, `Content-Disposition: attachment`) |
| `POST /api/restore` | `{ backup, parts? }` or the backup itself (max. 1 MB) | 202, restore progress |
| `GET /api/restore` | | restore progress |
| `GET /api/mqtt` | | MQTT connection `{ enabled, connected, error, topic }` |
| `GET /api/ups` / `POST /api/ups` | – / `{ shutdown?, delaySec?, lowPct?, cancel? }` | UPS HAT (see below) |
| `GET /api/updates` / `POST /api/updates` | – / `{ check?, now? }` | update check (see below) |
| `POST /api/hook` | `{ receiver, value }` | volume of an AirPlay/Spotify sender; only from the Pi itself (bin/adi2-pi-hook.js) |
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
| 401 | access key missing or wrong | ask the user for the key |
| 403 | `Origin` of another web site | – |
| 404 | no such route | – |
| 409 | the unit can't do it right now: not connected, not answering (MIDI Control off), value not read yet; or Bluetooth/streaming/audio not installed or the device unreachable | show the reason, retry later (watch `device`) |
| 413 | body larger than 64 KB (restore: 1 MB) | – |
| 429 | ten wrong access keys from this address within a minute | wait a minute |
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

The unit sends a status message about once a second. `unitStatus` is the message as hex bytes
(`state.unitStatus`, `status.unitStatus`), `info` (`state.statusInfo`) holds what RME's table documents:
`activeOut` (bits 1–0 of byte 6), `revision`, `activeLine`, `ph34Active` (RME's name for bit 6;
it does not indicate playback on Phones 3/4), `mode` (current device mode), `balanced`, `dsd`,
`protocol`, the two 28-bit words `io1` / `io2` (undocumented by RME) and `extra` (bytes the ADI-2
Pro EX sends beyond the documented length) and `inputs`: `{ aes, spdif }` – `true` while the
AES input, or the SPDIF input chosen under SPDIF In (coax or optical), receives a valid digital
signal (also when the source is stopped or muted), `false` without. Decoded from IOStatus1 bits
23+21 (AES) and 24+22 (SPDIF), tested on the ADI-2 Pro EX; `null` on other models. Device parameter `srate` (index 16, read-only) is
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
    "volumeHook": true,                        // the sender's volume can set the ADI-2's (airplay, spotify; null: not known yet)
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
  "enabled": true, "delaySec": 10,
  "source": "gpio",                        // usb: USB port gone or unit not answering; gpio: Trigger Out on GPIO3
  "pin": 3,
  "model": "Raspberry Pi 4 Model B Rev 1.5", "canWake": true,   // source gpio on a Pi 4/3: starts when GPIO3 goes low
  "available": true, "reason": null,       // e.g. "GPIO3 is in use by something else – usually I²C …"
  "adiOn": true,                           // ADI-2 on (gpio: GPIO3 low; usb: connected and answering); null while disabled or unreadable
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
  "bluetooth": { "outSource": "line", "gainDb": 6, "loop": null },   // what Bluetooth headphones play: line | ph34 | analog | off; their level 0…+20 dB; loop: Loopback values the bridge replaced for them ({ saved, set } per output) until they are put back
  "receivers": { "airplay": { "enabled": true }, "spotify": { "enabled": true }, "upnp": { "enabled": true, "uuid": "…" },
                 "squeezelite": { "enabled": false, "server": "" }, "snapcast": { "enabled": false, "server": "" } },
  "routing": { "mode": "newest", "rate": 0, "usb": { "line": true, "ph34": true }, "held": { "line": null, "ph34": null } },
  "trigger": { "enabled": false, "delaySec": 10, "source": "usb", "pin": 3 },
  "ups": { "shutdown": true, "delaySec": 60, "lowPct": 10 },
  "updates": { "check": false },                     // daily update check (GitHub)
  "streamVolume": { "enabled": false, "outputs": ["line"], "minDb": -60, "maxDb": -10, "airplay": true, "spotify": true },
  "startVolume": { "enabled": false, "levels": { "line": null, "ph12": -30, "ph34": -30 } },
  "quickLevels": { "line": [], "ph12": [], "ph34": [-40, -25, -15] },   // volume buttons per output, up to 4
  "scenes": [{ "id": "a1b2c3d4", "name": "Late night", "items": [{ "ch": "ph34", "id": "vol", "value": -35 }] }],
  "profiles": [{ "id": "d456eab6", "name": "HD 650", "items": [{ "id": "eqpreset", "value": 3 }, { "id": "xfeed", "value": 2 }], "limit": -10 }],
  "activeProfile": { "line": null, "ph12": null, "ph34": "d456eab6" },  // the profile applied last per output
  "rules": [{ "id": "e5f6a7b8", "enabled": true, "name": "", "when": { "type": "time", "at": "22:00", "until": "07:00", "days": [0,1,2,3,4,5,6] }, "scene": "a1b2c3d4", "sceneEnd": "f0e1d2c3" }],
  "sleep": { "outputs": ["line", "ph12", "ph34"], "fadeSec": 60 },
  "access": { "enabled": false, "viewOpen": false },  // write { "access": { "key": "…" } } to set, "" to remove; viewOpen: reads without the key
  "mqtt": { "enabled": false, "host": "", "port": 1883, "username": "", "hasPassword": false, "base": "adi2pi", "discovery": true, "discoveryPrefix": "homeassistant" }
}
```

Settings as clients see them: the key itself is never sent (only `access.enabled`), the MQTT
password neither (`mqtt.hasPassword`; write `mqtt.password` to change it). A patch with a key that
is not a setting is refused (400, `unknown setting …`); `port` is read at start only.

Limits, rise speed and link apply to everything that goes through the bridge, but not to the
knob on the unit. Saved in `/var/lib/adi2-pi/settings.json`, written only when changed.

## UPS HAT

```jsonc
{
  "present": true, "model": "Waveshare UPS HAT (E)",   // or "… UPS HAT / UPS HAT (B)", "… (C) / (D)"; reason when none
  "available": true, "reason": null,                  // reading works
  "shutdown": true, "delaySec": 60, "lowPct": 10,     // settings
  "mains": true, "charging": true,                    // power source; charging the battery
  "batteryV": 15.88, "batteryA": 0.42,                // + = charging, − = the battery supplies the Pi
  "percent": 83, "percentFromVoltage": false,         // INA219 models: estimated from the voltage
  "inputV": 5.12, "remainingMah": 4150,               // (E) only, else null
  "minutesToEmpty": null, "minutesToFull": 38,        // (E) only
  "onBatterySince": null, "shutdownAt": null, "shuttingDown": false
}
```

Readings every 5 s. `ups` broadcasts are sent when a value changes visibly (voltages rounded to
50 mV / 100 mV for this). MQTT adds `…/ups/battery/state` (%) and `…/ups/mains/state` (`ON`/`OFF`).

## Update check

```jsonc
{
  "check": false,                     // daily check on (settings.updates.check)
  "current": "1.0.0",                 // installed version
  "checking": false,
  "lastCheck": 1793000000000,         // ms, null before the first check
  "latest": { "version": "1.0.1", "name": "ADI-2-Pi 1.0.1", "url": "https://github.com/shells-dw/adi2-pi/releases/tag/v1.0.1", "published": "2026-11-01T10:00:00Z" },
  "available": true,                  // latest is newer than current
  "error": null,                      // text of the last failed check
  "releasesUrl": "https://github.com/shells-dw/adi2-pi/releases"
}
```

The bridge asks `GET https://api.github.com/repos/shells-dw/adi2-pi/releases/latest` (drafts and
pre-releases excluded) a minute after start and then every 24 h while `check` is on, an hour after
a failed check, and once for `now`. Nothing is downloaded or installed. `latest` is `null` when no
release is published. With `check` off, no request is made unless `now` is sent.

## Volume from the sender

`streamVolume`: AirPlay (shairport-sync) and Spotify Connect (librespot, versions with
`--volume-ctrl fixed`) play at full level, and the position of the sender's volume slider sets the
volume of `outputs`: 0 % = `minDb`, 100 % = `maxDb`, in between linear in dB. The bridge's volume
limits and rise-speed limit apply. Muting on the sender mutes the outputs; the next volume
change unmutes them. One way only: the unit's knob doesn't move the sender's slider. Turning
it on or off restarts those receivers. `streaming.receivers[].volumeHook` says whether the
installed version supports it. UPnP, Squeezelite, Snapcast and Bluetooth keep their own volume.

## Start volume

`startVolume`: when the ADI-2 becomes usable (switched on, USB reconnected, MIDI Control on
again, ADI-2-Pi started), outputs louder than their level are set to it. `null` = leave alone.

## Scenes and actions

A scene is a list of values by name in display units (`{ ch, id, side?, value }`, like `set`);
applying it sets exactly these and nothing else. At most 30 scenes, 300 values each.

An action (`rules`) applies a scene when something happens. `when.type`:

| type | fields | when |
|---|---|---|
| `unit-on` | | the ADI-2 becomes usable (after the start volume) |
| `bt-connect` / `bt-disconnect` | `address` (or `any`) | a Bluetooth device connects / disconnects |
| `play-start` / `play-stop` | `source`: `any`, `bluetooth`, `airplay`, `spotify`, `upnp`, `squeezelite`, `snapcast`, `roon` | that source starts / stops playing on the Pi; `any`: the first source starts / the last one stops |
| `time` | `at` `HH:MM`, `days` 0 (Sunday) … 6, optional `until` `HH:MM` | at that minute, Pi local time. With `until`, the rule's `sceneEnd` is applied at that minute (on the same day, or the next when `until` < `at`) |
| `input-signal` / `input-lost` | `input`: `any`, `aes`, `spdif` | the digital input gets / loses a valid signal (`statusInfo.inputs`; Pro models) |
| `idle` | `minutes` 1 … 720 | the Pi has played nothing for that long; once per quiet period |

Actions only run while the unit is usable. Changes have `origin: "rule"`.

## Headphone profiles

A profile (`settings.profiles`) is a list of values of **one output** by name in display units
(`{ id, side?, value }`, ids of the output and EQ sections) and optionally `limit` (dB, `null` =
no limit). Applying it to an output (`profile apply`, `ch`) sets the values the unit reports for
that output (others are skipped), then sets `limits[ch]` when the profile has a `limit`, and
notes the profile in `activeProfile[ch]`. That note is cleared when one of the profile's values
on that output is changed any other way (`params` from the unit, a set, a scene …). Saving with
`from` and `groups` (`eq`, `bt`, `loudness`, `xfeed`, `settings`) takes the output's current
values; with Dual EQ on, EQ values come for both sides. At most 30 profiles. MQTT: a select per
output (see below).

## Now playing

```jsonc
{
  "current": "airplay",                     // the source to show: playing, most recently started; null
  "sources": {
    "airplay":   { "source": "airplay", "state": "playing", "title": "…", "artist": "…", "album": "…", "duration": 300, "position": 12, "positionAt": 1793000000000, "sender": "Phone", "cover": "/api/nowplaying/cover?source=airplay&v=3", "since": 1793000000000 },
    "spotify":   { "source": "spotify", "state": "stopped", "title": null, … "cover": "https://i.scdn.co/image/…" },   // cover: Spotify's image URL (not loaded by the web page)
    "bluetooth": { "source": "bluetooth", "state": "paused", …, "sender": "Phone" }
  }
}
```

`state`: `playing`, `paused`, `stopped`. `position` (s) was valid at `positionAt` (ms). AirPlay
comes from shairport-sync's metadata pipe (`<data dir>/shairport-sync-metadata`), Spotify Connect
from librespot's `--onevent` through `bin/adi2-pi-hook.js` (0.4 reports no titles), Bluetooth from
AVRCP (`org.bluez.MediaPlayer1`). UPnP, Squeezelite, Snapcast and Roon report nothing.

## Sleep timer

`{ until, fadeSec, outputs, fading }` or `null`. At `until − fadeSec` the volume of `outputs` goes
down by 40 dB over `fadeSec`; then they are muted and their volume is set back to the level
before the fade, so unmuting plays as before. Outputs the unit has no Mute for stay turned down.
Cancelling during the fade puts the volume back.

## Backup

`GET /api/backup`:

```jsonc
{
  "format": "adi2-pi-backup", "version": 1, "created": "2026-10-24T18:00:00.000Z", "bridge": "1.0.0",
  "model": "pro", "modelName": "ADI-2 Pro / Pro EX",
  "values": { "3.12": -200, … },          // every parameter the unit reports, except read-only ones and EQ Preset
  "setups": ["Speakers", …],               // the 9 setup names
  "eqPresets": [{ "n": 1, "name": "HD 650", "dual": false, "L": { … }, "R": { … } }],   // stored presets only
  "settings": { "name": …, "limits": …, …, "scenes": …, "rules": …, "mqtt": { … } }      // without access key, MQTT password, port, routing.held, bluetooth.loop
}
```

The content of the unit's 9 setups is not part of it: the unit doesn't send it over MIDI.
Restore (`POST /api/restore`) sends the parts one after the other with pauses (about 15 s with
20 presets) and reports progress as `{ state: running|done|error, step, done, total, message,
errors }`. Unit values are only restored to the same model (409 otherwise). Values the unit
doesn't have are skipped.

## MQTT

`mqtt`: plain MQTT 3.1.1 (no TLS), QoS 0. `<base>/<node>` (node = the Pi's host name):

| Topic | |
|---|---|
| `…/status` | `online` / `offline` (last will), retained |
| `…/<ch>/<id>/state` | value, retained: number in display units, `ON`/`OFF`, or the option name of a select |
| `…/<ch>/<id>/set` | change it, same format |
| `…/setup/set` | load a setup: number 1–9 or its name |
| `…/scene/<id>/set` | apply a scene |
| `…/sleep/state`, `…/sleep/set` | minutes left; start (minutes), 0 = cancel |
| `…/<ch>/profile/state`, `…/<ch>/profile/set` | headphone profile applied last to the output (name, `—` = none); apply by name, `—` clears |
| `…/nowplaying/state`, `…/nowplaying/attributes` | `Artist – Title` of what plays (empty = nothing); attributes JSON `{ source, state, title, artist, album, duration, sender }` |
| `…/update/state` | with the update check on: JSON `{ installed_version, latest_version, title, release_url }` (Home Assistant update entity, no install) |

Published parameters: `vol`, `mute`, `dim`, `src`, `eqen`, `eqpreset`, `bten`, `loud`, `xfeed`
of each output, `eqen` and `eqpreset` of the input, and `device/srate` (state only) – each only
if the unit reports it. With `discovery`, Home Assistant entity configs (number, switch, select,
sensor, binary_sensor, button, update; select per output for the headphone profiles) go to `<discoveryPrefix>/<component>/<node>/<object>/config`, retained; entities
that disappear get an empty config.

## Behaviour worth knowing

- The ADI-2 does not echo values set over MIDI. The bridge updates its model and broadcasts
  immediately, then reads the unit back 1.5 s after the last change, and does a full re-read
  every 30 s. If the unit didn't accept a value, the read-back corrects it.
- Changes made on the unit itself (knob, keys, IR remote) arrive as `p` with `origin: "device"`.
- Only one program can use the ADI-2's MIDI port at a time. The bridge is that program, so
  apps should talk to the bridge, not to the unit.

## Security

Without an access key, anyone on your network can control the unit, like with the IR remote.

**Access key** (`settings.access`, System tab): with a key set, every request except
`GET /api/info` needs it – HTTP header `X-ADI2PI-Key: <key>` or `Authorization: Bearer <key>`,
or `?key=<key>` in the URL (the only way for a browser WebSocket: `ws://<host>/ws?key=<key>`).
Without it: HTTP 401; a WebSocket gets `{ t: "err", status: 401 }` and is closed with code 4401.
Ten wrong keys from one address within a minute lock it out for a minute (429 / 4429). When the
key changes, open WebSockets without the new key are closed (4401). Requests from the Pi itself
(127.0.0.1, ::1) don't need it. The key is stored as a salted SHA-256 hash. It doesn't encrypt
the connection (plain HTTP).

**Reads without the key** (`access.viewOpen`, System → *Needed for: changes only*): `GET`
requests other than `/api/backup` and WebSocket connections work without the key; `hello.bridge`
and `/api/info` carry `viewOpen: true`. Such a WebSocket gets `hello.access: "read"` (with a
valid key: `"full"`), so a client knows before its first command. On it, `get`, `ping`, `usb`,
`sentlog` and `monitor` work, every other command answers `{ t: "err", status: 401 }` (the socket
stays open) – send the key on connect (`?key=`) for full access. Switching `viewOpen` off closes
those sockets (4401); removing the key, or setting one while `viewOpen` is on, sends
`{ t: "access", access }` to the connections whose access changed.

Two things stop *web pages* from other sites using the API through your browser:

- POST requests must be `application/json`, which browsers can't send cross-site without permission.
- Requests and WebSocket connections whose `Origin` is a different site are refused.

Native apps and the Stream Deck plugin send no `Origin` and are not affected; neither are pages
loaded from files (`Origin: null`, e.g. the Stream Deck property inspector). A browser-based app
hosted elsewhere can be allowed with `--allow-origin https://example.org`.

## Writing a client

`clients/adi2pi-client.js` is a client without dependencies that implements the steps below;
`test/client.test.js` tests it against the bridge.

1. Find the bridge: mDNS `_adi2._tcp` (TXT `path=/ws`, `api=1`), or a configured host name.
2. Connect to `ws://<host>:<port>/ws` (with an access key: `…/ws?key=<key>`). Check
   `hello.api` (1) and `hello.access` (`read` = the key is missing or wrong but reads are open;
   show the values, ask for the key before the first change). Close code 4401 means the key is
   missing or wrong and reads are not open. Node.js before version 22
   has no built-in WebSocket client; use the `ws` package there.
3. Fetch `GET /api/schema` once for labels, ranges, value names and names → addresses
   ([Schema](#schema)). Show only parameters whose key is in `state.p`.
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
