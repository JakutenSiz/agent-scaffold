// Regenerates examples/minimal: what `install` produces for a fixed fixture config, minus the engine
// files (those are the package itself), plus TREE.txt listing every installed file.
// Run: npm run example
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_ROOT, fromPosix, walkFiles } from './lib/util.mjs';
import { install } from './lib/commands.mjs';
import { readManifest } from './lib/manifest.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'example-fixture.config.json');

/** Builds the example into outDir (must be empty or absent). */
export function buildExample(outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scaffold-example-'));
  try {
    const code = install({ target: work, configPath: FIXTURE, check: false, wire: false, log: () => {} });
    if (code !== 0) throw new Error(`install failed with exit ${code}`);
    const manifest = readManifest(work).value;
    const all = walkFiles(work);
    for (const rel of all) {
      const cls = manifest.files[rel]?.class;
      if (cls === 'engine') continue;
      const dest = path.join(outDir, fromPosix(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(work, fromPosix(rel)), dest);
    }
    fs.writeFileSync(path.join(outDir, 'TREE.txt'), `${all.join('\n')}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(PKG_ROOT, 'examples', 'minimal');
  fs.rmSync(out, { recursive: true, force: true });
  buildExample(out);
  console.log(`wrote ${path.relative(PKG_ROOT, out)}`);
}
