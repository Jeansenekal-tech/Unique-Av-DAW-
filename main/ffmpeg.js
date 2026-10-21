// Location of the bundled FFmpeg binary (unpacked from the asar archive).
let bin = null;

function ffmpegPath() {
  if (bin) return bin;
  try {
    bin = require('ffmpeg-static');
  } catch {
    bin = 'ffmpeg';
  }
  if (!bin) bin = 'ffmpeg';
  bin = bin.replace('app.asar', 'app.asar.unpacked');
  return bin;
}

module.exports = { ffmpegPath };
