const { clipAudio } = require('./clip-audio');
const path = require('path');
const fs = require('fs');
const config = require('../src/config');

const src = path.join(config.mp3BasePath, '雪花落下 - 周深.mp3');
const out = path.join(config.clipsBasePath, '雪花落下 - 周深 - 19.mp3');

console.log('Source:', src);
console.log('Source exists:', fs.existsSync(src));
console.log('Output:', out);
console.log('Output exists before:', fs.existsSync(out));

// Delete old clip if exists
try { fs.unlinkSync(out); } catch {}

try {
  clipAudio({ sourcePath: src, outputPath: out, start: 19, length: 20, lyrics: null });
  console.log('Output exists after:', fs.existsSync(out));
  if (fs.existsSync(out)) {
    console.log('Output size:', (fs.statSync(out).size / 1024).toFixed(1), 'KB');
  }
  console.log('SUCCESS');
} catch (e) {
  console.log('ERROR:', e.message);
}
