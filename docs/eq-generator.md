# Headphone EQ Generator

`http://<pi>/eq/` — fits a parametric EQ that brings a headphone's measured frequency response to
a target curve, for the RME ADI-2 (5 bands, optionally plus Bass/Treble) or the TotalMix FX Room
EQ (9 bands). Calculation runs in the browser.

## Data

- About 740 measurements by oratory1990 and the target curves, from the AutoEq repository, are
  bundled in `web/eq/data/` (`index.json` lists them).
- *Check for updated headphone data* asks `api.github.com` for the current AutoEq file list,
  downloads new and changed files from `raw.githubusercontent.com` and stores them in
  `/var/lib/adi2-pi/eq`. Downloaded files take precedence over bundled ones. *Back to the shipped
  data* deletes them. No other request leaves the Pi.
- Own measurements or targets: CSV or text files with frequency (Hz) and level (dB) columns.

## Workflow

1. **Equalizer:** RME ADI-2 or TotalMix FX Room EQ.
2. **Headphone:** search or filter (all, over-ear, in-ear) and select, or load a file.
3. **Target:** Harman over-ear 2018 or Harman in-ear 2019 is selected by headphone type; a
   manually selected target is kept when the headphone changes.
4. **Export** or apply the result (see [Output](#output)).

## Figures

| Figure | Meaning |
|---|---|
| Deviation before | RMS difference between smoothed measurement and target within the corrected range, in dB |
| Deviation after | The same with the EQ applied |
| Bands used | Bands in use / bands available |
| Peak boost | Largest boost of the EQ at any frequency |

## Charts

- **With EQ:** measurement with EQ applied, and target.
- **Measurement and target.**
- **EQ curve:** total EQ, individual bands, and the correction aimed for (dotted).

The shaded area marks the uncorrected range.

## Settings

| Setting | Default | Function |
|---|---|---|
| Bass shelf | 0 dB | Adds a low shelf to the target (frequency adjustable, default 105 Hz). |
| Tilt | 0 dB/oct | Tilts the target around the level-match frequency. |
| Correction range | full range | Optional cap: no correction above the cap frequency (default 2 kHz). |
| Compensate the DAC's Slow filter | off | ADI-2 only. Band 5 or the Treble control becomes a treble shelf that compensates the high-frequency loss of the *Slow* DA filter (loss at 20 kHz adjustable). |
| Also use Bass and Treble as EQ bands | off | ADI-2 only. Adds Bass and Treble as bands 6 and 7; requires *B/T Load with EQ* on the output. |
| Band 1 / Band 5 type | low shelf / peak | ADI-2 only. |
| Use at most … bands | all | Upper limit; bands with less benefit than *Min. benefit per band* are dropped. |
| Max boost / Max cut | 6 dB / 12 dB | Gain limits. |
| Correct from | 20 Hz | Lowest corrected frequency. |
| Smoothing | 1/6 octave | Measurement smoothing; 1 octave is used above 8 kHz. |
| Level match at | 1000 Hz | Frequency at which measurement and target are aligned. |
| Min. benefit per band | 0.05 dB | Minimum improvement for a band to be kept. |
| Round to values the device accepts | on | Frequency, gain and Q in the device's steps. |

Fit rules: boosts have Q ≤ 2, shelves Q ≤ 1; bands above 10 kHz are weighted half; the result is
valid at 44.1–192 kHz.

The **EQ settings** table accepts edited values and per-band on/off; changing a setting refits
and discards edits (*Back to fitted values* restores the fit).

## Output

### RME ADI-2

- **Open in EQ Presets:** opens the result in ADI-2-Pi's EQ preset editor (apply to an output,
  store in one of the unit's 20 presets).
- **Apply:** writes the EQ to an output of the connected unit (bands 1–5, Bass/Treble, both
  channels).
- **ADI-2 Remote preset:** `.adieqpr` file for ADI-2 Remote (*EQ Presets → File → Load*), with
  slot (1–20) and name. The file format is not documented by RME.

### TotalMix FX Room EQ

`.tmreq` file for interfaces with Room EQ: in TotalMix, Room EQ of the output → *Preset →
Import*. The preamp is set as channel gain.

### Other formats

Text table, PNG chart image (selected charts, optional table), CSV with all curves.

## Preamp

Boosts reduce headroom. If tracks clip, lower the level before the EQ by the *Peak boost* value.

## Saved settings

Settings, the selected headphone and edited bands are stored in the browser (localStorage).
