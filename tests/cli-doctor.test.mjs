// Tests for `agent-scaffold doctor`: each failure class is produced on its own and must be the only FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-scaffold.mjs');

const tmps = [];
function tmp(prefix = 'cli-doctor-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const FIXTURE = {
  version: 2,
  projectName: 'fixture-project',
  language: 'en',
  layout: 'single',
  humanGatekeeper: 'the project owner',
  humans: ['OWNER'],
  repos: [{ name: 'app', path: '.', stack: 'node', checks: {}, editCheck: [], deployBranches: ['main'], sourceExtensions: ['mjs'] }],
  secretScan: { failClosed: false },
};
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: scrubGitEnv(), timeout: 120000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: scrubGitEnv() });
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

/** A healthy installation inside a git repo (so core.hooksPath is wired). */
function healthy(configPatch = (c) => c) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  const cfg = path.join(tmp('cfg-'), 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(configPatch(structuredClone(FIXTURE)), null, 2));
  const r = run(['install', dir, '--config', cfg, '--no-check']);
  assert.equal(r.code, 0, r.out);
  return dir;
}
const doctor = (dir) => {
  const r = run(['doctor', dir, '--json']);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { assert.fail(`doctor --json did not print JSON: ${r.out}`); }
  return { code: r.code, json, failed: json.checks.filter((c) => c.status === 'FAIL').map((c) => c.id), warned: json.checks.filter((c) => c.status === 'WARN').map((c) => c.id) };
};

test('a healthy installation: exit 0, no FAIL, and the rows are PASS/WARN/FAIL', () => {
  const dir = healthy();
  const d = doctor(dir);
  assert.equal(d.code, 0, JSON.stringify(d.json, null, 1));
  assert.deepEqual(d.failed, []);
  assert.equal(d.json.ok, true);
  for (const c of d.json.checks) assert.ok(['PASS', 'WARN', 'FAIL'].includes(c.status), c.id);
  const ids = d.json.checks.map((c) => c.id);
  for (const id of ['config', 'manifest', 'engine-files', 'settings-wiring', 'codex-wiring', 'hooks-path', 'node', 'secret-scan', 'memory-bank', 'rule-inventory']) {
    assert.ok(ids.includes(id), `no ${id} row`);
  }
  const text = run(['doctor', dir]);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /PASS/);
});

test('a scaffold hook removed from settings.json: FAIL on the wiring row only', () => {
  const dir = healthy();
  const s = JSON.parse(read(dir, '.claude/settings.json'));
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes('git-shield'));
  write(dir, '.claude/settings.json', JSON.stringify(s, null, 2));
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['settings-wiring']);
  assert.match(d.json.checks.find((c) => c.id === 'settings-wiring').message, /git-shield\.mjs/);
});

test('a hook removed from .codex/hooks.json: FAIL on the codex row only', () => {
  const dir = healthy();
  const h = JSON.parse(read(dir, '.codex/hooks.json'));
  delete h.hooks.PreToolUse;
  write(dir, '.codex/hooks.json', JSON.stringify(h, null, 2));
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['codex-wiring']);
});

test('a broken config file: FAIL on the config row', () => {
  const dir = healthy();
  write(dir, 'agent-scaffold.config.json', '{ "projectName": ');
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.ok(d.failed.includes('config'), JSON.stringify(d.failed));
});

test('a missing engine file: FAIL on the engine-files row only', () => {
  const dir = healthy();
  fs.rmSync(path.join(dir, 'scripts/board-lint.mjs'));
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['engine-files']);
  assert.match(d.json.checks.find((c) => c.id === 'engine-files').message, /scripts\/board-lint\.mjs/);
});

test('an empty core.hooksPath: FAIL on the hooks-path row only', () => {
  const dir = healthy();
  git(dir, 'config', '--local', '--unset', 'core.hooksPath');
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['hooks-path']);
});

test('a hook that lost its executable bit: FAIL on the hook-executable row', { skip: process.platform === 'win32' }, () => {
  const dir = healthy();
  fs.chmodSync(path.join(dir, '.githooks/pre-push'), 0o644);
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['hook-executable']);
});

test('a link pointing somewhere else: FAIL on the links row', { skip: process.platform === 'win32' }, () => {
  const dir = healthy();
  fs.rmSync(path.join(dir, '.agents/skills'));
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, '.agents/skills'), 'dir');
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.deepEqual(d.failed, ['links']);
});

test('pending .new files, a modified engine file and a package version difference are WARN, not FAIL', () => {
  const dir = healthy();
  write(dir, 'scripts/md-size-watch.mjs', '// local patch\n');
  write(dir, 'CLAUDE.md.new', 'pending review\n');
  const m = JSON.parse(read(dir, '.agent-scaffold/manifest.json'));
  m.packageVersion = '0.0.1';
  write(dir, '.agent-scaffold/manifest.json', JSON.stringify(m, null, 2));
  const d = doctor(dir);
  assert.equal(d.code, 0, JSON.stringify(d.json, null, 1));
  assert.ok(d.warned.includes('pending-new'), JSON.stringify(d.warned));
  assert.ok(d.warned.includes('drift'), JSON.stringify(d.warned));
  assert.ok(d.warned.includes('manifest'), JSON.stringify(d.warned));
});

test('secret scanner missing: FAIL when failClosed, WARN otherwise', () => {
  const closed = healthy((c) => ({ ...c, secretScan: { tool: 'gitleaks-not-installed-xyz', failClosed: true } }));
  const d1 = doctor(closed);
  assert.deepEqual(d1.failed, ['secret-scan']);
  const open = healthy((c) => ({ ...c, secretScan: { tool: 'gitleaks-not-installed-xyz', failClosed: false } }));
  const d2 = doctor(open);
  assert.deepEqual(d2.failed, []);
  assert.ok(d2.warned.includes('secret-scan'));
});

test('rule-inventory --strict failing makes the rule-inventory row FAIL', () => {
  const dir = healthy();
  write(dir, 'scripts/extra-enforcer.mjs', '// Enforces: R-999\n');
  const d = doctor(dir);
  assert.equal(d.code, 1);
  assert.ok(d.failed.includes('rule-inventory'), JSON.stringify(d.json.checks));
});

test('doctor on a directory without an installation: exit 1', () => {
  const dir = tmp();
  const r = run(['doctor', dir]);
  assert.equal(r.code, 1, r.out);
});
