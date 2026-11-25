import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFormat, parseItems } from '../core/scripts/lib/board-format.mjs';
import { classify, buildArchive } from '../core/scripts/board-archive.mjs';

const fmt = boardFormat({});
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/board-archive.mjs');
const TODAY = new Date(2026, 10, 25);

const BOARD = [
  '# Board',
  '',
  '## Open items',
  '',
  '### 0101-open 🔴 [DEV] Still open',
  '**Remaining:** work',
  '',
  '### 0102-done ✅ [ANY] Finished',
  '**Remaining:** none',
  '**Last evidence:** 2026-01-02 abc1234',
  '',
  '### 0103-work ✅ [DEV] Done but carries work',
  '**Remaining:** [OWNER] approve the invoice',
  '',
  '### 0104-struck ✅ [ANY] Struck tag',
  '**Remaining:** ~~[OWNER] approve~~ **Reopen:** if it breaks [OWNER] decides).',
  '**Last evidence:** 2026-01-04 beadfed',
  '',
  '### 0105-dup ✅ ↪ DUPLICATE see 0102-done',
  '',
  '## Archive',
  '',
  '**old note**',
  '',
].join('\n');

const ARCHIVE = ['# Archive', '', 'intro', '', '## 0001 earlier closure', '', '### 0001-x ✅ old', ''].join('\n');

test('classify: moves done items without owner tags only', () => {
  const { move, carriesWork } = classify(parseItems(BOARD, fmt), fmt);
  assert.deepEqual(move.map((i) => i.code), ['0102-done', '0104-struck']);
  assert.deepEqual(carriesWork.map((i) => i.code), ['0103-work']);
});

test('buildArchive: board loses the items, archive gains them verbatim, the board gets no note', () => {
  const r = buildArchive(BOARD, ARCHIVE, fmt, TODAY);
  assert.equal(r.count, 2);
  assert.ok(!r.board.includes('### 0102-done'));
  assert.ok(r.board.includes('### 0101-open') && r.board.includes('### 0103-work') && r.board.includes('### 0105-dup'));
  assert.ok(!r.board.includes('board-archive')); // the board carries open work only: no note line
  const movedLines = classify(parseItems(BOARD, fmt), fmt).move.reduce((n, i) => n + (i.end - i.start), 0);
  assert.equal(r.board.split('\n').length, BOARD.split('\n').length - movedLines); // exactly the moved items leave
  assert.ok(r.archive.includes('### 0102-done ✅ [ANY] Finished\n**Remaining:** none\n**Last evidence:** 2026-01-02 abc1234'));
  // newest section goes above the older one, after the intro
  assert.ok(r.archive.indexOf('## 2026-11-25 closure') < r.archive.indexOf('## 0001 earlier closure'));
  assert.ok(r.archive.indexOf('intro') < r.archive.indexOf('## 2026-11-25 closure'));
});

test('buildArchive: second run on the same day is labelled round 2; nothing to move changes nothing', () => {
  const first = buildArchive(BOARD, ARCHIVE, fmt, TODAY);
  const again = buildArchive(BOARD, first.archive, fmt, TODAY);
  assert.match(again.archive, /closure - board-archive \(round 2, /);
  const none = buildArchive(first.board, first.archive, fmt, TODAY);
  assert.equal(none.count, 0);
  assert.equal(none.board, first.board);
});

test('buildArchive: a board without an Archive section does not get one', () => {
  const noArchive = BOARD.split('## Archive')[0];
  const r = buildArchive(noArchive, ARCHIVE, fmt, TODAY);
  assert.equal(r.count, 2);
  assert.ok(!/## Archive/.test(r.board));
  assert.ok(!r.board.includes('board-archive'));
});

test('no line is lost: kept board lines + archived lines cover the original', () => {
  const r = buildArchive(BOARD, ARCHIVE, fmt, TODAY);
  const after = new Set([...r.board.split('\n'), ...r.archive.split('\n')]);
  for (const l of BOARD.split('\n')) assert.ok(after.has(l), `missing: ${l}`);
});

test('CLI: dry run changes nothing, --write moves, files stay consistent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-archive-'));
  try {
    const boardFile = path.join(dir, 'task-board.md');
    const archiveFile = path.join(dir, 'task-board-archive.md');
    fs.writeFileSync(boardFile, BOARD);
    fs.writeFileSync(archiveFile, ARCHIVE);
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--root', dir, '--today', '2026-11-25', ...a], { encoding: 'utf8' });
    const dry = run();
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /2 done item\(s\) to move/);
    assert.equal(fs.readFileSync(boardFile, 'utf8'), BOARD);
    assert.equal(run('--write').status, 0);
    assert.ok(!fs.readFileSync(boardFile, 'utf8').includes('### 0102-done'));
    assert.ok(fs.readFileSync(archiveFile, 'utf8').includes('### 0102-done'));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['task-board-archive.md', 'task-board.md']); // no temp files left
    const json = JSON.parse(run('--json').stdout);
    assert.deepEqual(json.move, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
