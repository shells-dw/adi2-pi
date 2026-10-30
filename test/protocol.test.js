'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/protocol');
const cat = require('../lib/catalog');

const bytes = (s) => s.split(' ').map((x) => parseInt(x, 16));

test('encodes messages captured on a real ADI-2', () => {
  // RME table example: Phones 3/4 volume −10 dB
  assert.deepStrictEqual(P.encodeParam(9, 12, -100), bytes('4B 1F 1C'));
  // captured on an ADI-2 Pro EX: Phones 3/4 −29.5 / −28.5 dB
  assert.deepStrictEqual(P.encodeParam(9, 12, -295), bytes('4B 1D 59'));
  assert.deepStrictEqual(P.encodeParam(9, 12, -285), bytes('4B 1D 63'));
  // forum captures: DA filter (addr 3 idx 9), AD filter (addr 0 idx 7)
  assert.deepStrictEqual(P.encodeParam(3, 9, 4), bytes('1A 20 04'));
  assert.deepStrictEqual(P.encodeParam(0, 7, 2), bytes('01 60 02'));
  // dump bytes: input EQ L band 1 = 100 Hz
  assert.deepStrictEqual(P.decodeParam(...bytes('09 20 64')), { addr: 1, idx: 5, value: 100 });
});

test('frames and parses a full message', () => {
  const [m] = P.paramsToDevice(0x72, [{ addr: 9, idx: 12, value: -295 }]);
  assert.strictEqual(P.hex(m), 'F0 00 20 0D 72 02 4B 1D 59 F7');
  const back = P.parse(m);
  assert.strictEqual(back.id, 0x72);
  assert.deepStrictEqual(back.params, [{ addr: 9, idx: 12, value: -295 }]);
  assert.strictEqual(P.hex(P.requestAll(0x72)), 'F0 00 20 0D 72 03 09 F7');
  assert.strictEqual(P.hex(P.toggleOutputs(0x72)), 'F0 00 20 0D 72 02 67 70 00 F7', 'device parameter 63, value 0');
  assert.strictEqual(P.hex(P.loadSetup(0x72, 3)), 'F0 00 20 0D 72 04 03 F7');
  assert.strictEqual(P.hex(P.saveSetup(0x72, 3)), 'F0 00 20 0D 72 04 0C F7');
});

test('round-trips every parameter range', () => {
  for (const v of [-2048, -1145, -1, 0, 1, 60, 2047]) assert.strictEqual(P.decodeParam(...P.encodeParam(3, 12, v)).value, v);
  for (const v of [0, 1, 5, 2047]) assert.strictEqual(P.decodeParam(...P.encodeParam(12, 63, v)).value, v);
  for (const hz of [20, 100, 1000, 2047, 2050, 3450, 10000, 20000]) assert.strictEqual(P.decodeParam(...P.encodeParam(4, 5, hz)).value, hz);
  // EQ preset data (addresses 13/14) uses the same frequency encoding
  assert.strictEqual(P.decodeParam(...P.encodeParam(13, 11, 2540)).value, 2540);
  assert.strictEqual(P.decodeParam(...P.encodeParam(14, 18, 15000)).value, 15000);
  // treble frequency (idx 25) also uses the ×10 flag
  assert.strictEqual(P.decodeParam(...P.encodeParam(7, 25, 6000)).value, 6000);
});

test('splits a byte stream into SysEx messages', () => {
  const out = [];
  const s = new P.SysexSplitter((m) => out.push(P.hex(m)));
  s.push(Buffer.from([0xf8, 0xf0, 0x00, 0x20]));
  s.push(Buffer.from([0x0d, 0x72, 0xfe, 0x07, 0xf7, 0x90, 0x40, 0xf0, 0x01, 0xf7]));
  assert.deepStrictEqual(out, ['F0 00 20 0D 72 07 F7', 'F0 01 F7']);
});

test('setup names are read from command 0x05', () => {
  const m = P.parse(P.frame(0x72, 0x05, [0x21, ...Buffer.from('UCX II AES      ')]));
  assert.deepStrictEqual(m.setup, { n: 1, name: 'UCX II AES' });
});

test('catalog resolves names both ways', () => {
  assert.deepStrictEqual((({ addr, idx }) => ({ addr, idx }))(cat.resolve('ph34', 'vol')), { addr: 9, idx: 12 });
  assert.deepStrictEqual((({ addr, idx }) => ({ addr, idx }))(cat.resolve('ph12', 'b3f', 'R')), { addr: 8, idx: 11 });
  assert.deepStrictEqual((({ addr, idx }) => ({ addr, idx }))(cat.resolve('device', 'clock')), { addr: 12, idx: 15 });
  assert.strictEqual(cat.lookup('10.4').id, 'b1g');
  assert.strictEqual(cat.fromDisplay(cat.sections.output.vol, -10), -100);
  assert.strictEqual(cat.fromDisplay(cat.sections.output.vol, 99), 60);
  assert.strictEqual(cat.fromDisplay(cat.sections.eq.b3f, 3453), 3450);
  assert.strictEqual(cat.valueNames(cat.sections.output.ref, 'pro', cat.channelByKey.ph12)[1], 'Hi-Power');
  assert.strictEqual(cat.valueNames(cat.sections.output.ref, 'pro', cat.channelByKey.line)[0], '+4 dBu');
  // ADI-2/4 Pro SE / EX line outputs: five levels (manuals and specs), not the Pro's four
  assert.deepStrictEqual(cat.valueNames(cat.sections.output.ref, 'se', cat.channelByKey.line), ['+1 dBu', '+7 dBu', '+13 dBu', '+19 dBu', '+24 dBu']);
});

test('profiles: ADI-2/4 Pro EX and Basic Mode DAC', () => {
  assert.deepStrictEqual(cat.profileKeys('se-ex@dac'), ['se-ex@dac', 'se@dac', 'se-ex', 'se']);
  assert.deepStrictEqual(cat.profileKeys('pro'), ['pro']);
  const src = cat.sections.output.src, line = cat.channelByKey.line;
  assert.strictEqual(cat.valueNames(src, 'pro', line)[3], 'Analog');
  assert.strictEqual(cat.valueNames(src, 'pro@dac', line)[3], 'Optical');
  assert.strictEqual(cat.valueNames(src, 'se-ex', line)[6], 'ADAT 3/4');
  assert.strictEqual(cat.valueNames(src, 'se-ex@dac', line)[2], 'SPDIF c');
  const inref = cat.sections.input.inref;
  assert.strictEqual(cat.valueBase(inref, 'se'), 0);
  assert.strictEqual(cat.valueName(inref, 'se', null, 0), '+1 dBu');
  assert.strictEqual(cat.valueBase(inref, 'se-ex'), -6);
  assert.strictEqual(cat.valueName(inref, 'se-ex', null, -6), '-35 dBu');
  assert.strictEqual(cat.valueName(inref, 'se-ex', null, 0), '+1 dBu');
  assert.strictEqual(cat.valueName(cat.sections.input.riaa, 'se-ex', null, 1), '0 dB');
  assert.strictEqual(cat.valueName(cat.sections.input.riaa, 'se', null, 1), '+14 dB');
  assert.strictEqual(cat.valueName(cat.sections.input.dcfilt, 'se-ex', null, 0), 'ADC');
  assert.strictEqual(cat.available(cat.sections.input.balimp, 'se'), false);
  assert.strictEqual(cat.available(cat.sections.input.balimp, 'se-ex@dac'), true);
  assert.strictEqual(cat.available(cat.sections.input.riaa, 'se-ex'), true);
  assert.strictEqual(cat.available(cat.sections.device.dsddirect, 'se-ex'), false);
  assert.strictEqual(cat.valueName(cat.sections.device.key26, 'se', null, 65), 'RIAA Mono B.');
});

test('status message: RME example (SE) and an ADI-2 Pro EX capture', () => {
  const se = P.parseStatus(P.unhex('11 30 7E 08 00 00 00 02 04 01 11 00'));
  assert.strictEqual(se.activeOut, 1);
  assert.strictEqual(se.activeLine, 1);
  assert.strictEqual(se.ph34Active, false);
  assert.strictEqual(se.mode, 1);
  assert.strictEqual(se.io1, 0x30 | (0x7e << 7) | (0x08 << 14), 'first byte = bits 6–0');
  assert.strictEqual(se.protocol, 1);
  assert.strictEqual(se.eightChannel, true);
  assert.strictEqual(se.spdif.optical, true);
  assert.strictEqual(se.adat, true);
  assert.strictEqual(se.clock, 'internal');
  assert.strictEqual(se.internalRate, 48000, 'bits 20–16 = code 2');
  assert.deepStrictEqual(se.highLoad, [false, false]);
  assert.strictEqual(se.dacModeRateCode, 0);
  assert.strictEqual(se.penta, false);
  assert.strictEqual(se.bitTest, null, 'byte 18 not sent');
  assert.strictEqual(se.dcLine, null, 'byte 18 not sent');
  const ex = P.parseStatus(P.unhex('05 75 64 08 40 00 0A 02 00 01 12 01 00 00'));
  assert.strictEqual(ex.revision, 1);
  assert.strictEqual(ex.io2, (0x0a << 7) | (0x02 << 14));
  assert.strictEqual(ex.protocol, 2);
  assert.strictEqual(ex.eightChannel, true);
  assert.strictEqual(ex.dcLine, false);
  assert.strictEqual(ex.bitTest, 0);
  assert.strictEqual(ex.internalRate, 48000);
  assert.strictEqual(ex.extra, '00', 'one byte more than the table');
  assert.strictEqual(P.parseStatus(P.unhex('05 75')), null);
});

test('status message: digital inputs (ADI-2 Pro EX captures)', () => {
  const st = (h) => P.parseStatus(P.unhex(h));
  // [status, AES lock, SPDIF lock, clock, AES rate, SPDIF rate, SPDIF optical]
  const cases = [
    ['05 50 65 0B 40 00 00 02 00 01 02 02 00 00', false, false, 'internal', null, null, true],  // nothing connected
    ['05 0A 45 08 40 00 04 02 00 01 02 02 00 00', false, true, 'SPDIF', null, 48000, false],    // coax
    ['05 3A 45 08 48 00 00 02 00 01 02 02 00 00', false, true, 'SPDIF', null, 48000, true],     // optical (SPDIF In = Optical)
    ['05 75 44 08 48 00 0A 02 00 01 02 02 00 00', true, false, 'AES', 48000, null, true],       // AES
    ['05 75 44 08 40 00 0A 02 00 01 02 02 00 00', true, false, 'AES', 48000, null, true],       // AES, sender stopped
    ['05 70 49 08 40 00 08 06 00 01 02 02 00 00', false, false, 'internal', null, null, true],  // AES removed
    ['05 30 40 08 40 00 00 02 00 01 02 02 00 00', false, false, 'internal', null, null, true],  // clock AES, cable removed
  ];
  for (const [h, aes, spdif, clock, aesRate, spdifRate, optical] of cases) {
    const s = st(h);
    assert.deepStrictEqual(P.digitalInputs(s, 'pro'), { aes, spdif, spdifOptical: optical, aesRate, spdifRate }, h);
    assert.strictEqual(s.clock, clock, h);
  }
  // the unit follows the AES source's rate (clock AES): internal rate 44.1 / 96 kHz
  assert.strictEqual(st('05 75 44 08 48 00 0A 02 00 01 02 02 00 00').internalRate, 48000);
  // AES: 24 bit and professional format; coax: 24 bit
  assert.deepStrictEqual([st(cases[3][0]).aes.bits24, st(cases[3][0]).aes.professional], [true, true]);
  assert.deepStrictEqual([st(cases[1][0]).spdif.bits24, st(cases[1][0]).spdif.professional], [true, false]);
  // sync without lock (a moment during a rate change): the previous value stays
  const mixed = st('05 74 44 08 40 00 0A 02 00 01 02 02 00 00');
  assert.deepStrictEqual([mixed.aes.lock, mixed.aes.sync], [false, true]);
  assert.strictEqual(P.digitalInputs(mixed, 'pro', { aes: true, spdif: false }).aes, true);
  assert.strictEqual(P.digitalInputs(mixed, 'pro').aes, null);
  assert.ok(P.digitalInputs(st(cases[0][0]), 'se'), 'ADI-2/4 as well');
  const dac = P.digitalInputs(st(cases[1][0]), 'dac');
  assert.deepStrictEqual([dac.aes, dac.spdif, dac.spdifRate], [false, true, 48000], 'ADI-2 DAC: SPDIF only');
  assert.strictEqual(st(cases[4][0]).adat, true, 'bit 5 set with no ADAT source: not used for inputs');
});

test('status message: headphone jacks (ADI-2 Pro EX captures)', () => {
  const st = (h) => P.parseStatus(P.unhex(h));
  const cases = [
    ['05 30 7E 08 48 00 00 02 00 01 02 02 00 00', false, true],  // plug in Phones 3/4 (bit 24, reserved, changes on its own)
    ['05 30 7E 08 40 00 00 02 00 01 02 02 00 00', false, true],  // again
    ['05 30 7E 08 00 00 00 02 00 01 02 02 00 00', false, false], // pulled
    ['05 30 7E 08 09 00 00 02 00 01 02 02 00 00', true, false],  // plug in Phones 1/2
  ];
  for (const [h, ph12, ph34] of cases) assert.deepStrictEqual(P.phoneJacks(st(h), 'pro'), { ph12, ph34 }, h);
  assert.strictEqual(st(cases[0][0]).phones.ph34.overCurrent, false);
  assert.strictEqual(P.phoneJacks(st(cases[0][0]), 'dac'), null, 'not on the ADI-2 DAC');
});
