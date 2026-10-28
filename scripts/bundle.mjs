// Builds dist/studio-engine.js: every engine file, in load order, in one
// script. No minifying and no module wrapper: jobs.js and fx.js build the
// Web Worker and the limiter worklet from each factory's source text, and
// each file attaches itself to window.S2S.
// Usage: node scripts/bundle.mjs [--check]   (--check fails if dist is stale)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = [
  'js/audio-analysis.js',
  'js/demo-loop.js',
  'js/studio/core.js',
  'js/studio/wav.js',
  'js/studio/zip.js',
  'js/studio/midifile.js',
  'js/studio/dsp/limiter.js',
  'js/studio/dsp/fft.js',
  'js/studio/dsp/pitch.js',
  'js/studio/dsp/rhythm.js',
  'js/studio/dsp/cleanup.js',
  'js/studio/dsp/melody.js',
  'js/studio/dsp/vocal.js',
  'js/studio/jobs.js',
  'js/studio/fx.js',
  'js/studio/synth.js',
  'js/studio/engine.js',
  'js/studio/store.js',
  'js/studio/controller.js'
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'studio-engine.js');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const parts = [
  '/*! Stem to Stream Studio engine ' + version + ': ' + FILES.length + ' files, load order kept.',
  ' * Load as a classic <script> (not an ES module, not through a bundler), then:',
  ' *   const studio = window.S2S.studio.createController(); studio.init();',
  ' * Source: js/ in this repository. Built by scripts/bundle.mjs; do not edit. */'
];
for (const f of FILES) {
  parts.push('\n// ---- ' + f + ' ----\n' + readFileSync(join(root, f), 'utf8').replace(/\s+$/, '') + '\n;');
}
const text = parts.join('\n') + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (current !== text) {
    console.error('dist/studio-engine.js is out of date: run node scripts/bundle.mjs');
    process.exit(1);
  }
  console.log('dist/studio-engine.js is up to date (' + text.length + ' bytes)');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log('wrote dist/studio-engine.js (' + text.length + ' bytes)');
}
