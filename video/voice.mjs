// Generates the voice-over with HyperFrames' local text-to-speech (Kokoro-82M, runs offline) and
// records each beat's length. Needs Python with kokoro-onnx and soundfile; point HYPERFRAMES_PYTHON at it.
// Run: node voice.mjs   (then node build.mjs)
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HF = process.env.HYPERFRAMES_BIN || 'npx';
const hf = (args) =>
  execFileSync(HF, HF === 'npx' ? ['--yes', 'hyperframes@0.8.185', ...args] : args, {
    stdio: 'ignore',
  });
const beats = JSON.parse(readFileSync('script.json', 'utf8'));
const only = process.argv.slice(2);
const durs = (() => {
  try {
    return JSON.parse(readFileSync('assets/vo/durations.json', 'utf8'));
  } catch {
    return {};
  }
})();
for (const b of beats) {
  if (only.length && !only.includes(b.id)) continue;
  const wav = `assets/vo/${b.id}.wav`;
  hf(['tts', b.text, '-v', 'am_michael', '-s', '1.05', '-o', wav]);
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    wav,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    `assets/vo/${b.id}.m4a`,
  ]);
  rmSync(wav);
  console.log(b.id);
}
for (const b of beats) {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    `assets/vo/${b.id}.m4a`,
  ]).toString();
  durs[b.id] = Math.round(parseFloat(out) * 1000) / 1000;
}
writeFileSync('assets/vo/durations.json', JSON.stringify(durs, null, 1) + '\n');
