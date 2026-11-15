// SUNDER — entrypoint for make.fun's threejs-fps-02 (program/v1).
// The game itself is the static site in game/ (three.js, no build step).
// This program hands it in: it copies game/ and screenshots/ into the
// output directory and writes dossier.json with the kit's vendored
// buildDossier, byte for byte the summary the judge reads.
// Run it the way the grader does:  node main.ts
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

const shotsDir = join(out, 'screenshots');
mkdirSync(shotsDir, { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), shotsDir, { recursive: true });
}

// The scorer's caps, mirrored so a bad entry fails here first instead of
// at the gate: dossier text budget, at most 4 screenshots of 256 KiB,
// and game/ within its file-count and byte budgets.
const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(out, 'dossier.json'), dossier);
console.log(`SUNDER handed in: game/ + screenshots/ -> ${out}, dossier.json written (${dossier.length} bytes)`);
