// Tests for core/scripts/gate-record.mjs: it records a gate run for the current code state and
// refuses to do so when the working tree differs from the index outside the exempt paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const GATE_RECORD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/gate-record.mjs');
const CLEAN = scrubGitEnv();

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args],
    { env: CLEAN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function project(doneGate = { command: 'node -e "process.exit(0)"', timeoutSec: 30, mode: 'block' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gaterec-')));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'agent-scaffold.config.json', JSON.stringify({ version: 2, board: { file: 'task-board.md' }, doneGate }));
  write(dir, 'task-board.md', '# Board\n');
  write(dir, 'src/a.js', 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const record = (dir) => {
  const r = spawnSync(process.execPath, [GATE_RECORD, '--root', dir], { cwd: dir, encoding: 'utf8', env: CLEAN });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const recordFiles = (dir) => {
  const d = path.join(dir, '.git', 'agent-scaffold');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^gate-.*\.json$/.test(f)) : [];
};

test('clean tree: writes gate-<codeId>.json under the git common dir', () => {
  const dir = project();
  const r = record(dir);
  assert.equal(r.code, 0);
  const files = recordFiles(dir);
  assert.equal(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.git', 'agent-scaffold', files[0]), 'utf8'));
  assert.equal(files[0], `gate-${rec.codeId}.json`);
  assert.match(rec.codeId, /^[0-9a-f]{64}$/);
  assert.equal(rec.exit, 0);
});

test('empty command: nothing to record, nothing written', () => {
  const dir = project({ command: '', timeoutSec: 30, mode: 'block' });
  assert.equal(record(dir).code, 0);
  assert.deepEqual(recordFiles(dir), []);
});

test('dirty tree (working tree != index): refuses and writes nothing', () => {
  const dir = project();
  write(dir, 'src/a.js', 'export const a = 3;\n'); // modified, not staged
  const r = record(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/a\.js/);
  assert.deepEqual(recordFiles(dir), []);
});

test('untracked non-exempt file refuses; exempt-path changes are ignored', () => {
  const dir = project();
  write(dir, 'src/new.js', 'x\n');
  assert.equal(record(dir).code, 1);
  fs.rmSync(path.join(dir, 'src/new.js'));
  write(dir, 'task-board.md', '# Board changed\n'); // exempt, unstaged
  write(dir, 'reports/r.md', 'r\n');
  assert.equal(record(dir).code, 0);
});
