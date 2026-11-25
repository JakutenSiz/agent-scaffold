// Enforces: R-43
// Tests for core/.claude/hooks/ensure-agent-compat.mjs: the directory links (existing
// behaviour) and the SessionStart core.hooksPath wiring (config.session.ensureHooksPath).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDirectoryLink, ensureHooksPath } from '../core/.claude/hooks/ensure-agent-compat.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const tmps = [];
after(() => {
  for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
});
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: scrubGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hooksPathOf = (dir) => {
  try { return git(dir, 'config', '--local', '--get', 'core.hooksPath'); } catch { return ''; }
};

// project: git root with .githooks/pre-push, sub repo `svc` (git), sub repo `ghost` (no .git)
function makeProject({ prePush = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-'));
  tmps.push(root);
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'svc'));
  git(path.join(root, 'svc'), 'init', '-q');
  fs.mkdirSync(path.join(root, 'ghost'));
  if (prePush) {
    fs.mkdirSync(path.join(root, '.githooks'));
    fs.writeFileSync(path.join(root, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  }
  const config = { repos: [{ path: '.' }, { path: 'svc' }, { path: 'ghost' }] };
  return { root, config, hooksDir: path.join(root, '.githooks') };
}

test('empty core.hooksPath is set to <root>/.githooks in the root and each initialised repo, one line each', () => {
  const p = makeProject();
  const lines = ensureHooksPath(p.root, p.config);
  assert.equal(hooksPathOf(p.root), p.hooksDir);
  assert.equal(hooksPathOf(path.join(p.root, 'svc')), p.hooksDir);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /push gate enabled: \. -> \.githooks/);
  assert.match(lines[1], /push gate enabled: svc -> \.githooks/);
  assert.ok(!fs.existsSync(path.join(p.root, 'ghost', '.git')));
});

test('idempotent: a second run prints nothing', () => {
  const p = makeProject();
  ensureHooksPath(p.root, p.config);
  assert.deepEqual(ensureHooksPath(p.root, p.config), []);
});

test('a repo already pointing elsewhere is left untouched and only warned about', () => {
  const p = makeProject();
  const custom = path.join(p.root, 'custom-hooks');
  fs.mkdirSync(custom);
  git(path.join(p.root, 'svc'), 'config', 'core.hooksPath', custom);
  const lines = ensureHooksPath(p.root, p.config);
  assert.equal(hooksPathOf(path.join(p.root, 'svc')), custom);
  assert.ok(lines.some((l) => /svc: core\.hooksPath is .*left unchanged/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /push gate enabled: \./.test(l)));
});

test('config.session.ensureHooksPath=false disables the wiring', () => {
  const p = makeProject();
  assert.deepEqual(ensureHooksPath(p.root, { ...p.config, session: { ensureHooksPath: false } }), []);
  assert.equal(hooksPathOf(p.root), '');
});

test('without .githooks/pre-push nothing is configured', () => {
  const p = makeProject({ prePush: false });
  assert.deepEqual(ensureHooksPath(p.root, p.config), []);
  assert.equal(hooksPathOf(p.root), '');
});

test('log callback receives the same lines', () => {
  const p = makeProject();
  const seen = [];
  const lines = ensureHooksPath(p.root, p.config, (l) => seen.push(l));
  assert.deepEqual(seen, lines);
});

test('ensureDirectoryLink: creates the link, is idempotent, refuses to overwrite a foreign path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-link-'));
  tmps.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  ensureDirectoryLink(root, '.agents/skills', '.claude/skills');
  assert.equal(fs.realpathSync(path.join(root, '.agents', 'skills')), fs.realpathSync(path.join(root, '.claude', 'skills')));
  ensureDirectoryLink(root, '.agents/skills', '.claude/skills'); // no throw
  fs.mkdirSync(path.join(root, '.claude', 'hooks'));
  fs.mkdirSync(path.join(root, '.codex', 'hooks'), { recursive: true });
  assert.throws(() => ensureDirectoryLink(root, '.codex/hooks', '.claude/hooks'), /refusing to overwrite/);
});
