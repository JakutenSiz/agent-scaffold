#!/usr/bin/env node
// Enforces: R-25
/**
 * board-archive - moves finished items off the live task board, losing nothing.
 *
 * WHY: the board should hold open work only (and is never annotated: no note line, no Archive
 * section is written into it; the archive file's dated closure section is the record). A closed item keeps costing every session that
 * reads the board, so it moves, with its full text, to the archive file
 * (config.board.archive). No line is ever deleted.
 *
 * MOVES an item <=> its heading's first status emoji is the done mark AND its Remaining block
 * carries no owner tag (config.humans, config.labels.humanOnly, config.labels.anyone).
 * A done item that still has an owner-tagged step is reported as "done but carries work" and
 * stays. `↪ DUPLICATE` items stay. Struck-through parts and the conditional reopen sentence
 * do not count as tags. The Remaining block runs from the Remaining line to the next
 * Last evidence / Decision / Trap / Full history line.
 *
 * WRITE SAFETY: the new board and archive are computed in memory and verified first (every
 * moved line is present in the new archive text, the kept lines plus the moved lines equal
 * the old board). The archive is written first, then the board, each through a temp file and
 * an atomic rename - a crash in between leaves a duplicate, never a loss.
 *
 * USAGE:
 *   node scripts/board-archive.mjs            # dry run (default)
 *   node scripts/board-archive.mjs --write    # move
 *   node scripts/board-archive.mjs --json
 *   --force      write even when the board or archive has uncommitted changes
 *   (hidden, for tests) --source <file> --archive <file> --today <YYYY-MM-DD> --root <dir>
 *
 * EXIT CODES: 0 = ok (including nothing to move); 1 = refused (dirty tree) or verification
 * failed; 2 = usage/IO error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { boardFormat, parseItems, stripStruck, isoDate, todayDate } from './lib/board-format.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Splits parsed items into those that move and those that are done but still carry work. */
export function classify(items, fmt) {
  const move = [];
  const carriesWork = [];
  for (const it of items) {
    if (it.status !== fmt.status.done || it.duplicate) continue;
    (fmt.ownerRe.test(stripStruck(it.remaining, fmt)) ? carriesWork : move).push(it);
  }
  return { move, carriesWork };
}

/**
 * Pure computation. Returns { board, archive, count } (texts) or throws when verification fails.
 * `archiveText` is the current archive file content ('' when missing).
 */
export function buildArchive(boardText, archiveText, fmt, today) {
  const lines = boardText.split('\n');
  const { move } = classify(parseItems(boardText, fmt), fmt);
  if (!move.length) return { board: boardText, archive: archiveText, count: 0, codes: [] };

  const parts = move.map((it) => lines.slice(it.start, it.end));
  const kept = lines.slice();
  for (const it of [...move].reverse()) kept.splice(it.start, it.end - it.start);

  const date = isoDate(today);
  const codes = move.map((it) => it.code);
  // The board is never annotated: it carries open work only. The archive's own dated closure
  // section below is the record of the move.

  const archiveLines = archiveText.split('\n');
  const first = archiveLines.findIndex((l) => /^## /.test(l));
  const sameDay = archiveText.includes(`## ${date} closure - board-archive`);
  const section = [`## ${date} closure - board-archive (${sameDay ? 'round 2, ' : ''}${move.length} item${move.length === 1 ? '' : 's'})`, '', ...parts.flat()];
  while (section.length && section[section.length - 1].trim() === '') section.pop();
  section.push('');
  archiveLines.splice(first < 0 ? archiveLines.length : first, 0, ...section);

  const board = kept.join('\n');
  const archive = archiveLines.join('\n');

  // Verification: nothing lost, everything moved is in the archive.
  for (const l of parts.flat()) {
    if (l.trim() && !archive.includes(l)) throw new Error('verification failed: a moved line is missing from the archive text');
  }
  const movedCount = parts.reduce((n, p) => n + p.length, 0);
  if (board.split('\n').length !== lines.length - movedCount) throw new Error('verification failed: board line count mismatch');
  return { board, archive, count: move.length, codes };
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function isDirty(files) {
  const dir = path.dirname(files[0]);
  const inside = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.status !== 0) return false;
  const r = spawnSync('git', ['-C', dir, 'diff', '--quiet', 'HEAD', '--', ...files.map((f) => path.basename(f))], { encoding: 'utf8' });
  return r.status === 1;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (a) => argv.includes(a);
  const value = (a) => { const i = argv.indexOf(a); return i >= 0 ? argv[i + 1] : null; };
  const { root, config } = loadConfig(value('--root') ?? SCRIPT_DIR);
  const fmt = boardFormat(config);
  const source = path.resolve(value('--source') ?? path.join(root, config.board.file));
  const archive = path.resolve(value('--archive') ?? path.join(root, config.board.archive));
  const today = todayDate(value('--today'));

  if (!fs.existsSync(source)) { console.error(`board-archive: board file not found: ${source}`); return 2; }
  const boardText = fs.readFileSync(source, 'utf8');
  const archiveText = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8') : '';
  const { move, carriesWork } = classify(parseItems(boardText, fmt), fmt);

  if (flag('--json')) {
    const brief = (it) => ({ code: it.code, heading: it.heading.slice(0, 100) });
    console.log(JSON.stringify({ move: move.map(brief), carriesWork: carriesWork.map(brief) }, null, 2));
    return 0;
  }
  if (flag('--write')) {
    if (!move.length) { console.log('board-archive: 0 items to move, nothing done.'); return 0; }
    if (!flag('--force') && isDirty([source, archive])) {
      console.error('board-archive: the board or archive has uncommitted changes - another session may be writing. Ask first; use --force to write anyway.');
      return 1;
    }
    let result;
    try { result = buildArchive(boardText, archiveText, fmt, today); }
    catch (e) { console.error(`board-archive: ${e.message}`); return 1; }
    atomicWrite(archive, result.archive);
    atomicWrite(source, result.board);
    console.log(`board-archive: ${result.count} item(s) moved to the archive.`);
    return 0;
  }
  console.log(`board-archive (dry run): ${move.length} done item(s) to move`);
  for (const it of move) console.log(`  -> ${it.code}  (line ${it.start + 1}, ${it.end - it.start} lines)`);
  console.log(`done but carries work (stays): ${carriesWork.length}`);
  for (const it of carriesWork) console.log(`  ! ${it.code}  (line ${it.start + 1})`);
  if (move.length) console.log('  to apply: node scripts/board-archive.mjs --write');
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`board-archive: ${e.message}\n`); process.exitCode = 2; }
}
