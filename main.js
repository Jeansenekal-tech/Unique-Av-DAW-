// Unique AV DAW – Electron main process. Owns the native audio engine,
// sessions on disk, audio import/export, live streaming and auto-update.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, systemPreferences, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { Updater } = require('./main/updater');
const { Streamer } = require('./main/streamer');
const { importAudio } = require('./main/importer');
const pkg = require('./package.json');

const engine = require('./build/Release/uavdaw.node');
const NULL_AUDIO = process.env.UAVDAW_NULL_AUDIO === '1';
const SESSION_EXT = 'uavdaw';

let win = null;
let blocker = null;
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  return s;
}

const streamer = new Streamer({
  engine,
  send: (ch, d) => send(ch, d),
});

const updater = new Updater({
  defaultUrl: process.env.UAVDAW_UPDATE_URL || pkg.updateUrl || '',
  send: (st) => send('update-status', st),
  isBusy: () => engine.getState().recording || streamer.anyLive(),
  log: (m) => console.log(m),
});

// ------------------------------------------------------------------ audio

let audioInfo = null;

function openAudio(cfg) {
  const devs = engine.listDevices({ nullBackend: NULL_AUDIO });
  const find = (list, name) => {
    if (name === '') return -1;
    const i = list.findIndex((d) => d.name === name);
    if (i >= 0) return i;
    const def = list.findIndex((d) => d.isDefault);
    return def >= 0 ? def : list.length ? 0 : -1;
  };
  const input = find(devs.inputs, cfg.input);
  const output = find(devs.outputs, cfg.output);
  const info = engine.open({
    nullBackend: NULL_AUDIO,
    input,
    output,
    sampleRate: cfg.sampleRate || 48000,
    bufferSize: cfg.bufferSize || 256,
    inputChannels: NULL_AUDIO ? cfg.nullChannels || 32 : 0,
    outputChannels: NULL_AUDIO ? cfg.nullChannels || 32 : 0,
  });
  audioInfo = {
    ...info,
    inputName: input >= 0 ? devs.inputs[input].name : '',
    outputName: output >= 0 ? devs.outputs[output].name : '',
  };
  streamer.startTap();
  return audioInfo;
}

const ENGINE_CALLS = new Set([
  'setCounts', 'setTrack', 'setBus', 'setInsert', 'setGlobal', 'setClips', 'wavInfo',
  'play', 'stop', 'locate', 'getState', 'getMeters', 'getSlotMeter', 'recordStart',
  'recordStop', 'getRecordPeaks', 'computePeaks', 'exportProgress', 'exportCancel',
]);

// ------------------------------------------------------------------ sessions

function sessionPaths(file) {
  const dir = path.dirname(file);
  return { file, dir, audio: path.join(dir, 'Audio') };
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function newSession(name) {
  const r = await dialog.showSaveDialog(win, {
    title: 'New Session',
    buttonLabel: 'Create Session',
    defaultPath: path.join(readSettings().sessionRoot || app.getPath('music'), name || 'Untitled Session'),
    properties: ['createDirectory'],
  });
  if (r.canceled || !r.filePath) return null;
  const base = path.basename(r.filePath).replace(new RegExp(`\\.${SESSION_EXT}$`), '');
  const dir = path.join(path.dirname(r.filePath), base);
  fs.mkdirSync(path.join(dir, 'Audio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Mixdowns'), { recursive: true });
  writeSettings({ sessionRoot: path.dirname(dir) });
  return { ...sessionPaths(path.join(dir, `${base}.${SESSION_EXT}`)), name: base };
}

function addRecent(file) {
  const s = readSettings();
  const recent = [file, ...(s.recent || []).filter((f) => f !== file)].slice(0, 10);
  writeSettings({ recent });
  app.addRecentDocument(file);
  buildMenu();
}

function loadSession(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  addRecent(file);
  return { ...sessionPaths(file), name: path.basename(file, `.${SESSION_EXT}`), data };
}

// ------------------------------------------------------------------ menu

function cmd(name, arg) {
  return () => send('menu', { cmd: name, arg });
}

function buildMenu() {
  const recent = (readSettings().recent || []).filter((f) => fs.existsSync(f));
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => { updater.check(true); cmd('updates')(); } },
        { type: 'separator' },
        { label: 'Audio Setup…', accelerator: 'CmdOrCtrl+,', click: cmd('audioSetup') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: cmd('newSession') },
        { label: 'New from Template…', click: cmd('newFromTemplate') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: cmd('openSession') },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((f) => ({ label: path.basename(f), click: cmd('openSession', f) }))
            : [{ label: 'No recent sessions', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: cmd('saveAs') },
        { label: 'Save as Template…', click: cmd('saveTemplate') },
        { type: 'separator' },
        { label: 'Import Audio…', accelerator: 'Shift+CmdOrCtrl+I', click: cmd('importAudio') },
        { label: 'Export Mix…', accelerator: 'Shift+CmdOrCtrl+E', click: cmd('exportMix') },
        { label: 'Export Stems…', click: cmd('exportStems') },
        { type: 'separator' },
        { label: 'Show Session in Finder', click: cmd('reveal') },
        { label: 'Audio Setup…', click: cmd('audioSetup') },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: cmd('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { label: 'Split Clip at Playhead', accelerator: 'S', registerAccelerator: false, click: cmd('split') },
        { label: 'Delete Clip', accelerator: 'Backspace', registerAccelerator: false, click: cmd('deleteClip') },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Track',
      submenu: [
        { label: 'Quick Setup…', accelerator: 'Shift+CmdOrCtrl+Q', click: cmd('quickSetup') },
        { label: 'New Track', accelerator: 'Shift+CmdOrCtrl+N', click: cmd('addTrack') },
        { label: 'New Bus', click: cmd('addBus') },
        { type: 'separator' },
        { label: 'Arm All Tracks', click: cmd('armAll', true) },
        { label: 'Disarm All Tracks', click: cmd('armAll', false) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Live', accelerator: 'CmdOrCtrl+1', click: cmd('mode', 'live') },
        { label: 'Mixer', accelerator: 'CmdOrCtrl+2', click: cmd('mode', 'mixer') },
        { label: 'Broadcast', accelerator: 'CmdOrCtrl+3', click: cmd('mode', 'broadcast') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom', 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom', -1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => { updater.check(true); cmd('updates')(); } },
        { label: 'Unique AV DAW on GitHub', click: () => shell.openExternal(pkg.homepage) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ window

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1d2133',
    title: 'Unique AV DAW',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('close', (e) => {
    if (win.forceClose) return;
    e.preventDefault();
    send('menu', { cmd: 'requestClose' });
  });
  win.on('closed', () => { win = null; });
}

function registerIpc() {
  ipcMain.handle('engine', (_e, method, ...args) => {
    if (!ENGINE_CALLS.has(method)) throw new Error(`Unknown engine call ${method}`);
    return engine[method](...args);
  });

  ipcMain.handle('audio:devices', () => engine.listDevices({ nullBackend: NULL_AUDIO }));
  ipcMain.handle('audio:open', (_e, cfg) => {
    writeSettings({ audio: cfg });
    return openAudio(cfg);
  });
  ipcMain.handle('audio:info', () => audioInfo);
  ipcMain.handle('audio:broadcastDevice', (_e, cfg) => {
    if (!cfg || !cfg.output) {
      engine.closeBroadcast();
      return null;
    }
    const devs = engine.listDevices({ nullBackend: NULL_AUDIO });
    const idx = devs.outputs.findIndex((d) => d.name === cfg.output);
    if (idx < 0) throw new Error(`Output “${cfg.output}” is not connected`);
    return engine.openBroadcast({ output: idx, channel: cfg.channel || 0 });
  });

  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch));

  ipcMain.handle('session:new', (_e, name) => newSession(name));
  ipcMain.handle('session:open', async (_e, file) => {
    if (!file) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Open Session',
        defaultPath: readSettings().sessionRoot || app.getPath('music'),
        filters: [{ name: 'Unique AV DAW Session', extensions: [SESSION_EXT] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    return loadSession(file);
  });
  ipcMain.handle('session:save', (_e, file, data) => {
    writeAtomic(file, JSON.stringify(data, null, 1));
    addRecent(file);
    return true;
  });
  ipcMain.handle('session:autosave', (_e, file, data) => {
    const dir = path.join(path.dirname(file), 'Backups');
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, `${path.basename(file)}.autosave`), JSON.stringify(data));
    return true;
  });
  ipcMain.handle('session:saveTemplate', async (_e, data) => {
    const dir = path.join(app.getPath('userData'), 'Templates');
    fs.mkdirSync(dir, { recursive: true });
    const r = await dialog.showSaveDialog(win, {
      title: 'Save as Template',
      defaultPath: path.join(dir, 'My Template.uavtemplate'),
      filters: [{ name: 'Template', extensions: ['uavtemplate'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 1));
    return r.filePath;
  });
  ipcMain.handle('session:pickTemplate', async () => {
    const dir = path.join(app.getPath('userData'), 'Templates');
    fs.mkdirSync(dir, { recursive: true });
    const r = await dialog.showOpenDialog(win, {
      title: 'New from Template',
      defaultPath: dir,
      filters: [{ name: 'Template', extensions: ['uavtemplate'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  });
  ipcMain.handle('session:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('fs:exists', (_e, file) => fs.existsSync(file));
  ipcMain.handle('fs:mkdir', (_e, dir) => fs.mkdirSync(dir, { recursive: true }));
  ipcMain.handle('fs:readPeaks', (_e, file) => {
    try {
      return new Int8Array(fs.readFileSync(file));
    } catch {
      return null;
    }
  });
  ipcMain.handle('fs:writePeaks', (_e, file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return true;
  });
  ipcMain.handle('disk:free', async (_e, dir) => {
    try {
      const s = await fs.promises.statfs(dir);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return null;
    }
  });

  ipcMain.handle('import:audio', async (_e, audioDir, sampleRate) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Audio',
      filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'caf', 'bwf', 'mp4', 'mov'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    const out = [];
    for (const f of r.filePaths) {
      send('progress', { label: `Importing ${path.basename(f)}…`, value: out.length / r.filePaths.length });
      out.push(await importAudio(engine, f, audioDir, sampleRate));
    }
    send('progress', null);
    return out;
  });

  ipcMain.handle('export:pick', async (_e, { stems, defaultDir, name }) => {
    if (stems) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Export Stems to Folder',
        defaultPath: defaultDir,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : r.filePaths[0];
    }
    const r = await dialog.showSaveDialog(win, {
      title: 'Export Mix',
      defaultPath: path.join(defaultDir, `${name}.wav`),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('export:run', async (_e, opts) => {
    const timer = setInterval(() => send('progress', { label: 'Exporting…', value: engine.exportProgress(), cancel: true }), 200);
    try {
      let mixPath = opts.path;
      if (opts.stemDir) mixPath = path.join(opts.stemDir, `${opts.name || 'Mix'}.wav`);
      const done = await engine.exportMix({ ...opts, path: mixPath });
      if (done && opts.mp3) await streamer.convertMp3(mixPath);
      return { done, path: mixPath };
    } finally {
      clearInterval(timer);
      send('progress', null);
    }
  });

  ipcMain.handle('stream:start', (_e, dest, opts) => streamer.start(dest, opts));
  ipcMain.handle('stream:stop', (_e, id) => streamer.stop(id));
  ipcMain.handle('stream:status', () => streamer.status());
  ipcMain.handle('stream:resetLoudness', () => streamer.resetLoudness());
  ipcMain.handle('stream:record', (_e, file) => streamer.recordProgram(file));
  ipcMain.handle('stream:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('app:confirmClose', () => {
    if (win) {
      win.forceClose = true;
      win.close();
    }
  });
  ipcMain.handle('app:keepAwake', (_e, on) => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, nullAudio: NULL_AUDIO }));
  ipcMain.handle('app:message', (_e, opts) => dialog.showMessageBox(win, opts));

  ipcMain.handle('update:configure', (_e, cfg) => updater.configure(cfg));
  ipcMain.handle('update:status', () => updater.status());
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', (_e, opts) => {
    const r = updater.install({ relaunch: true, ...(opts || {}) });
    if (r.ok) setTimeout(() => { if (win) win.forceClose = true; app.quit(); }, 300);
    return r;
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !NULL_AUDIO) {
    // Core Audio capture needs microphone permission (covers Dante, SoundGrid etc.).
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* not fatal */ }
  }
  registerIpc();
  buildMenu();
  createWindow();
  const s = readSettings();
  updater.configure(s.updates || {});
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', () => {
  streamer.stopAll();
  try { engine.recordStop(); } catch { /* ignore */ }
  try { engine.close(); } catch { /* ignore */ }
  if (updater.state.status === 'ready' && !updater.installing) updater.install({ relaunch: false, force: true });
});
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (win) send('menu', { cmd: 'openSession', arg: file });
});
