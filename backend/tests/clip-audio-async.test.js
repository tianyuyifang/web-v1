const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipAudioAsync } = require('../scripts/clip-audio');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
  const out = path.join(dir, 'x.mp3');

  // Pre-existing output → must skip ffmpeg entirely (source is nonexistent, so
  // if it tried to run ffmpeg it would throw).
  fs.writeFileSync(out, 'existing');
  await clipAudioAsync({ sourcePath: 'nonexistent.mp3', outputPath: out, start: 0, length: 5, lyrics: 'hi' });
  assert.strictEqual(fs.readFileSync(out, 'utf-8'), 'existing', 'skip-if-exists left file untouched');
  assert.ok(!fs.existsSync(out.replace(/\.mp3$/, '.lrc')), 'no lrc written on skip');

  // Fresh clip from a real source (first mp3 under MP3_BASE_PATH), if available.
  require('dotenv').config();
  const base = process.env.MP3_BASE_PATH;
  if (base && fs.existsSync(base)) {
    const mp3 = fs.readdirSync(base).find((f) => f.endsWith('.mp3'));
    if (mp3) {
      const out2 = path.join(dir, 'clip.mp3');
      await clipAudioAsync({
        sourcePath: path.join(base, mp3), outputPath: out2, start: 0, length: 3, lyrics: '[00:00.00]test',
      });
      assert.ok(fs.existsSync(out2) && fs.statSync(out2).size > 0, 'fresh clip created with content');
      assert.strictEqual(fs.readFileSync(out2.replace(/\.mp3$/, '.lrc'), 'utf-8'), '[00:00.00]test', 'lrc written');
      console.log('clip-audio-async.test OK (real clip verified)');
    } else {
      console.log('clip-audio-async.test OK (skip-branch only; no mp3 in MP3_BASE_PATH)');
    }
  } else {
    console.log('clip-audio-async.test OK (skip-branch only; MP3_BASE_PATH not set)');
  }

  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
