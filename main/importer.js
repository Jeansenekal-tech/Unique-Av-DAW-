// Brings audio files into the session's Audio folder as WAV at the session
// sample rate. WAVs that already match are copied; anything else (MP3, AIFF,
// FLAC, other sample rates, video soundtracks) is converted with FFmpeg.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpegPath } = require('./ffmpeg');

function uniqueName(dir, base, ext) {
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} ${i}${ext}`;
  return name;
}

function convert(src, dst, sampleRate) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ar', String(sampleRate), '-c:a', 'pcm_s24le', '-rf64', 'auto', dst];
    const p = spawn(ffmpegPath(), args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `FFmpeg exited with ${code}`))));
  });
}

async function importAudio(engine, src, audioDir, sampleRate) {
  fs.mkdirSync(audioDir, { recursive: true });
  const base = path.basename(src, path.extname(src));
  const name = uniqueName(audioDir, base, '.wav');
  const dst = path.join(audioDir, name);
  const info = /\.(wav|bwf)$/i.test(src) ? engine.wavInfo(src) : null;
  if (info && info.sampleRate === sampleRate) await fs.promises.copyFile(src, dst);
  else await convert(src, dst, sampleRate);
  const out = engine.wavInfo(dst);
  if (!out) throw new Error(`Could not import ${path.basename(src)}`);
  return { file: name, name: base, channels: out.channels, frames: out.frames };
}

module.exports = { importAudio, convert };
