-- installed by adi2-pi: the ADI-2 is used by ADI-2-Pi's own audio service (adi2-pi-audio),
-- so desktop/login sessions leave it alone. Removed by uninstall.sh.
table.insert(alsa_monitor.rules, {
  matches = {
    { { "api.alsa.card.name", "matches", "ADI-2*" } },
    { { "alsa.card_name", "matches", "ADI-2*" } },
    { { "device.product.name", "matches", "ADI-2*" } },
  },
  apply_properties = { ["device.disabled"] = true },
})
