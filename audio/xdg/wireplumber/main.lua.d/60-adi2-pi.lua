-- ADI-2-Pi's own WirePlumber, version 0.4 (Raspberry Pi OS Bookworm).
-- Uses only the ADI-2 (no other sound cards, so other software can keep them) and Bluetooth.
alsa_monitor.properties["alsa.midi"] = false        -- the bridge talks to the ADI-2's MIDI port itself
alsa_monitor.properties["alsa.reserve"] = false     -- no desktop session to negotiate with
alsa_monitor.properties["alsa.jack-device"] = false
v4l2_monitor.enabled = false
libcamera_monitor.enabled = false

table.insert(alsa_monitor.rules, {
  matches = { { { "device.name", "matches", "alsa_card.*" } } },
  apply_properties = { ["device.disabled"] = true },
})
table.insert(alsa_monitor.rules, {
  matches = {
    { { "api.alsa.card.name", "matches", "ADI-2*" } },
    { { "alsa.card_name", "matches", "ADI-2*" } },
    { { "device.product.name", "matches", "ADI-2*" } },
  },
  -- the unit has its own volume: PipeWire never touches its mixer
  apply_properties = { ["device.disabled"] = false, ["api.alsa.soft-mixer"] = true },
})
table.insert(alsa_monitor.rules, {
  matches = { { { "node.name", "matches", "alsa_*" } } },
  apply_properties = { ["resample.quality"] = 10 },
})
