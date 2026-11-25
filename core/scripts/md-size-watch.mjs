#!/usr/bin/env node
// Enforces: R-60
/**
 * md-size-watch - sliding-window Markdown file size watcher.
 *
 * WHY: files like the task board, the coordination log, and each repo's
 * memory-bank/activeContext.md + progress.md are meant to hold only the
 * "current" window, but in practice they grow append-only forever until
 * nobody can read the whole thing in one sitting anymore. A line count alone
 * hides the worst cases: in one incident a board reached 1 MB with a single
 * 68,000-character line while its line count looked fine. So three ceilings
 * are measured separately: lines, UTF-8 bytes, and the longest line (in
 * characters).
 *
 * WHAT IT DOES: measures each tracked sliding-window file against its
 * ceilings and lists the ones OVER any of them. It renders NO VERDICT and
 * BLOCKS NOTHING by itself - it is meant to surface as a one-line nudge
 * (e.g. in a session-start hook). A ceiling is a "time to prune" signal;
 * content is never deleted, only moved to an archive (see
 * memory-bank-archive.mjs for memory-bank files).
 *
 * All tracked files and ceilings come from agent-scaffold.config.json:
 *   - config.board.file          (lines: board.ceiling, bytes: board.ceilingBytes,
 *                                 longest line: board.maxLineChars)
 *   - config.coordination.file   (lines: coordination.ceiling, bytes: coordination.ceilingBytes)
 *   - for each config.repos[]: <repo.path>/<config.memoryBank.dir>/activeContext.md
 *     and .../progress.md        (lines: memoryBank.ceiling, bytes: memoryBank.ceilingBytes,
 *                                 longest line: memoryBank.maxLineChars, default 2048)
 * Files without a longest-line ceiling use board.maxLineChars.
 *
 * USAGE:
 *   node scripts/md-size-watch.mjs                 # human-readable table
 *   node scripts/md-size-watch.mjs --line          # single line for hooks (NO output if all under ceilings)
 *   node scripts/md-size-watch.mjs --strict        # exit 1 if any file is over a ceiling
 *   node scripts/md-size-watch.mjs --root <dir>    # measure <dir> instead of the script's own project (worktrees)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

/** The tracked targets with their three ceilings. */
export function buildTargets(config) {
  const lineChars = config.board.maxLineChars ?? 4096;
  const mbLineChars = config.memoryBank.maxLineChars ?? 2048;
  return [
    { file: config.board.file, lines: config.board.ceiling, bytes: config.board.ceilingBytes, lineChars },
    { file: config.coordination.file, lines: config.coordination.ceiling, bytes: config.coordination.ceilingBytes, lineChars },
    ...(config.repos ?? []).flatMap((r) =>
      ['activeContext.md', 'progress.md'].map((f) => ({
        file: path.join(r.path || '.', config.memoryBank.dir, f),
        lines: config.memoryBank.ceiling,
        bytes: config.memoryBank.ceilingBytes,
        lineChars: mbLineChars,
      })),
    ),
  ];
}

/** Measure one text against a target. Returns the measurement with an `over` list ("lines=5/4", ...). */
export function measureText(text, target) {
  const rows = text.split(/\r?\n/);
  let longest = 0;
  for (const row of rows) {
    const n = row.length > longest ? [...row].length : 0; // code points; cheap pre-filter on UTF-16 length
    if (n > longest) longest = n;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const over = [];
  if (target.lines && rows.length > target.lines) over.push(`lines=${rows.length}/${target.lines}`);
  if (target.bytes && bytes > target.bytes) over.push(`bytes=${bytes}/${target.bytes}`);
  if (target.lineChars && longest > target.lineChars) over.push(`longest-line=${longest}/${target.lineChars}`);
  const ratio = Math.max(
    target.lines ? rows.length / target.lines : 0,
    target.bytes ? bytes / target.bytes : 0,
    target.lineChars ? longest / target.lineChars : 0,
  );
  return { ...target, lineCount: rows.length, byteCount: bytes, longest, over, ratio };
}

export function measureAll(root, config) {
  const out = [];
  for (const t of buildTargets(config)) {
    const p = path.join(root, t.file);
    if (!fs.existsSync(p)) continue;
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    out.push(measureText(text, t));
  }
  return out;
}

export function warningLine(overs) {
  if (!overs.length) return '';
  const list = overs.map((o) => `${o.file} ${o.over.join(', ')}`).join(' · ');
  return (
    `MD SIZE WARNING: ${list} - over ceiling; time to prune (content is NOT deleted, move it to an archive file; ` +
    'for board/coordination use a compact template + archive file, for memory-bank files use ' +
    '`node scripts/memory-bank-archive.mjs <repo>`).'
  );
}

function resolveRoot(argv) {
  const i = argv.indexOf('--root');
  if (i >= 0) {
    const dir = argv[i + 1];
    if (!dir || dir.startsWith('--')) {
      console.error('--root needs a directory: --root <dir>');
      process.exit(2);
    }
    return path.resolve(dir);
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function main() {
  const argv = process.argv.slice(2);
  const { root, config, found } = loadConfig(resolveRoot(argv));
  if (!found) {
    console.log('[agent-scaffold] agent-scaffold.config.json not found; md-size-watch has nothing configured to check (fail-open).');
    process.exit(0);
  }
  const measurements = measureAll(root, config);
  const over = measurements.filter((m) => m.over.length).sort((a, b) => b.ratio - a.ratio);
  const strict = argv.includes('--strict');

  if (argv.includes('--line')) {
    process.stdout.write(warningLine(over));
    process.exit(strict && over.length ? 1 : 0);
  }

  const pct = (m) => `${Math.round(m.ratio * 100)}%`;
  console.log('md-size-watch - sliding-window files\n');
  for (const m of measurements) {
    const flag = m.over.length ? 'X' : m.ratio > 0.8 ? '!' : 'ok';
    console.log(
      `  ${flag.padEnd(2)} ${m.file.padEnd(46)} lines=${m.lineCount}/${m.lines} bytes=${m.byteCount}/${m.bytes} ` +
        `longest-line=${m.longest}/${m.lineChars} (${pct(m)})`,
    );
  }
  console.log(
    over.length
      ? `\n${over.length} file(s) over a ceiling. Pruning: content is NOT deleted, it moves to an archive.\n` +
          '  - board/coordination -> compact template + archive file (see project docs)\n' +
          '  - memory-bank         -> `node scripts/memory-bank-archive.mjs <repo>`'
      : '\nAll files are under their ceilings.',
  );
  process.exit(strict && over.length ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
