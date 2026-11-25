// Tests for core/scripts/done-gate.mjs and core/scripts/gate-record.mjs (completion gate).
// Each test builds a throwaway git repo with a task board, records (or does not record) a gate
// run, stages a board edit that closes an item and runs `done-gate --staged` the way the
// pre-commit hook does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts');
const DONE_GATE = path.join(SCRIPTS, 'done-gate.mjs');
const GATE_RECORD = path.join(SCRIPTS, 'gate-record.mjs');
const CLEAN = scrubGitEnv();

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

const OPEN = ['### 0101-a 🔴 [DEV] Item a', '**Remaining:** build it', '**Last evidence:** 2026-01-01 abc1234'].join('\n');
const DONE = ['### 0101-a ✅ [DEV] Item a', '**Remaining:** none', '**Last evidence:** 2026-01-02 abc1234 deploy ok'].join('\n');
const boardWith = (item) => ['# Board', '', '## Open items', '', item, ''].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args],
    { env: CLEAN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Repo with one commit: config, an open board item and a source file. */
function project(doneGate = { command: PASS, timeoutSec: 30, mode: 'block' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'donegate-')));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'agent-scaffold.config.json', JSON.stringify({ version: 2, board: { file: 'task-board.md' }, doneGate }));
  write(dir, 'task-board.md', boardWith(OPEN));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const run = (script, dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [script, ...args, '--root', dir], { cwd: dir, encoding: 'utf8', env: { ...CLEAN, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const record = (dir) => run(GATE_RECORD, dir, []);
const gate = (dir) => run(DONE_GATE, dir, ['--staged']);

/** Stages the board edit that closes the item. */
function closeItem(dir) {
  write(dir, 'task-board.md', boardWith(DONE));
  git(dir, 'add', 'task-board.md');
}

/** Stages a source change (a new commit-worthy code state). */
function changeCode(dir, text = 'export const a = 2;\n') {
  write(dir, 'src/a.js', text);
  git(dir, 'add', 'src/a.js');
}

const recordFiles = (dir) => {
  const d = path.join(dir, '.git', 'agent-scaffold');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^gate-.*\.json$/.test(f)).map((f) => path.join(d, f)) : [];
};

test('transition + no record: red, message names the command to run', () => {
  const dir = project();
  closeItem(dir);
  const r = gate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /gate-record/);
  assert.ok(r.out.includes(PASS));
});

test('red record: gate-record exits 1, done-gate rejects', () => {
  const dir = project({ command: FAIL, timeoutSec: 30, mode: 'block' });
  assert.equal(record(dir).code, 1);
  assert.equal(recordFiles(dir).length, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(recordFiles(dir)[0], 'utf8')).exit, 0);
  closeItem(dir);
  assert.equal(gate(dir).code, 1);
});

test('code changed after the record: red', () => {
  const dir = project();
  assert.equal(record(dir).code, 0);
  changeCode(dir);
  closeItem(dir);
  assert.equal(gate(dir).code, 1);
});

test('green fresh record: passes; record carries codeId, command, exit, startedAt, durationMs', () => {
  const dir = project();
  assert.equal(record(dir).code, 0);
  const rec = JSON.parse(fs.readFileSync(recordFiles(dir)[0], 'utf8'));
  assert.deepEqual(Object.keys(rec).sort(), ['codeId', 'command', 'durationMs', 'exit', 'startedAt']);
  assert.equal(rec.command, PASS);
  assert.equal(rec.exit, 0);
  closeItem(dir);
  assert.equal(gate(dir).code, 0);
});

test('board-only commit after the record passes, also with other exempt paths changed', () => {
  const dir = project();
  changeCode(dir);
  assert.equal(record(dir).code, 0);
  git(dir, 'commit', '-q', '-m', 'code'); // the commit itself does not stale the record
  closeItem(dir);
  write(dir, 'memory-bank/notes.md', 'note\n');
  write(dir, 'specs/s.md', 'spec\n');
  write(dir, 'handoffs/h.md', 'handoff\n');
  git(dir, 'add', '-A');
  assert.equal(gate(dir).code, 0);
});

test('a record taken with another command does not count', () => {
  const dir = project();
  assert.equal(record(dir).code, 0);
  const file = recordFiles(dir)[0];
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, command: 'node -e "process.exit(0)" # other' }));
  closeItem(dir);
  assert.equal(gate(dir).code, 1);
});

test('mode warn: reports but exits 0', () => {
  const dir = project({ command: PASS, timeoutSec: 30, mode: 'warn' });
  closeItem(dir);
  const r = gate(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /gate-record/);
});

test('empty command: no gate', () => {
  const dir = project({ command: '', timeoutSec: 30, mode: 'block' });
  closeItem(dir);
  const r = gate(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('no ✅ transition: passes without a record', () => {
  const dir = project();
  write(dir, 'task-board.md', boardWith(OPEN + '\n**Decision/blocker:** none'));
  git(dir, 'add', 'task-board.md');
  assert.equal(gate(dir).code, 0);
});

test('timeout counts as red', () => {
  const dir = project({ command: 'node -e "setTimeout(()=>{},5000)"', timeoutSec: 1, mode: 'block' });
  const r = record(dir);
  assert.equal(r.code, 1);
  assert.notEqual(JSON.parse(fs.readFileSync(recordFiles(dir)[0], 'utf8')).exit, 0);
  closeItem(dir);
  assert.equal(gate(dir).code, 1);
});
