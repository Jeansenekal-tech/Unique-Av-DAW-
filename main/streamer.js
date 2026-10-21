// Broadcast output: reads the broadcast bus from the engine's stream tap,
// measures loudness (EBU R128 / ITU-R BS.1770) and feeds one FFmpeg encoder
// per destination (RTMP/RTMPS, SRT, Icecast or any FFmpeg URL).
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg');

function kWeighting(fs) {
  // ITU-R BS.1770 pre-filter, re-derived for any sample rate.
  let K = Math.tan(Math.PI * 1681.974450955533 / fs);
  const Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
    a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
  };
  K = Math.tan(Math.PI * 38.13547087602444 / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0] };
  return [shelf, hp];
}

class Loudness {
  constructor(sr) {
    this.sr = sr;
    this.filters = kWeighting(sr);
    this.state = [0, 1].map(() => this.filters.map(() => [0, 0]));
    this.blockLen = Math.round(sr / 10);
    this.acc = 0;
    this.n = 0;
    this.blocks = []; // 100 ms mean squares (sum of channels)
    this.gated = []; // 400 ms block powers for integrated loudness
    this.peak = 0;
  }

  reset() {
    this.gated = [];
  }

  push(interleaved) {
    for (let i = 0; i < interleaved.length; i += 2) {
      let sum = 0;
      for (let c = 0; c < 2; c++) {
        let x = interleaved[i + c];
        const ax = Math.abs(x);
        if (ax > this.peak) this.peak = ax;
        for (let f = 0; f < 2; f++) {
          const { b, a } = this.filters[f];
          const z = this.state[c][f];
          const y = b[0] * x + z[0];
          z[0] = b[1] * x - a[0] * y + z[1];
          z[1] = b[2] * x - a[1] * y;
          x = y;
        }
        sum += x * x;
      }
      this.acc += sum;
      if (++this.n === this.blockLen) {
        this.blocks.push(this.acc / this.blockLen);
        if (this.blocks.length > 30) this.blocks.shift();
        if (this.blocks.length >= 4) {
          const p = this.blocks.slice(-4).reduce((s, v) => s + v, 0) / 4;
          if (p > 0 && -0.691 + 10 * Math.log10(p) > -70) this.gated.push(p);
        }
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  static lufs(p) {
    return p > 1e-10 ? -0.691 + 10 * Math.log10(p) : -Infinity;
  }

  read() {
    const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
    const m = Loudness.lufs(mean(this.blocks.slice(-4)));
    const s = Loudness.lufs(mean(this.blocks));
    let i = -Infinity;
    if (this.gated.length) {
      const rel = Loudness.lufs(mean(this.gated)) - 10;
      const kept = this.gated.filter((p) => Loudness.lufs(p) > rel);
      i = Loudness.lufs(mean(kept));
    }
    const peak = this.peak;
    this.peak = 0;
    return { momentary: m, shortTerm: s, integrated: i, peak: peak > 1e-5 ? 20 * Math.log10(peak) : -Infinity };
  }
}

function outputArgs(dest) {
  const kbps = `${dest.bitrate || 160}k`;
  const aac = ['-c:a', 'aac', '-b:a', kbps, '-ar', '48000'];
  const video = dest.type !== 'icecast' && (dest.video === 'black' || (dest.video === 'image' && dest.image));
  const v = video ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-b:v', '600k'] : [];
  const url = (dest.url || '').trim();
  switch (dest.type) {
    case 'srt':
      return [...v, ...aac, '-f', 'mpegts', url];
    case 'icecast': {
      return ['-c:a', 'libmp3lame', '-b:a', kbps, '-content_type', 'audio/mpeg', '-f', 'mp3', url];
    }
    case 'custom':
      return [...v, ...aac, ...(dest.format ? ['-f', dest.format] : []), url];
    case 'rtmp':
    default: {
      const key = (dest.key || '').trim();
      const full = key ? `${url.replace(/\/+$/, '')}/${key}` : url;
      return [...v, ...aac, '-f', 'flv', full];
    }
  }
}

class Streamer {
  constructor({ engine, send }) {
    this.engine = engine;
    this.send = send;
    this.procs = new Map(); // id -> { proc, dest, status, startedAt, error, retry }
    this.recorder = null;
    this.timer = null;
    this.loud = null;
    this.lastSend = 0;
  }

  startTap() {
    const sr = this.engine.getState().sampleRate || 48000;
    this.sr = sr;
    this.loud = new Loudness(sr);
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 20);
  }

  pump() {
    let data;
    try {
      data = this.engine.readTap();
    } catch {
      return;
    }
    if (!data || !data.length) return;
    this.loud.push(data);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const p of this.procs.values()) {
      if (p.proc && p.proc.stdin.writable && p.proc.stdin.writableLength < 4 * 1024 * 1024) p.proc.stdin.write(buf);
    }
    if (this.recorder && this.recorder.stdin.writable) this.recorder.stdin.write(buf);
    const now = Date.now();
    if (now - this.lastSend > 100) {
      this.lastSend = now;
      this.send('loudness', this.loud.read());
    }
  }

  resetLoudness() {
    if (this.loud) this.loud.reset();
  }

  anyLive() {
    return [...this.procs.values()].some((p) => p.proc) || !!this.recorder;
  }

  status() {
    return [...this.procs.entries()].map(([id, p]) => ({
      id, status: p.status, error: p.error, startedAt: p.startedAt, kbps: p.kbps,
    }));
  }

  emit() {
    this.send('stream-status', this.status());
  }

  start(dest, opts = {}) {
    this.stop(dest.id, true);
    if (!dest.url) throw new Error('Enter the server URL for this destination');
    const sr = this.sr || 48000;
    // Raw PCM needs no probing; without these flags FFmpeg buffers ~13 s
    // before it starts. The generated video is held back by the bounded
    // input queue, so it stays in step with the live audio.
    const input = ['-hide_banner', '-loglevel', 'info', '-stats', '-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '1024',
      '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', 'pipe:0'];
    let video = false;
    if (dest.type !== 'icecast' && dest.video === 'black') { input.push('-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30'); video = true; }
    if (dest.type !== 'icecast' && dest.video === 'image' && dest.image) { input.push('-loop', '1', '-framerate', '30', '-i', dest.image); video = true; }
    if (video) input.push('-map', '0:a', '-map', '1:v', '-shortest');
    const args = [...input, ...outputArgs(dest)];
    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const entry = { proc, dest, status: 'connecting', startedAt: Date.now(), error: null, opts, log: '' };
    this.procs.set(dest.id, entry);
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      entry.log = (entry.log + s).slice(-4000);
      const m = /bitrate=\s*([\d.]+)kbits/.exec(s);
      if (m) entry.kbps = parseFloat(m[1]);
      if (entry.status === 'connecting' && /time=\d/.test(s)) {
        entry.status = 'live';
        entry.startedAt = Date.now();
        this.emit();
      }
    });
    proc.on('error', (e) => {
      entry.error = e.message;
    });
    proc.on('close', (code) => {
      if (entry.proc !== proc) return;
      entry.proc = null;
      if (entry.stopping) {
        entry.status = 'off';
      } else {
        const lines = entry.log.trim().split('\n').filter((l) => !/^\s*(frame|size)=/.test(l));
        entry.error = entry.error || lines.slice(-2).join(' ').trim() || `Encoder stopped (code ${code})`;
        entry.status = 'error';
        if (dest.autoReconnect !== false) {
          entry.status = 'reconnecting';
          entry.retry = setTimeout(() => {
            if (this.procs.get(dest.id) === entry && !entry.stopping) this.start(dest, opts);
          }, 3000);
        }
      }
      this.emit();
    });
    this.emit();
    return this.status();
  }

  stop(id, quiet = false) {
    const e = this.procs.get(id);
    if (!e) return this.status();
    e.stopping = true;
    clearTimeout(e.retry);
    if (e.proc) {
      e.proc.stdin.end();
      const p = e.proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
    this.procs.delete(id);
    if (!quiet) this.emit();
    return this.status();
  }

  stopAll() {
    for (const id of [...this.procs.keys()]) this.stop(id, true);
    this.recordProgram(null);
  }

  // Records the broadcast bus to a local file (WAV or MP3 by extension).
  recordProgram(file) {
    if (this.recorder) {
      this.recorder.stdin.end();
      this.recorder = null;
    }
    if (!file) return false;
    const codec = /\.mp3$/i.test(file) ? ['-c:a', 'libmp3lame', '-b:a', '320k'] : ['-c:a', 'pcm_s24le'];
    this.recorder = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-probesize', '32', '-analyzeduration', '0', '-f', 'f32le', '-ar', String(this.sr || 48000), '-ac', '2', '-i', 'pipe:0', ...codec, file], { stdio: ['pipe', 'ignore', 'ignore'] });
    this.recorder.stdin.on('error', () => {});
    return true;
  }

  convertMp3(wav) {
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', wav.replace(/\.wav$/i, '.mp3')]);
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('MP3 conversion failed'))));
    });
  }
}

module.exports = { Streamer, Loudness, outputArgs };
