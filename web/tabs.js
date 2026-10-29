/* ADI-2-Pi – the tabs after the outputs and the input, shared by the main page and the Headphone EQ
   page (/eq/). `tr` translates a label. */
'use strict';
window.ADI2_TABS = (tr) => [
  { id: 'eqpresets', label: tr('EQ Presets') },
  { id: 'device', label: tr('Device') },
  { id: 'routing', label: tr('Pi Playback') },
  { id: 'bluetooth', label: tr('Bluetooth') },
  { id: 'streaming', label: tr('Streaming') },
  { id: 'automation', label: tr('Scenes & Actions') },
  { id: 'eq', label: tr('Headphone EQ'), href: '/eq/' },
  { id: 'bridge', label: tr('System') },
];
