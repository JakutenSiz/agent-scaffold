// Tests for core/scripts/git-hygiene-watch.mjs (Enforces: R-32) against real throwaway repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, formatLine } from '../core/scripts/git-hygiene-watch.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { makeFixture, writeConfig, branchNames, worktreePaths, commit, git, OLD } from './_git-hygiene-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';

const CLI = path.resolve('core/scripts/git-hygiene-watch.mjs');
const run = (fx, args) => execFileSync('node', [CLI, ...args], { cwd: fx.root, encoding: 'utf8', env: scrubGitEnv() });

test('scan counts merged branches, clean worktrees and dirty worktrees', () => {
  const fx = makeFixture();
  try {
    const res = scan({ root: fx.root, config: fx.config, cwds: [fx.root] });
    assert.equal(res.repos.length, 1);
    const e = res.repos[0];
    assert.deepEqual(e.branches.sort(), ['deployed', 'merged-old']);
    assert.deepEqual(e.cleanWorktrees, [fx.worktrees.clean]);
    assert.deepEqual(e.dirtyWorktrees.map((w) => w.path), [fx.worktrees.dirty]);
    assert.equal(res.debt, 2 + 1 + 1);
    assert.match(formatLine(res.repos), /app 2 merged branches, 2 clean merged worktrees \(1 held by live references\), 1 dirty worktrees/);
  } finally { fx.cleanup(); }
});

test('--line prints one line and deletes nothing when autoClean is off', () => {
  const fx = makeFixture();
  try {
    const before = [branchNames(fx.root), worktreePaths(fx.root)];
    const out = run(fx, ['--line']);
    assert.equal(out.trim().split('\n').length, 1);
    assert.match(out, /^git hygiene: app 2 merged branches/);
    assert.match(out, /2 clean merged worktrees \(1 held by live references\)/);
    assert.match(out, /git-hygiene-clean\.mjs --write/);
    assert.deepEqual([branchNames(fx.root), worktreePaths(fx.root)], before);
  } finally { fx.cleanup(); }
});

test('--line with autoClean cleans first and reports removed and remaining', () => {
  const fx = makeFixture();
  try {
    writeConfig(fx.root, { git: { hygiene: { autoClean: true } } });
    const out = run(fx, ['--line']);
    assert.match(out, /^git hygiene: removed: 2 branches \+ 1 worktrees; remaining 1 /);
    assert.ok(!branchNames(fx.root).includes('merged-old'));
    assert.ok(!worktreePaths(fx.root).includes(fx.worktrees.clean));
    // second run: nothing left to remove, the dirty worktree is still reported as debt
    assert.doesNotMatch(run(fx, ['--line']), /removed:/);
  } finally { fx.cleanup(); }
});

test('--line prints nothing when there is no debt', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-')));
  try {
    const origin = path.join(tmp, 'origin.git');
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    git(tmp, ['init', '--bare', '-b', 'main', origin]);
    git(root, ['init', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', origin]);
    commit(root, 'a.txt', OLD);
    git(root, ['push', 'origin', 'main']);
    git(root, ['remote', 'set-head', 'origin', 'main']);
    writeConfig(root, { repos: [{ name: 'app', path: '.' }] });
    const out = execFileSync('node', [CLI, '--line'], { cwd: root, encoding: 'utf8', env: scrubGitEnv() });
    assert.equal(out, '');
    assert.match(execFileSync('node', [CLI], { cwd: root, encoding: 'utf8', env: scrubGitEnv() }), /no debt/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('--json is machine readable', () => {
  const fx = makeFixture();
  try {
    const parsed = JSON.parse(run(fx, ['--json']));
    assert.equal(parsed.debt, 4);
    assert.ok(parsed.generatedAt);
    assert.equal(parsed.repos[0].repo, 'app');
    assert.deepEqual(parsed.repos[0].branches.sort(), ['deployed', 'merged-old']);
  } finally { fx.cleanup(); }
});

test('--strict exits 1 when there is debt', () => {
  const fx = makeFixture();
  try {
    assert.throws(() => run(fx, ['--strict']), (e) => e.status === 1);
  } finally { fx.cleanup(); }
});

test('without a config file the script stays silent (fail-open)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-')));
  try {
    const out = execFileSync('node', [CLI, '--line'], { cwd: tmp, encoding: 'utf8', env: scrubGitEnv() });
    assert.equal(out, '');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
