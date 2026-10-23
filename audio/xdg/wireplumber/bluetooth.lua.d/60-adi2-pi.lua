-- ADI-2-Pi's own WirePlumber, version 0.4: Bluetooth audio in both directions (A2DP only).
bluez_monitor.enabled = true                          -- (user sessions have it switched off)
bluez_monitor.properties["with-logind"] = false       -- a system service has no seat
bluez_monitor.properties["bluez5.roles"] = "[ a2dp_sink a2dp_source ]"
bluez_monitor.properties["bluez5.enable-sbc-xq"] = true
bluez_monitor.properties["bluez5.hfphsp-backend"] = "none"
bluez_midi_monitor.enabled = false

table.insert(bluez_monitor.rules, {
  matches = { { { "device.name", "matches", "bluez_card.*" } } },
  apply_properties = { ["bluez5.auto-connect"] = "[ a2dp_sink a2dp_source ]" },
})
table.insert(bluez_monitor.rules, {
  matches = { { { "node.name", "matches", "bluez_*" } } },
  apply_properties = { ["resample.quality"] = 10 },
})
