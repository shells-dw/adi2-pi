#!/usr/bin/env python3
"""
A small stand-in for BlueZ (org.bluez) on a private D-Bus, for testing bt-helper.py without
Bluetooth hardware. Control interface net.adi2pi.Test on /test:
  AddDevice(address, name, icon, uuids)   a device shows up (as during a scan)
  IncomingPair(address) -> b              a phone tries to pair with us (asks the agent)
  Agent() -> s                            the registered agent path ('' if none)
"""
import sys
import dbus
import dbus.service
import dbus.mainloop.glib
from gi.repository import GLib

BUS = "org.bluez"
PROPS = "org.freedesktop.DBus.Properties"
OM = "org.freedesktop.DBus.ObjectManager"


class Obj(dbus.service.Object):
    def __init__(self, bus, path, iface, props, root):
        super().__init__(bus, path)
        self.path = path
        self.iface = iface
        self.props = props
        self.root = root

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, iface, key):
        return self.props[key]

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        return self.props

    @dbus.service.method(PROPS, in_signature="ssv", out_signature="")
    def Set(self, iface, key, value):
        self.update({key: value})

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, iface, changed, invalidated):
        pass

    def update(self, changed):
        self.props.update(changed)
        self.PropertiesChanged(self.iface, dbus.Dictionary(changed, signature="sv"), dbus.Array([], signature="s"))


class Adapter(Obj):
    @dbus.service.method("org.bluez.Adapter1", in_signature="", out_signature="")
    def StartDiscovery(self):
        if self.props.get("Discovering"):
            raise dbus.exceptions.DBusException("busy", name="org.bluez.Error.InProgress")
        self.update({"Discovering": dbus.Boolean(True)})
        GLib.timeout_add(100, lambda: self.root.add_device("00:11:22:33:44:55", "Test Headphones", "audio-headphones",
                                                           ["0000110b-0000-1000-8000-00805f9b34fb"], rssi=-50) and False)

    @dbus.service.method("org.bluez.Adapter1", in_signature="", out_signature="")
    def StopDiscovery(self):
        self.update({"Discovering": dbus.Boolean(False)})

    @dbus.service.method("org.bluez.Adapter1", in_signature="a{sv}", out_signature="")
    def SetDiscoveryFilter(self, f):
        self.root.filter = dict(f)

    @dbus.service.method("org.bluez.Adapter1", in_signature="o", out_signature="")
    def RemoveDevice(self, path):
        self.root.remove_device(str(path))


class Device(Obj):
    @dbus.service.method("org.bluez.Device1", in_signature="", out_signature="", async_callbacks=("ok", "err"))
    def Pair(self, ok, err):
        agent = self.root.agent_proxy()
        if not agent:
            return err(dbus.exceptions.DBusException("no agent", name="org.bluez.Error.AuthenticationRejected"))

        def accepted(*_):
            # like the kernel: the key is only stored while the adapter is bondable (Pairable)
            bonded = bool(self.root.adapter.props["Pairable"])
            self.update({"Paired": dbus.Boolean(True), "Bonded": dbus.Boolean(bonded)})
            ok()

        def refused(e):
            err(dbus.exceptions.DBusException("refused", name="org.bluez.Error.AuthenticationRejected"))

        agent.RequestConfirmation(dbus.ObjectPath(self.path), dbus.UInt32(123456), reply_handler=accepted, error_handler=refused)

    @dbus.service.method("org.bluez.Device1", in_signature="", out_signature="")
    def Connect(self):
        if self.props["Address"] == "66:66:66:66:66:66":
            raise dbus.exceptions.DBusException("br-connection-page-timeout", name="org.bluez.Error.Failed")
        self.update({"Connected": dbus.Boolean(True)})

    @dbus.service.method("org.bluez.Device1", in_signature="", out_signature="")
    def Disconnect(self):
        self.update({"Connected": dbus.Boolean(False)})
        if not self.props.get("Bonded"):  # a pairing without a stored key ends with the connection
            GLib.timeout_add(50, lambda: self.root.remove_device(self.path) and False)


class Root(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, "/")
        self.bus = bus
        self.objs = {}
        self.agent = None  # (sender, path)
        self.filter = None
        self.adapter = Adapter(bus, "/org/bluez/hci0", "org.bluez.Adapter1", {
            "Address": dbus.String("B8:27:EB:00:00:01"), "Alias": dbus.String("raspberrypi"),
            "Powered": dbus.Boolean(False), "Discoverable": dbus.Boolean(True), "Pairable": dbus.Boolean(True),
            "Discovering": dbus.Boolean(False), "DiscoverableTimeout": dbus.UInt32(180), "PairableTimeout": dbus.UInt32(0),
        }, self)
        self.objs[self.adapter.path] = self.adapter
        self.mgr = AgentManager(bus, self)
        self.test = Test(bus, self)

    @dbus.service.method(OM, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return {dbus.ObjectPath(p): {o.iface: o.props} for p, o in self.objs.items()}

    @dbus.service.signal(OM, signature="oa{sa{sv}}")
    def InterfacesAdded(self, path, ifaces):
        pass

    @dbus.service.signal(OM, signature="oas")
    def InterfacesRemoved(self, path, ifaces):
        pass

    def add_device(self, addr, name, icon, uuids, rssi=None, paired=False):
        path = "/org/bluez/hci0/dev_" + addr.replace(":", "_")
        if path in self.objs:
            return path
        props = {"Address": dbus.String(addr), "Name": dbus.String(name), "Alias": dbus.String(name),
                 "Icon": dbus.String(icon), "Paired": dbus.Boolean(paired), "Bonded": dbus.Boolean(paired),
                 "Trusted": dbus.Boolean(False), "Connected": dbus.Boolean(False), "Blocked": dbus.Boolean(False),
                 "UUIDs": dbus.Array(uuids, signature="s"), "Class": dbus.UInt32(0)}
        if rssi is not None:
            props["RSSI"] = dbus.Int16(rssi)
        d = Device(self.bus, path, "org.bluez.Device1", props, self)
        self.objs[path] = d
        self.InterfacesAdded(dbus.ObjectPath(path), {"org.bluez.Device1": props})
        return path

    def remove_device(self, path):
        d = self.objs.pop(path, None)
        if d:
            d.remove_from_connection()
            self.InterfacesRemoved(dbus.ObjectPath(path), ["org.bluez.Device1"])

    def agent_proxy(self):
        if not self.agent:
            return None
        return dbus.Interface(self.bus.get_object(self.agent[0], self.agent[1]), "org.bluez.Agent1")


class AgentManager(dbus.service.Object):
    def __init__(self, bus, root):
        super().__init__(bus, "/org/bluez")
        self.root = root

    @dbus.service.method("org.bluez.AgentManager1", in_signature="os", out_signature="", sender_keyword="sender")
    def RegisterAgent(self, path, caps, sender=None):
        self.root.agent = (sender, str(path))
        self.root.caps = str(caps)

    @dbus.service.method("org.bluez.AgentManager1", in_signature="o", out_signature="")
    def UnregisterAgent(self, path):
        if not self.root.agent:
            raise dbus.exceptions.DBusException("no agent", name="org.bluez.Error.DoesNotExist")
        self.root.agent = None

    @dbus.service.method("org.bluez.AgentManager1", in_signature="o", out_signature="")
    def RequestDefaultAgent(self, path):
        pass


class Test(dbus.service.Object):
    def __init__(self, bus, root):
        super().__init__(bus, "/test")
        self.root = root

    @dbus.service.method("net.adi2pi.Test", in_signature="sssas", out_signature="")
    def AddDevice(self, addr, name, icon, uuids):
        self.root.add_device(str(addr), str(name), str(icon), [str(u) for u in uuids])

    @dbus.service.method("net.adi2pi.Test", in_signature="s", out_signature="b")
    def IncomingPair(self, addr):
        path = self.root.add_device(str(addr), "Test Phone", "phone", ["0000110a-0000-1000-8000-00805f9b34fb"])
        agent = self.root.agent_proxy()
        try:
            agent.RequestConfirmation(dbus.ObjectPath(path), dbus.UInt32(111111))
            agent.AuthorizeService(dbus.ObjectPath(path), "0000110d-0000-1000-8000-00805f9b34fb")
        except dbus.exceptions.DBusException:
            return False
        self.root.objs[path].update({"Paired": dbus.Boolean(True), "Bonded": dbus.Boolean(True), "Connected": dbus.Boolean(True)})
        return True

    @dbus.service.method("net.adi2pi.Test", in_signature="ss", out_signature="b")
    def Authorize(self, addr, uuid):
        path = "/org/bluez/hci0/dev_" + str(addr).replace(":", "_")
        try:
            self.root.agent_proxy().AuthorizeService(dbus.ObjectPath(path), str(uuid))
            return True
        except dbus.exceptions.DBusException:
            return False

    @dbus.service.method("net.adi2pi.Test", in_signature="", out_signature="s")
    def Agent(self):
        return self.root.agent[1] if self.root.agent else ""

    @dbus.service.method("net.adi2pi.Test", in_signature="", out_signature="s")
    def Caps(self):
        return getattr(self.root, "caps", "")


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()  # DBUS_SESSION_BUS_ADDRESS = the private test bus
    name = dbus.service.BusName(BUS, bus)
    root = Root(bus)
    root.add_device("66:66:66:66:66:66", "Old Speaker", "audio-card", ["0000110b-0000-1000-8000-00805f9b34fb"], paired=True)
    print("ready", flush=True)
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
