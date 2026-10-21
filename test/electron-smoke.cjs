// End-to-end smoke test: launches the real Electron app on the null audio
// backend, creates a session with Quick Setup, records a take, opens a
// plugin, visits every mode and exports a mix. Screenshots go to
// SMOKE_SHOTS (default: test/output).
const { _electron: electron } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const shots = process.env.SMOKE_SHOTS || path.join(__dirname, 'output');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'uavdaw-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, `--user-data-dir=${path.join(work, 'profile')}`, '--no-sandbox'],
    env: { ...process.env, UAVDAW_NULL_AUDIO: '1', UAVDAW_UPDATE_URL: '' },
  });
  const errors = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize({ width: 1600, height: 950 }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 980));

  // Stub native dialogs.
  await app.evaluate(({ dialog }, dir) => {
    let n = 0;
    dialog.showSaveDialog = async (_w, o) => {
      const title = (o && o.title) || '';
      if (/Export Mix/.test(title)) return { canceled: false, filePath: `${dir}/mix.wav` };
      return { canceled: false, filePath: `${dir}/Smoke Session ${++n}` };
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${dir}/stems`] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, work);

  await win.waitForFunction(() => window.app && window.app.audio);
  const audio = await win.evaluate(() => window.app.audio);
  assert(audio.inputChannels >= 8, `null device opened with ${audio.inputChannels} inputs`);
  await win.screenshot({ path: path.join(shots, '0-welcome.png') });

  await win.evaluate(() => window.app.newSession());
  await win.waitForSelector('.dialog >> text=QUICK SETUP');
  await win.screenshot({ path: path.join(shots, '1-quick-setup.png') });
  await win.click('button:has-text("Create Tracks")');
  await win.waitForFunction(() => window.app.s && window.app.s.tracks.length === window.app.audio.inputChannels);
  const nTracks = await win.evaluate(() => window.app.s.tracks.length);
  console.log(`ok - quick setup created ${nTracks} tracks`);

  // Give a few tracks recognisable names.
  await win.evaluate(() => {
    const names = ['KICK IN', 'KICK OUT', 'SNR TOP', 'SNR BTM', 'HH', 'TOM 1', 'TOM 2', 'OH L', 'OH R', 'BASS DI', 'GTR L', 'GTR R', 'KEYS L', 'KEYS R', 'VOX 1', 'VOX 2'];
    window.app.s.tracks.forEach((t, i) => { if (names[i]) t.name = names[i]; });
    window.app.renderAll();
  });

  // Record ~1.5 s.
  await win.evaluate(() => window.app.record());
  await sleep(1500);
  await win.screenshot({ path: path.join(shots, '2-recording.png') });
  await win.evaluate(() => window.app.stop());
  await win.waitForFunction(() => !window.app.rec);
  const take = await win.evaluate(() => ({ clips: window.app.s.tracks.filter((t) => t.clips.length).length, dir: window.app.audioDir, file: window.app.s.tracks[0].clips[0] && window.app.s.tracks[0].clips[0].file, len: window.app.s.tracks[0].clips[0] && window.app.s.tracks[0].clips[0].length }));
  assert.strictEqual(take.clips, nTracks, 'every armed track got a clip');
  assert(fs.existsSync(path.join(take.dir, take.file)), 'take written to disk');
  assert(take.len > 48000, `take length ${take.len}`);
  console.log(`ok - recorded take (${take.len} frames per track)`);

  // Import a sine file so the timeline shows a waveform.
  const sr = 48000;
  const sine = Buffer.alloc(44 + sr * 6 * 2);
  sine.write('RIFF', 0); sine.writeUInt32LE(36 + sr * 12, 4); sine.write('WAVE', 8); sine.write('fmt ', 12);
  sine.writeUInt32LE(16, 16); sine.writeUInt16LE(1, 20); sine.writeUInt16LE(1, 22); sine.writeUInt32LE(sr, 24);
  sine.writeUInt32LE(sr * 2, 28); sine.writeUInt16LE(2, 32); sine.writeUInt16LE(16, 34); sine.write('data', 36); sine.writeUInt32LE(sr * 12, 40);
  for (let i = 0; i < sr * 6; i++) sine.writeInt16LE(Math.round(32767 * 0.8 * Math.sin(i / 8) * Math.abs(Math.sin(i / 9000))), 44 + i * 2);
  const audioDir = take.dir;
  fs.writeFileSync(path.join(audioDir, 'tone.wav'), sine);
  await win.evaluate(async () => {
    const a = window.app;
    for (let i = 0; i < Math.min(16, a.s.tracks.length); i++) {
      a.s.tracks[i].clips = [{ id: `tone${i}`, file: 'tone.wav', start: i * 4000, offset: i * 9000, length: 48000 * 5 - i * 9000, channel: 0, gain: -i * 0.5 }];
      await a.syncClips(i);
    }
    a.s.view.spp = 400;
    a.views.live.render();
  });
  await sleep(1200);
  await win.evaluate(() => window.app.locate(48000 * 2.2));
  await sleep(400);
  await win.screenshot({ path: path.join(shots, '3-live.png') });

  // Virtual soundcheck plays the tracks.
  await win.evaluate(() => { window.app.setSource(1); return window.app.play(); });
  await sleep(800);
  const st = await win.evaluate(() => window.app.st);
  assert(st.playing && st.ready, 'virtual soundcheck playback runs');
  await win.screenshot({ path: path.join(shots, '4-soundcheck.png') });
  console.log('ok - virtual soundcheck playback');

  // Mixer with plugins.
  await win.evaluate(async () => {
    const a = window.app;
    a.setMode('mixer');
    const { PRESETS } = await import('./js/state.js');
    const { addPreset } = await import('./js/mixer.js');
    addPreset(a, 'track', 0, 0, PRESETS.find((p) => p.label === 'Drum Smash'));
    addPreset(a, 'track', 2, 0, PRESETS.find((p) => p.label && p.label.startsWith('Channel Strip')));
    addPreset(a, 'track', 14, 0, PRESETS.find((p) => p.label === 'Vocal Leveler'));
    await a.addBus('group');
    await a.addBus('aux');
  });
  await sleep(800);
  await win.screenshot({ path: path.join(shots, '5-mixer.png') });
  await win.evaluate(() => window.app.openFx('track', 0, 0));
  await sleep(700);
  await win.screenshot({ path: path.join(shots, '6-fx-compressor.png') });
  await win.evaluate(() => { window.app.fx.slot = 2; window.app.openFx('track', 2, 2); });
  await sleep(400);
  await win.screenshot({ path: path.join(shots, '7-fx-eq.png') });
  await win.evaluate(() => window.app.fx && window.app.fx.close());
  console.log('ok - mixer and plugin windows');

  // Broadcast view.
  await win.evaluate(() => {
    const a = window.app;
    a.setMode('broadcast');
    a.views.broadcast.addDest();
  });
  await sleep(1500);
  await win.screenshot({ path: path.join(shots, '8-broadcast.png') });
  console.log('ok - broadcast view');

  // Export.
  await win.evaluate(() => window.app.stop());
  await win.evaluate(() => { window.app.exportMix(false); });
  await win.click('button:has-text("Export…")');
  await win.waitForFunction(() => !document.querySelector('#progress') || document.querySelector('#progress').classList.contains('hidden'));
  for (let i = 0; i < 50 && !fs.existsSync(path.join(work, 'mix.wav')); i++) await sleep(100);
  await sleep(500);
  assert(fs.existsSync(path.join(work, 'mix.wav')), 'mix exported');
  console.log(`ok - exported mix (${fs.statSync(path.join(work, 'mix.wav')).size} bytes)`);

  // Save & reopen.
  const file = await win.evaluate(async () => { await window.app.save(); return window.app.file; });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.tracks.length, nTracks);
  await win.evaluate((f) => { window.app.dirty = false; return window.app.openSession(f); }, file);
  await win.waitForFunction((n) => window.app.s && window.app.s.tracks.length === n, nTracks);
  console.log('ok - session saved and reopened');

  const real = errors.filter((e) => !/Autofill|DevTools/.test(e));
  assert.deepStrictEqual(real, [], `no renderer errors: ${real.join('\n')}`);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.forceClose = true; w.close(); });
  await app.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nElectron smoke test passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
