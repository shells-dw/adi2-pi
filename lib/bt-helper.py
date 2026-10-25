#!/usr/bin/env python3
"""
ADI-2-Pi Bluetooth helper: talks to BlueZ over D-Bus for the Node.js bridge.

Protocol: JSON lines on stdin/stdout.
  in:   {"id": 1, "cmd": "pair", "address": "AA:BB:CC:DD:EE:FF"}
  out:  {"id": 1, "ok": true, "result": …}   or   {"id": 1, "ok": false, "error": "…", "code": "org.bluez.Error.…"}
  out:  {"event": "state", "state": {…}}     whenever something changes

Pairing policy (the agent):
  - other devices (phones) can only pair while the pairing window is open ("pairing" command);
  - devices we pair ourselves ("pair" command) are accepted while that pairing runs;
  - paired devices may only use audio services (A2DP, AVRCP).
Uses python3-dbus and python3-gi from the Raspberry Pi OS repos.
"""
import json
import os
import sys
import time

try:
    import dbus
    import dbus.service
    import dbus.mainloop.glib
    from gi.repository import GLib
except ImportError as e:  # reported to the bridge, which tells the user
    sys.stdout.write(json.dumps({"event": "fatal", "error": "missing Python module: %s (install python3-dbus python3-gi)" % e.name}) + "\n")
    sys.stdout.flush()
    sys.exit(3)

BLUEZ = "org.bluez"
ADAPTER = "org.bluez.Adapter1"
DEVICE = "org.bluez.Device1"
BATTERY = "org.bluez.Battery1"
PLAYER = "org.bluez.MediaPlayer1"   # AVRCP: play state and track of a phone playing into the Pi
PROPS = "org.freedesktop.DBus.Properties"
OM = "org.freedesktop.DBus.ObjectManager"
AGENT_PATH = "/net/adi2pi/agent"
AGENT_CAPS = "NoInputNoOutput"

A2DP_SOURCE = "0000110a"  # the device sends audio (phone, computer)
A2DP_SINK = "0000110b"    # the device receives audio (headphones, speaker)
AUDIO_UUIDS = {"0000110a", "0000110b", "0000110c", "0000110d", "0000110e", "0000110f"}  # A2DP, AVDTP, AVRCP


def short(uuid):
    return str(uuid).lower()[:8]


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write("bt-helper: %s\n" % msg)
    sys.stderr.flush()


class Rejected(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.Rejected"


class Agent(dbus.service.Object):
    def __init__(self, bus, helper):
        super().__init__(bus, AGENT_PATH)
        self.h = helper

    def _may_pair(self, device):
        return self.h.pairing_open() or str(device) in self.h.outgoing

    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Release(self):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        if not self._may_pair(device):
            raise Rejected("not in pairing mode")
        return "0000"

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        if not self._may_pair(device):
            raise Rejected("not in pairing mode")

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        if not self._may_pair(device):
            raise Rejected("not in pairing mode")
        return dbus.UInt32(0)

    @dbus.service.method("org.bluez.Agent1", in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        if not self._may_pair(device):
            log("pairing request from %s refused (not in pairing mode)" % device)
            raise Rejected("not in pairing mode")

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        if not self._may_pair(device):
            raise Rejected("not in pairing mode")

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        if short(uuid) not in AUDIO_UUIDS:
            log("service %s for %s refused (audio only)" % (uuid, device))
            raise Rejected("audio services only")
        dev = self.h.objects.get(str(device), {}).get(DEVICE, {})
        if not (dev.get("Paired") or dev.get("Trusted") or self._may_pair(device)):
            raise Rejected("not paired")

    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Cancel(self):
        pass


class Helper:
    def __init__(self):
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()
        self.objects = {}            # path -> {iface: {prop: value}}
        self.alias = "ADI-2-Pi"
        self.pair_until = 0.0
        self.pair_timer = None
        self.scan_until = 0.0
        self.scan_timer = None
        self.outgoing = set()        # device paths we are pairing ourselves
        self.agent = None
        self.available = False
        self.reason = "starting"
        self.emit_timer = None
        self.inbuf = b""

        self.bus.add_signal_receiver(self._ifaces_added, dbus_interface=OM, signal_name="InterfacesAdded", bus_name=BLUEZ)
        self.bus.add_signal_receiver(self._ifaces_removed, dbus_interface=OM, signal_name="InterfacesRemoved", bus_name=BLUEZ)
        self.bus.add_signal_receiver(self._props_changed, dbus_interface=PROPS, signal_name="PropertiesChanged",
                                     bus_name=BLUEZ, path_keyword="path")
        self.bus.watch_name_owner(BLUEZ, self._owner_changed)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._stdin)

    # ------------------------------------------------------------ BlueZ objects
    def _owner_changed(self, owner):
        if owner:
            GLib.timeout_add(300, self._setup)
        else:
            self.objects = {}
            self.agent_registered = False
            self.available = False
            self.reason = "the Bluetooth service (bluetoothd) is not running"
            self.emit()

    def _setup(self):
        try:
            om = dbus.Interface(self.bus.get_object(BLUEZ, "/"), OM)
            self.objects = {str(p): {str(i): dict(v) for i, v in ifs.items()} for p, ifs in om.GetManagedObjects().items()}
        except dbus.exceptions.DBusException as e:
            self.available = False
            self.reason = "cannot reach BlueZ: %s" % e.get_dbus_message()
            self.emit()
            return False
        if not self.adapter_path():
            self.available = False
            self.reason = "no Bluetooth adapter found (is Bluetooth switched off in the Pi's config or blocked by rfkill?)"
            self.emit()
            return False
        self._register_agent()
        self._prepare_adapter()
        self.available = True
        self.reason = None
        self.emit()
        return False

    def _register_agent(self):
        try:
            if self.agent is None:
                self.agent = Agent(self.bus, self)
            mgr = dbus.Interface(self.bus.get_object(BLUEZ, "/org/bluez"), "org.bluez.AgentManager1")
            try:
                mgr.UnregisterAgent(AGENT_PATH)
            except dbus.exceptions.DBusException:
                pass
            mgr.RegisterAgent(AGENT_PATH, AGENT_CAPS)
            mgr.RequestDefaultAgent(AGENT_PATH)
        except dbus.exceptions.DBusException as e:
            log("agent: %s" % e.get_dbus_message())

    def _prepare_adapter(self):
        a = self.adapter_path()
        try:
            self._set(a, ADAPTER, "Powered", dbus.Boolean(True))
        except dbus.exceptions.DBusException as e:
            log("power on: %s" % e.get_dbus_message())
        for k, v in (("Alias", dbus.String(self.alias)), ("DiscoverableTimeout", dbus.UInt32(0)),
                     ("PairableTimeout", dbus.UInt32(0))):
            try:
                self._set(a, ADAPTER, k, v)
            except dbus.exceptions.DBusException as e:
                log("%s: %s" % (k, e.get_dbus_message()))
        if not self.pairing_open():
            self._visible(False)

    def _ifaces_added(self, path, ifaces):
        entry = self.objects.setdefault(str(path), {})
        for i, v in ifaces.items():
            entry[str(i)] = dict(v)
        if ADAPTER in ifaces and not self.available:
            GLib.timeout_add(300, self._setup)
        self.emit()

    def _ifaces_removed(self, path, ifaces):
        entry = self.objects.get(str(path))
        if entry is None:
            return
        for i in ifaces:
            entry.pop(str(i), None)
        if not entry:
            self.objects.pop(str(path), None)
        self.emit()

    def _props_changed(self, iface, changed, invalidated, path=None):
        entry = self.objects.setdefault(str(path), {}).setdefault(str(iface), {})
        entry.update(dict(changed))
        for k in invalidated:
            entry.pop(str(k), None)
        if str(iface) == PLAYER and set(changed.keys()) <= {"Position"} and not invalidated:
            return  # the position ticks every second: not worth a state message
        if str(iface) == DEVICE and changed.get("Paired") and not entry.get("Trusted"):
            # paired just now (only possible through the agent's policy): trust it, so it reconnects later
            try:
                self._set(path, DEVICE, "Trusted", dbus.Boolean(True))
            except dbus.exceptions.DBusException as e:
                log("trust: %s" % e.get_dbus_message())
        self.emit()

    def adapter_path(self):
        paths = sorted(p for p, ifs in self.objects.items() if ADAPTER in ifs)
        return paths[0] if paths else None

    def device_path(self, address):
        a = self.adapter_path()
        address = str(address or "").upper()
        for p, ifs in self.objects.items():
            d = ifs.get(DEVICE)
            if d and str(d.get("Address", "")).upper() == address and (not a or p.startswith(a + "/")):
                return p
        raise ValueError("unknown device %s" % address)

    def _set(self, path, iface, key, value):
        dbus.Interface(self.bus.get_object(BLUEZ, path), PROPS).Set(iface, key, value)

    # ------------------------------------------------------------ state
    def pairing_open(self):
        return time.time() < self.pair_until

    def state(self):
        a = self.adapter_path()
        ad = self.objects.get(a, {}).get(ADAPTER, {}) if a else {}
        devices = []
        for p, ifs in self.objects.items():
            d = ifs.get(DEVICE)
            if not d or (a and not p.startswith(a + "/")):
                continue
            uuids = {short(u) for u in d.get("UUIDs", [])}
            cls = int(d.get("Class", 0))
            devices.append({
                "address": str(d.get("Address", "")),
                "name": str(d.get("Alias") or d.get("Name") or d.get("Address", "")),
                "hasName": "Name" in d,
                "icon": str(d.get("Icon", "")),
                "paired": bool(d.get("Paired", False)),
                "bonded": bool(d.get("Bonded", d.get("Paired", False))),
                "trusted": bool(d.get("Trusted", False)),
                "connected": bool(d.get("Connected", False)),
                "blocked": bool(d.get("Blocked", False)),
                "rssi": int(d["RSSI"]) if "RSSI" in d else None,
                "battery": int(ifs[BATTERY]["Percentage"]) if BATTERY in ifs and "Percentage" in ifs[BATTERY] else None,
                "player": self._player(p),
                # what it can do with audio: from its services, or (before pairing) its device class
                "canReceive": A2DP_SINK in uuids or (not uuids and (cls >> 8) & 0x1f == 0x04 and (cls >> 2) & 0x3f in (1, 2, 5, 6, 7, 10)),
                "canSend": A2DP_SOURCE in uuids or (not uuids and (cls >> 8) & 0x1f in (0x01, 0x02)),
                "audio": bool(uuids & AUDIO_UUIDS) or (cls >> 8) & 0x1f == 0x04,
            })
        devices.sort(key=lambda x: (not x["connected"], not x["paired"], -(x["rssi"] or -999), x["name"].lower()))
        return {
            "available": self.available,
            "reason": self.reason,
            "adapter": {
                "address": str(ad.get("Address", "")),
                "name": str(ad.get("Alias", "")),
                "powered": bool(ad.get("Powered", False)),
                "discoverable": bool(ad.get("Discoverable", False)),
                "pairable": bool(ad.get("Pairable", False)),
                "discovering": bool(ad.get("Discovering", False)),
            } if a else None,
            "pairingUntil": int(self.pair_until * 1000) if self.pairing_open() else None,
            "scanUntil": int(self.scan_until * 1000) if time.time() < self.scan_until else None,
            "devices": devices,
        }

    def _player(self, device_path):
        """AVRCP player of a device: {status, track: {title, artist, album, duration}} or None."""
        for p, ifs in self.objects.items():
            pl = ifs.get(PLAYER)
            if pl is None or not p.startswith(device_path + "/"):
                continue
            t = pl.get("Track") or {}
            return {
                "status": str(pl.get("Status", "")),
                "track": {
                    "title": str(t.get("Title", "")) or None,
                    "artist": str(t.get("Artist", "")) or None,
                    "album": str(t.get("Album", "")) or None,
                    "duration": int(t.get("Duration", 0)) or None,
                },
            }
        return None

    def emit(self):
        if self.emit_timer is None:
            self.emit_timer = GLib.timeout_add(150, self._emit_now)

    def _emit_now(self):
        self.emit_timer = None
        out({"event": "state", "state": self.state()})
        return False

    # ------------------------------------------------------------ commands
    def _visible(self, on):
        a = self.adapter_path()
        if not a:
            return
        for k in ("Pairable", "Discoverable"):
            try:
                self._set(a, ADAPTER, k, dbus.Boolean(on))
            except dbus.exceptions.DBusException as e:
                log("%s: %s" % (k, e.get_dbus_message()))

    def cmd_init(self, m, done):
        if m.get("alias"):
            self.alias = str(m["alias"])[:40]
        if self.available:
            self._prepare_adapter()
        done(self.state())

    def cmd_alias(self, m, done):
        self.alias = str(m.get("name") or "ADI-2-Pi")[:40]
        a = self._need_adapter()
        self._set(a, ADAPTER, "Alias", dbus.String(self.alias))
        done(None)

    def cmd_pairing(self, m, done):
        """Open (seconds > 0) or close (0) the window in which phones can find and pair with the Pi."""
        a = self._need_adapter()
        secs = max(0, min(600, int(m.get("seconds", 120))))
        if self.pair_timer:
            GLib.source_remove(self.pair_timer)
            self.pair_timer = None
        if secs:
            self._set(a, ADAPTER, "Powered", dbus.Boolean(True))
            self.pair_until = time.time() + secs
            self._visible(True)
            self.pair_timer = GLib.timeout_add_seconds(secs, self._pairing_over)
        else:
            self._pairing_over()
        self.emit()
        done(self.state())

    def _pairing_over(self):
        self.pair_timer = None
        self.pair_until = 0
        self._visible(False)
        self.emit()
        return False

    def cmd_scan(self, m, done):
        a = self._need_adapter()
        ad = dbus.Interface(self.bus.get_object(BLUEZ, a), ADAPTER)
        secs = max(0, min(120, int(m.get("seconds", 30))))
        if self.scan_timer:
            GLib.source_remove(self.scan_timer)
            self.scan_timer = None
        if secs:
            self._set(a, ADAPTER, "Powered", dbus.Boolean(True))
            try:
                ad.SetDiscoveryFilter(dbus.Dictionary({"Transport": "bredr"}, signature="sv"))
            except dbus.exceptions.DBusException:
                pass
            try:
                ad.StartDiscovery()
            except dbus.exceptions.DBusException as e:
                if "InProgress" not in e.get_dbus_name():
                    raise
            self.scan_until = time.time() + secs
            self.scan_timer = GLib.timeout_add_seconds(secs, self._scan_over)
        else:
            self._scan_over()
        self.emit()
        done(self.state())

    def _scan_over(self):
        self.scan_timer = None
        self.scan_until = 0
        a = self.adapter_path()
        if a:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ, a), ADAPTER).StopDiscovery()
            except dbus.exceptions.DBusException:
                pass
        self.emit()
        return False

    def _device(self, m):
        p = self.device_path(m.get("address"))
        return p, dbus.Interface(self.bus.get_object(BLUEZ, p), DEVICE)

    def _bondable(self, on):
        """Pairable = the kernel stores pairing keys ("bondable"). Off, a pairing only lasts for that
        connection – even one we start ourselves. So it's on while the pairing window is open and
        while we pair something; the agent still refuses everything else."""
        a = self.adapter_path()
        if not a:
            return
        try:
            self._set(a, ADAPTER, "Pairable", dbus.Boolean(on))
        except dbus.exceptions.DBusException as e:
            log("Pairable: %s" % e.get_dbus_message())

    def cmd_pair(self, m, done, fail):
        p, dev = self._device(m)
        self.outgoing.add(p)
        self._bondable(True)

        def finished():
            self.outgoing.discard(p)
            if not self.outgoing and not self.pairing_open():
                self._bondable(False)

        def connected(*_):
            finished()
            done(None)

        def paired(*_):
            d = self.objects.get(p, {}).get(DEVICE, {})
            if "Bonded" in d and not d.get("Bonded"):
                log("%s paired but the key was not stored" % p)
            try:
                self._set(p, DEVICE, "Trusted", dbus.Boolean(True))
            except dbus.exceptions.DBusException as e:
                log("trust: %s" % e.get_dbus_message())
            dev.Connect(reply_handler=connected, error_handler=failed, timeout=45)

        def failed(e):
            finished()
            fail(e)

        d = self.objects.get(p, {}).get(DEVICE, {})
        # paired and stored: just connect. (BlueZ ≥ 5.73 tells "Bonded" apart from "Paired".)
        if d.get("Paired") and d.get("Bonded", True):
            paired()
        else:
            dev.Pair(reply_handler=paired, error_handler=failed, timeout=60)

    def cmd_connect(self, m, done, fail):
        p, dev = self._device(m)
        dev.Connect(reply_handler=lambda *_: done(None), error_handler=fail, timeout=45)

    def cmd_disconnect(self, m, done, fail):
        p, dev = self._device(m)
        dev.Disconnect(reply_handler=lambda *_: done(None), error_handler=fail, timeout=20)

    def cmd_forget(self, m, done):
        p, _ = self._device(m)
        a = self._need_adapter()
        dbus.Interface(self.bus.get_object(BLUEZ, a), ADAPTER).RemoveDevice(p)
        done(None)

    def cmd_state(self, m, done):
        done(self.state())

    def _need_adapter(self):
        a = self.adapter_path()
        if not a:
            raise ValueError(self.reason or "no Bluetooth adapter")
        return a

    def handle(self, m):
        mid = m.get("id")
        name = "cmd_%s" % m.get("cmd")
        fn = getattr(self, name, None)

        def done(result=None):
            out({"id": mid, "ok": True, "result": result})

        def fail(e):
            if isinstance(e, dbus.exceptions.DBusException):
                out({"id": mid, "ok": False, "error": e.get_dbus_message() or e.get_dbus_name(), "code": e.get_dbus_name()})
            else:
                out({"id": mid, "ok": False, "error": str(e)})

        if fn is None:
            return fail(ValueError("unknown command %s" % m.get("cmd")))
        try:
            if fn.__code__.co_argcount == 4:
                fn(m, done, fail)
            else:
                fn(m, done)
        except Exception as e:  # noqa: BLE001 – a bad argument must not take the stdin watch down
            fail(e)

    def _stdin(self, fd, cond):
        if cond & (GLib.IO_HUP | GLib.IO_ERR):
            data = b""
        else:
            data = os.read(fd, 65536)
        if not data:
            self.quit()
            return False
        self.inbuf += data
        while b"\n" in self.inbuf:
            line, self.inbuf = self.inbuf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                m = json.loads(line.decode("utf-8"))
            except ValueError:
                out({"ok": False, "error": "invalid JSON"})
                continue
            if not isinstance(m, dict):
                out({"ok": False, "error": "a command must be a JSON object"})
                continue
            try:
                self.handle(m)
            except Exception as e:  # noqa: BLE001
                out({"id": m.get("id"), "ok": False, "error": str(e)})
        return True

    def quit(self):
        # leave the adapter invisible when the bridge stops
        if self.pairing_open():
            self._pairing_over()
        self.loop.quit()

    def run(self):
        self.loop.run()


def main():
    try:
        h = Helper()
    except dbus.exceptions.DBusException as e:
        out({"event": "fatal", "error": "cannot connect to the system D-Bus: %s" % e.get_dbus_message()})
        sys.exit(4)
    h.run()


if __name__ == "__main__":
    main()
