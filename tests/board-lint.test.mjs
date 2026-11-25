import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFormat } from '../core/scripts/lib/board-format.mjs';
import { lintBoard, resolveMode, doneTransitions } from '../core/scripts/board-lint.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const fmt = boardFormat({});
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/board-lint.mjs');

const board = (...items) => ['# Board', '', '## Open items', '', ...items.map((i) => i + '\n')].join('\n');
const open = [
  '### 0101-a 🔴 [DEV] Item a',
  '**Remaining:** build it',
  '**Last evidence:** 2026-01-01 abc1234',
].join('\n');
const rules = (text) => lintBoard(open ? board(open) : '', text, fmt).map((f) => f.rule);

test('unchanged item: no findings', () => {
  assert.deepEqual(lintBoard(board(open), board(open), fmt), []);
});

test('L1: completion line added, heading and Remaining unchanged', () => {
  const next = open + '\n**Note:** deployed and live now';
  assert.ok(rules(board(next)).includes('L1'));
});

test('L1 exemptions: side note and struck-through done mark', () => {
  assert.ok(!rules(board(open + '\n**Note:** the other repo is live (side note)')).includes('L1'));
  assert.ok(!rules(board(open + '\n**Note:** ~~step one ✅~~ closed')).includes('L1'));
});

test('L1 clears when heading and Remaining change in the same edit', () => {
  const next = [
    '### 0101-a ✅ [DEV] Item a',
    '**Remaining:** none',
    '**Last evidence:** 2026-01-02 deadbee deployed',
  ].join('\n');
  assert.ok(!rules(board(next)).includes('L1'));
});

test('L2: dated paragraph appended to an open item; edited field is fine', () => {
  assert.ok(rules(board(open + '\n**2026-01-05** extra era')).includes('L2'));
  const edited = open.replace('2026-01-01 abc1234', '2026-01-09 beadfed');
  assert.ok(!rules(board(edited)).includes('L2'));
});

test('L3: duplicate code is an error, the DUPLICATE marker is exempt', () => {
  const twin = open.replace('Item a', 'twin');
  const found = lintBoard('', board(open, twin), fmt);
  assert.ok(found.some((f) => f.rule === 'L3' && f.severity === 'error'));
  const marked = open.replace('🔴 [DEV] Item a', '🔴 ↪ DUPLICATE see 0101-a');
  assert.ok(!lintBoard('', board(open, marked), fmt).some((f) => f.rule === 'L3'));
});

test('L4: done heading with an owner tag in Remaining; open heading with empty Remaining', () => {
  const done = '### 0101-a ✅ [DEV] x\n**Remaining:** [OWNER] approve\n**Last evidence:** 2026-01-01 abc1234';
  assert.ok(lintBoard('', board(done), fmt).some((f) => f.rule === 'L4'));
  const empty = '### 0101-a 🔴 [DEV] x\n**Remaining:** none\n**Last evidence:** x';
  assert.ok(lintBoard('', board(empty), fmt).some((f) => f.rule === 'L4'));
});

test('L5: body longer than 35 lines', () => {
  const long = open + '\n' + Array.from({ length: 40 }, (_, i) => `- line ${i}`).join('\n');
  assert.ok(lintBoard('', board(long), fmt).some((f) => f.rule === 'L5'));
});

test('L6 and L7: done item without evidence, with a leftover warning mark', () => {
  const done = '### 0101-a ✅ [DEV] x\n**Remaining:** none\n**Last evidence:** soon\n**Trap:** ⚠️ do not touch';
  const r = lintBoard('', board(done), fmt).map((f) => f.rule);
  assert.ok(r.includes('L6') && r.includes('L7'));
});

test('L8: Human step without a tag, and Remaining starting with a tag without a field', () => {
  const untagged = open + '\n**Human step:** approve the thing';
  assert.ok(lintBoard('', board(untagged), fmt).some((f) => f.rule === 'L8'));
  const inRemaining = '### 0101-a 🔴 [DEV] x\n**Remaining:** [OWNER] approve\n**Last evidence:** x';
  assert.ok(lintBoard('', board(inRemaining), fmt).some((f) => f.rule === 'L8'));
});

test('resolveMode precedence: flag > env > config > warn', () => {
  const cfg = { board: { lint: { mode: 'block', escapeEnv: 'MY_LINT' } } };
  assert.equal(resolveMode(cfg, 'off', { MY_LINT: 'warn' }), 'off');
  assert.equal(resolveMode(cfg, undefined, { MY_LINT: 'warn' }), 'warn');
  assert.equal(resolveMode(cfg, undefined, {}), 'block');
  assert.equal(resolveMode({}, undefined, {}), 'warn');
});

test('CLI --files: exit 0 in warn mode, 1 in block mode, usage error 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-lint-'));
  try {
    const oldFile = path.join(dir, 'old.md');
    const newFile = path.join(dir, 'new.md');
    fs.writeFileSync(oldFile, board(open));
    fs.writeFileSync(newFile, board(open + '\n**Note:** deployed and live now'));
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8', env: scrubGitEnv({ ...process.env, BOARD_LINT: '' }) });
    const warn = run('--files', oldFile, newFile, '--mode', 'warn');
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /L1/);
    assert.equal(run('--files', oldFile, newFile, '--mode', 'block').status, 1);
    assert.equal(run().status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --staged reads HEAD and the index of a temporary repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-lint-git-'));
  try {
    const env = scrubGitEnv({ ...process.env, BOARD_LINT: '' });
    const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8', env });
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({ board: { lint: { mode: 'block' } } }));
    fs.writeFileSync(path.join(dir, 'task-board.md'), board(open));
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'task-board.md'), board(open + '\n**Note:** deployed and live now'));
    git('add', 'task-board.md');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--staged'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /L1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- doneTransitions (pure) ----
const itemAs = (status, code = '0101-a') => [`### ${code} ${status} [DEV] Item`, '**Remaining:** x', '**Last evidence:** abc1234'].join('\n');

test('doneTransitions: open item flipped to done', () => {
  assert.deepEqual(doneTransitions(board(itemAs('🔴')), board(itemAs('✅')), fmt), ['0101-a']);
});

test('doneTransitions: a new item added directly as done', () => {
  assert.deepEqual(doneTransitions(board(itemAs('🔴')), board(itemAs('🔴'), itemAs('✅', '0102-b')), fmt), ['0102-b']);
});

test('doneTransitions: done -> done is not a transition; live does not count', () => {
  assert.deepEqual(doneTransitions(board(itemAs('✅')), board(itemAs('✅') + '\n**Note:** more'), fmt), []);
  assert.deepEqual(doneTransitions(board(itemAs('🔴')), board(itemAs('🟢')), fmt), []);
});

test('doneTransitions: a done item moved out of the board (archived) is not a transition', () => {
  assert.deepEqual(doneTransitions(board(itemAs('✅'), itemAs('🔴', '0102-b')), board(itemAs('🔴', '0102-b')), fmt), []);
});
