// Loudness meter (BS.1770 / EBU R128) and FFmpeg argument tests.
const assert = require('assert');
const { Loudness, outputArgs } = require('../main/streamer');

const sr = 48000;
function sine(db, secs, f = 1000) {
  const a = 10 ** (db / 20);
  const out = new Float32Array(sr * secs * 2);
  for (let i = 0; i < sr * secs; i++) out[2 * i] = out[2 * i + 1] = a * Math.sin((2 * Math.PI * f * i) / sr);
  return out;
}

const l = new Loudness(sr);
l.push(sine(-23, 10));
const r = l.read();
assert(Math.abs(r.integrated - -23) < 0.2, `-23 dBFS 1 kHz stereo reads ${r.integrated.toFixed(2)} LUFS`);
assert(Math.abs(r.shortTerm - -23) < 0.2, `short-term ${r.shortTerm}`);
assert(Math.abs(r.peak - -23) < 0.1, `peak ${r.peak}`);
console.log(`ok - EBU reference tone measures ${r.integrated.toFixed(2)} LUFS`);

// Relative gate: 10 s at -23 plus 10 s of -60 dBFS should still read about -23.
const g = new Loudness(sr);
g.push(sine(-23, 10));
g.push(sine(-60, 10));
assert(Math.abs(g.read().integrated - -23) < 0.5);
console.log('ok - relative gating ignores quiet passages');

const silent = new Loudness(sr);
silent.push(new Float32Array(sr * 2));
assert.strictEqual(silent.read().momentary, -Infinity);
console.log('ok - silence reads as -inf');

let a = outputArgs({ type: 'rtmp', url: 'rtmp://a.rtmp.youtube.com/live2/', key: 'abcd', bitrate: 128, video: 'black' });
assert.deepStrictEqual(a.slice(-3), ['-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/abcd']);
assert(a.includes('libx264') && a.includes('128k'));
a = outputArgs({ type: 'icecast', url: 'icecast://source:pw@host:8000/live', bitrate: 192 });
assert.deepStrictEqual(a.slice(-3), ['-f', 'mp3', 'icecast://source:pw@host:8000/live']);
assert(!a.includes('libx264'));
a = outputArgs({ type: 'srt', url: 'srt://host:9000', video: 'none' });
assert.deepStrictEqual(a.slice(-3), ['-f', 'mpegts', 'srt://host:9000']);
console.log('ok - FFmpeg output arguments');
