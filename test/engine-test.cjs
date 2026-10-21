// Engine tests on miniaudio's null backend (no audio hardware needed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const eng = require('../build/Release/uavdaw.node');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uavdaw-'));
const SR = 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeWav(file, samples, sr = SR) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  fs.writeFileSync(file, b);
}

function readWavStereo24(file) {
  const b = fs.readFileSync(file);
  let o = 12, data = null, fmt = null;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), bits: b.readUInt16LE(o + 22), sr: b.readUInt32LE(o + 12) };
    if (id === 'data') { data = b.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size & 1);
  }
  const frames = data.length / (fmt.ch * 3);
  const ch = [...Array(fmt.ch)].map(() => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < fmt.ch; c++) ch[c][i] = data.readIntLE((i * fmt.ch + c) * 3, 3) / 8388608;
  return { fmt, ch, bext: b.indexOf('bext') };
}

const peak = (a, from = 0, to = a.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const db = (x) => 20 * Math.log10(x + 1e-12);

(async () => {
  let passed = 0;
  const ok = (name) => { passed++; console.log('ok -', name); };

  const devs = eng.listDevices({ nullBackend: true });
  assert.strictEqual(devs.backend, 'Null');
  assert(devs.inputs.length >= 1 && devs.outputs.length >= 1);
  ok('lists null devices');

  const info = eng.open({ nullBackend: true, input: 0, output: 0, inputChannels: 8, outputChannels: 8, sampleRate: SR, bufferSize: 256 });
  assert.strictEqual(info.sampleRate, SR);
  assert.strictEqual(info.inputChannels, 8);
  ok('opens a duplex 8x8 device');

  // A 1 kHz sine at -6 dBFS, 1 second, on two tracks.
  const sine = Array.from({ length: SR }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR));
  const sineFile = path.join(dir, 'sine.wav');
  writeWav(sineFile, sine);
  assert.deepStrictEqual(eng.wavInfo(sineFile), { sampleRate: SR, channels: 1, frames: SR, bits: 16 });
  ok('reads WAV info');

  eng.setCounts(2, 3);
  eng.setTrack(0, { input: 0, fader: 1, pan: -1, dest: 0 });
  eng.setTrack(1, { input: 1, fader: 0.5, pan: 1, dest: 0 });
  assert.strictEqual(eng.setClips(0, [{ path: sineFile, start: 0 }]), 0);
  assert.strictEqual(eng.setClips(1, [{ path: sineFile, start: SR / 2, length: SR / 2 }]), 0);
  eng.setBus(0, { fader: 1, hwOut: 0 });

  const mixFile = path.join(dir, 'mix.wav');
  assert.strictEqual(await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 }), true);
  let mix = readWavStereo24(mixFile);
  assert.strictEqual(mix.fmt.ch, 2);
  assert(mix.bext > 0, 'BWF bext chunk present');
  // Track 0 hard left at unity: -6 dBFS on L only.
  assert(Math.abs(db(peak(mix.ch[0], 2000, SR)) - -6.02) < 0.3, `L ${db(peak(mix.ch[0], 2000, SR))}`);
  // Track 1 hard right, fader 0.5 (-6 dB), starts at 0.5 s: -12 dBFS on R.
  assert(peak(mix.ch[1], 0, SR / 2 - 600) < 1e-3, 'R silent before the clip starts');
  assert(Math.abs(db(peak(mix.ch[1], SR / 2 + 2000, SR)) - -12.04) < 0.3, `R ${db(peak(mix.ch[1], SR / 2 + 2000, SR))}`);
  ok('offline mixdown: clip placement, fader and pan');

  // Mute and solo.
  eng.setTrack(1, { solo: 1 });
  eng.setGlobal({ anySolo: 1 });
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 });
  mix = readWavStereo24(mixFile);
  assert(peak(mix.ch[0], 1000, SR) < 1e-3, 'non-soloed track silent');
  eng.setTrack(1, { solo: 0, mute: 1 });
  eng.setGlobal({ anySolo: 0 });
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 });
  mix = readWavStereo24(mixFile);
  assert(peak(mix.ch[1], 1000, SR) < 1e-3, 'muted track silent');
  eng.setTrack(1, { mute: 0 });
  ok('solo and mute');

  // Compressor: -6 dBFS into a -20 dB threshold, 4:1, should cut ~10.5 dB.
  eng.setInsert('track', 0, 0, { type: 2, on: 1, params: [-20, 4, 1, 50, 0, 0, 0, 1, 0] });
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 });
  mix = readWavStereo24(mixFile);
  const comp = db(peak(mix.ch[0], SR / 2, SR));
  assert(comp < -15 && comp > -18, `compressed level ${comp}`);
  ok(`compressor reduces gain (${comp.toFixed(1)} dBFS)`);

  // Every processor type runs without producing NaN or silence explosions.
  for (const [type, params] of [
    [1, [1, 80, 1, 12000, 1, 1, 100, 3, 0.7, 1, 0, 1000, -4, 1, 1, 0, 3000, 2, 1, 1, 2, 8000, 1, 0.7]],
    [3, [-30, -60, 1, 50, 100, 0, 0, 3]],
    [4, [-1, 50, 6]],
    [5, [1, 5000, 2, -30, -6, 2, 80, 0, 300, 1, -20, 6, 5, 100]],
    [6, [250, 0.4, 0.3, 6000, 0]],
    [7, [0.7, 0.5, 0.3, 1]],
  ]) {
    eng.setInsert('track', 0, 0, { type, on: 1, params });
    await eng.exportMix({ path: mixFile, start: 0, end: SR / 2, bits: 24 });
    mix = readWavStereo24(mixFile);
    const p = peak(mix.ch[0]);
    assert(Number.isFinite(p) && p > 0.01 && p <= 1.0, `fx ${type} peak ${p}`);
  }
  eng.setInsert('track', 0, 0, { type: 0, on: 0, params: [] });
  ok('all processor types run cleanly');

  // Limiter on the master holds the ceiling.
  eng.setTrack(0, { trim: 4 });
  eng.setInsert('bus', 0, 0, { type: 4, on: 1, params: [-1, 50, 0] });
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 });
  mix = readWavStereo24(mixFile);
  assert(db(peak(mix.ch[0], 200, SR)) <= -0.95, `limited ${db(peak(mix.ch[0]))}`);
  eng.setInsert('bus', 0, 0, { type: 0, on: 0, params: [] });
  eng.setTrack(0, { trim: 1 });
  ok('limiter holds the ceiling');

  // Aux send to bus 1 routed to master.
  eng.setTrack(0, { fader: 0, sends: [{ bus: 1, level: 1, pre: 1 }] });
  eng.setBus(1, { fader: 1, toMaster: 1 });
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24 });
  mix = readWavStereo24(mixFile);
  assert(Math.abs(db(peak(mix.ch[0], 2000, SR)) - -6.02) < 0.3, 'pre-fader send reaches master');
  eng.setTrack(0, { fader: 1, sends: [] });
  ok('pre-fader aux send');

  // Stems.
  const stemDir = path.join(dir, 'stems');
  fs.mkdirSync(stemDir);
  await eng.exportMix({ path: mixFile, start: 0, end: SR, bits: 24, stemDir });
  const stem = readWavStereo24(path.join(stemDir, 'Track 02.wav'));
  assert(Math.abs(db(peak(stem.ch[1], SR / 2 + 2000, SR)) - -12.04) < 0.3);
  ok('stem export');

  // Live: transport plays, playback reaches virtual-soundcheck outputs.
  eng.setGlobal({ source: 1 });
  eng.locate(0);
  eng.play();
  for (let i = 0; i < 100 && !eng.getState().ready; i++) await sleep(10);
  await sleep(200);
  let st = eng.getState();
  assert(st.ready && st.playing && st.pos > 0, `transport runs ${JSON.stringify(st)}`);
  const m = eng.getMeters();
  assert(m[0] > 0.4, `track 0 input meter shows playback (${m[0]})`);
  eng.stop();
  ok('transport plays back clips in virtual soundcheck mode');

  // Recording on the null device.
  eng.setGlobal({ source: 0 });
  eng.locate(SR * 10);
  for (let i = 0; i < 100 && !eng.getState().ready; i++) await sleep(10);
  const recA = path.join(dir, 'rec1.wav'), recB = path.join(dir, 'rec2.wav');
  eng.setTrack(0, { recordPath: recA });
  eng.setTrack(1, { recordPath: recB });
  assert.strictEqual(eng.recordStart({ bits: 24 }), 2);
  await sleep(600);
  const peaks = eng.getRecordPeaks(0, 0);
  const takes = eng.recordStop();
  eng.stop();
  assert.strictEqual(takes.length, 2);
  assert.strictEqual(takes[0].path, recA);
  assert(takes[0].start >= SR * 10, `take starts at the locate point (${takes[0].start})`);
  assert(takes[0].length > SR * 0.3, `recorded ${takes[0].length} frames`);
  const wi = eng.wavInfo(recA);
  assert.strictEqual(wi.frames, takes[0].length);
  assert.strictEqual(wi.bits, 24);
  assert(peaks.length > 0);
  const timeRef = fs.readFileSync(recA).readUInt32LE(12 + 8 + 338);
  assert.strictEqual(timeRef, takes[0].start, 'BWF time reference = take start');
  ok(`records BWF takes (${takes[0].length} frames)`);

  // Computed peaks for an existing file.
  const pk = await eng.computePeaks(sineFile, 0);
  assert.strictEqual(pk.length, 2 * Math.ceil(SR / eng.PEAK_SPP));
  assert(pk[1] >= 62 && pk[1] <= 64);
  ok('computes waveform peaks');

  // Stream tap.
  eng.setBus(2, { feedMaster: 1, tap: 1, fader: 1 });
  eng.readTap();
  await sleep(200);
  const tap = eng.readTap();
  assert(tap.length > 1000 && tap.length % 2 === 0, `tap has stereo samples (${tap.length})`);
  ok('broadcast bus feeds the stream tap');

  eng.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} engine tests passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
