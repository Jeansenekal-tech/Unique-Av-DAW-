const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('daw', {
  engine: (method, ...args) => ipcRenderer.invoke('engine', method, ...args),

  devices: () => ipcRenderer.invoke('audio:devices'),
  openAudio: (cfg) => ipcRenderer.invoke('audio:open', cfg),
  audioInfo: () => ipcRenderer.invoke('audio:info'),
  broadcastDevice: (cfg) => ipcRenderer.invoke('audio:broadcastDevice', cfg),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (p) => ipcRenderer.invoke('settings:set', p),

  newSession: (name) => ipcRenderer.invoke('session:new', name),
  openSession: (file) => ipcRenderer.invoke('session:open', file),
  saveSession: (file, data) => ipcRenderer.invoke('session:save', file, data),
  autosave: (file, data) => ipcRenderer.invoke('session:autosave', file, data),
  saveTemplate: (data) => ipcRenderer.invoke('session:saveTemplate', data),
  pickTemplate: () => ipcRenderer.invoke('session:pickTemplate'),
  reveal: (file) => ipcRenderer.invoke('session:reveal', file),
  exists: (file) => ipcRenderer.invoke('fs:exists', file),
  mkdir: (dir) => ipcRenderer.invoke('fs:mkdir', dir),
  readPeaks: (file) => ipcRenderer.invoke('fs:readPeaks', file),
  writePeaks: (file, data) => ipcRenderer.invoke('fs:writePeaks', file, data),
  diskFree: (dir) => ipcRenderer.invoke('disk:free', dir),

  importAudio: (dir, sr) => ipcRenderer.invoke('import:audio', dir, sr),
  exportPick: (opts) => ipcRenderer.invoke('export:pick', opts),
  exportRun: (opts) => ipcRenderer.invoke('export:run', opts),

  streamStart: (dest, opts) => ipcRenderer.invoke('stream:start', dest, opts),
  streamStop: (id) => ipcRenderer.invoke('stream:stop', id),
  streamStatus: () => ipcRenderer.invoke('stream:status'),
  streamRecord: (file) => ipcRenderer.invoke('stream:record', file),
  streamResetLoudness: () => ipcRenderer.invoke('stream:resetLoudness'),
  pickImage: () => ipcRenderer.invoke('stream:pickImage'),

  confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
  keepAwake: (on) => ipcRenderer.invoke('app:keepAwake', on),
  appInfo: () => ipcRenderer.invoke('app:info'),
  message: (opts) => ipcRenderer.invoke('app:message', opts),

  updateConfigure: (cfg) => ipcRenderer.invoke('update:configure', cfg),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: (opts) => ipcRenderer.invoke('update:install', opts),

  onMenu: on('menu'),
  onProgress: on('progress'),
  onLoudness: on('loudness'),
  onStreamStatus: on('stream-status'),
  onUpdateStatus: on('update-status'),
});
