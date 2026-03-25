/**
 * clip-audio.js
 *
 * Clips an MP3 file from start to start + length seconds using ffmpeg,
 * and saves the corresponding .lrc lyrics file alongside it.
 *
 * This module exports a function for use by clipService.js.
 * It can also be run standalone for testing:
 *
 *   node scripts/clip-audio.js <sourceMp3> <outputMp3> <start> <length> [lrcContent]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

/**
 * Clip an MP3 file and save the clipped audio + lyrics.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath - Absolute path to the source MP3
 * @param {string} opts.outputPath - Absolute path for the clipped MP3
 * @param {number} opts.start - Start time in seconds
 * @param {number} opts.length - Duration in seconds
 * @param {string|null} opts.lyrics - Adjusted LRC content for this clip
 */
function clipAudio({ sourcePath, outputPath, start, length, lyrics }) {
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Skip if clip file already exists
  if (fs.existsSync(outputPath)) {
    return;
  }

  // Use ffmpeg to clip the audio without re-encoding for speed
  execFileSync(ffmpegPath, [
    '-y',
    '-ss', String(start),
    '-t', String(length),
    '-i', sourcePath,
    '-c', 'copy',
    outputPath,
  ], { stdio: 'pipe' });

  // Save LRC lyrics file alongside the MP3
  if (lyrics) {
    const lrcPath = outputPath.replace(/\.mp3$/i, '.lrc');
    fs.writeFileSync(lrcPath, lyrics, 'utf-8');
  }
}

// Standalone CLI usage
if (require.main === module) {
  const [sourcePath, outputPath, start, length, lyrics] = process.argv.slice(2);
  if (!sourcePath || !outputPath || !start || !length) {
    console.error('Usage: node scripts/clip-audio.js <source> <output> <start> <length> [lrcContent]');
    process.exit(1);
  }
  clipAudio({
    sourcePath,
    outputPath,
    start: parseInt(start, 10),
    length: parseInt(length, 10),
    lyrics: lyrics || null,
  });
  console.log(`Clipped: ${outputPath}`);
}

module.exports = { clipAudio };
