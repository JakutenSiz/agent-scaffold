#!/usr/bin/env node
/**
 * md-size-watch — sliding-window Markdown file size watcher.
 *
 * WHY: files like the task board, the coordination log, and each repo's
 * memory-bank/activeContext.md + progress.md are meant to hold only the
 * "current" window, but in practice they grow append-only forever until
 * nobody can read the whole thing in one sitting anymore.
 *
 * WHAT IT DOES: measures each tracked sliding-window file's line count
 * against a ceiling and lists the ones OVER it. It renders NO VERDICT and
 * BLOCKS NOTHING by itself — it is meant to surface as a one-line nudge
 * (e.g. in a session-start hook). The ceiling is a "time to prune" signal;
 * content is never deleted, only moved to an archive (see
 * memory-bank-archive.mjs for memory-bank files).
 *
 * All tracked files and ceilings come from agent-scaffold.config.json:
 *   - config.board.file          (ceiling config.board.ceiling)
 *   - config.coordination.file   (ceiling config.coordination.ceiling)
 *   - for each config.repos[]: <repo.path>/<config.memoryBank.dir>/activeContext.md
 *     and .../progress.md        (ceiling config.memoryBank.ceiling)
 *
 * USAGE:
 *   node scripts/md-size-watch.mjs            # human-readable table
 *   node scripts/md-size-watch.mjs --line     # single line for hooks (empty output if all under ceiling)
 *   node scripts/md-size-watch.mjs --strict   # exit 1 if any file is over ceiling
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const { root, config, found } = loadConfig(SCRIPT_DIR);

if (!found) {
  console.log('[agent-scaffold] agent-scaffold.config.json not found; md-size-watch has nothing configured to check (fail-open).');
  process.exit(0);
}

const targets = [
  { file: config.board.file, ceiling: config.board.ceiling },
  { file: config.coordination.file, ceiling: config.coordination.ceiling },
  ...(config.repos ?? []).flatMap((r) => [
    { file: path.join(r.path || '.', config.memoryBank.dir, 'activeContext.md'), ceiling: config.memoryBank.ceiling },
    { file: path.join(r.path || '.', config.memoryBank.dir, 'progress.md'), ceiling: config.memoryBank.ceiling },
  ]),
];

const measurements = [];
for (const t of targets) {
  const p = path.join(root, t.file);
  if (!fs.existsSync(p)) continue;
  let lines = 0;
  try {
    lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).length;
  } catch {
    continue;
  }
  measurements.push({ ...t, lines, ratio: lines / t.ceiling });
}

const over = measurements.filter((m) => m.lines > m.ceiling).sort((a, b) => b.ratio - a.ratio);
const lineMode = process.argv.includes('--line');

if (lineMode) {
  if (over.length) {
    const list = over.map((o) => `${o.file} ${o.lines}/${o.ceiling}`).join(' · ');
    process.stdout.write(
      `MD SIZE WARNING: ${list} — over ceiling; time to prune (content is NOT deleted, move it to an archive file; ` +
        'for board/coordination use a compact template + archive file, for memory-bank files use ' +
        '`node scripts/memory-bank-archive.mjs <repo>`).',
    );
  }
  process.exit(0);
}

const pct = (m) => `${Math.round(m.ratio * 100)}%`;
console.log('md-size-watch — sliding-window files\n');
for (const m of measurements) {
  const flag = m.lines > m.ceiling ? '❌' : m.ratio > 0.8 ? '⚠️ ' : '✅';
  console.log(`  ${flag} ${m.file.padEnd(46)} ${String(m.lines).padStart(6)} / ${m.ceiling}  (${pct(m)})`);
}
console.log(
  over.length
    ? `\n${over.length} file(s) over ceiling. Pruning: content is NOT deleted, it moves to an archive.\n` +
        '  · board/coordination -> compact template + archive file (see project docs)\n' +
        '  · memory-bank         -> `node scripts/memory-bank-archive.mjs <repo>`'
    : '\nAll files are under ceiling.',
);
process.exit(process.argv.includes('--strict') && over.length ? 1 : 0);
