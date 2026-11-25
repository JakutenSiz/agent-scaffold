// Tests for `agent-scaffold upgrade`: it must never overwrite what the user changed.
// "Old package" states are simulated by rewriting a file and its manifest hash to an older value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { sha256 } from '../bin/lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core');
const CLI = path.join(ROOT, 'bin', 'agent-scaffold.mjs');

const tmps = [];
function tmp(prefix = 'cli-upgrade-') {
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
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
function installed() {
  const dir = tmp();
  const cfg = path.join(tmp('cfg-'), 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(FIXTURE, null, 2));
  const r = run(['install', dir, '--config', cfg, '--no-check']);
  assert.equal(r.code, 0, r.out);
  return dir;
}
const upgrade = (dir, ...extra) => run(['upgrade', dir, '--no-check', ...extra]);
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const manifestOf = (dir) => JSON.parse(read(dir, '.agent-scaffold/manifest.json'));
const saveManifest = (dir, m) => write(dir, '.agent-scaffold/manifest.json', JSON.stringify(m, null, 2));
const pkgBytes = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

/** Simulate "the project was installed from an older package": disk and manifest agree on `oldText`. */
function asOldPackage(dir, rel, oldText) {
  write(dir, rel, oldText);
  const m = manifestOf(dir);
  m.files[rel].sha256 = sha256(Buffer.from(oldText));
  saveManifest(dir, m);
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs);
      if (e.isDirectory()) { out[`${rel}/`] = ''; walk(abs); }
      else if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
      else out[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(dir);
  return out;
}

const ENGINE = 'scripts/md-size-watch.mjs';

test('user changed an engine file: upgrade does not overwrite it and leaves <file>.new', () => {
  const dir = installed();
  write(dir, ENGINE, '// my local patch\n');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, ENGINE), '// my local patch\n');
  assert.equal(read(dir, `${ENGINE}.new`), pkgBytes(ENGINE));
  assert.ok(r.out.includes(`${ENGINE}.new`), r.out);
  // The manifest still records the pristine hash, so the next upgrade conflicts again until the user resolves it.
  assert.equal(manifestOf(dir).files[ENGINE].sha256, sha256(Buffer.from(pkgBytes(ENGINE))));
});

test('user did not change it: an engine file from an older package is updated in place and the manifest renewed', () => {
  const dir = installed();
  asOldPackage(dir, ENGINE, '// old package version\n');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, ENGINE), pkgBytes(ENGINE));
  assert.ok(!exists(dir, `${ENGINE}.new`));
  assert.equal(manifestOf(dir).files[ENGINE].sha256, sha256(Buffer.from(pkgBytes(ENGINE))));
});

test('seed files are never touched, even when they differ from the package', () => {
  const dir = installed();
  write(dir, 'CLAUDE.md', 'completely rewritten by the team\n');
  write(dir, 'task-board.md', 'my board\n');
  write(dir, 'memory-bank/repoMap.md', 'my map\n');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, 'CLAUDE.md'), 'completely rewritten by the team\n');
  assert.equal(read(dir, 'task-board.md'), 'my board\n');
  assert.equal(read(dir, 'memory-bank/repoMap.md'), 'my map\n');
  assert.ok(!exists(dir, 'CLAUDE.md.new') && !exists(dir, 'task-board.md.new') && !exists(dir, 'memory-bank/repoMap.md.new'));
});

test('hybrid files always get <file>.new, even when the user never touched them', () => {
  const dir = installed();
  const rel = 'docs/agent-working-rules.md';
  asOldPackage(dir, rel, '# old rules\n');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, rel), '# old rules\n');
  assert.equal(read(dir, `${rel}.new`), pkgBytes(rel));
  // identical hybrid file: nothing to review, no .new
  const dir2 = installed();
  assert.equal(upgrade(dir2).code, 0);
  assert.ok(!exists(dir2, `${rel}.new`));
});

test('a deleted engine file is restored', () => {
  const dir = installed();
  fs.rmSync(path.join(dir, ENGINE));
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, ENGINE), pkgBytes(ENGINE));
});

test('an engine file the package no longer ships is reported, never deleted', () => {
  const dir = installed();
  write(dir, 'scripts/retired-helper.mjs', '// old\n');
  const m = manifestOf(dir);
  m.files['scripts/retired-helper.mjs'] = { sha256: sha256(Buffer.from('// old\n')), class: 'engine' };
  saveManifest(dir, m);
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(exists(dir, 'scripts/retired-helper.mjs'));
  assert.match(r.out, /no longer ships/);
  assert.match(r.out, /scripts\/retired-helper\.mjs/);
});

test('no manifest: adopt. Identical files are recorded, different ones get .new, nothing is overwritten', () => {
  const dir = installed();
  fs.rmSync(path.join(dir, '.agent-scaffold'), { recursive: true });
  write(dir, ENGINE, '// diverged before adoption\n');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /adopt/i);
  assert.equal(read(dir, ENGINE), '// diverged before adoption\n');
  assert.ok(exists(dir, `${ENGINE}.new`));
  const m = manifestOf(dir);
  assert.equal(m.files[ENGINE], undefined);
  assert.equal(m.files['scripts/board-lint.mjs'].class, 'engine');
  assert.equal(m.files['scripts/board-lint.mjs'].sha256, sha256(Buffer.from(pkgBytes('scripts/board-lint.mjs'))));
});

test('settings.json: user hook and permission survive, a removed scaffold wire comes back, second run is idempotent', () => {
  const dir = installed();
  const s = JSON.parse(read(dir, '.claude/settings.json'));
  s.permissions.allow.push('Bash(my-own-tool *)');
  s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node my-extra-start.mjs' }] });
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes('git-shield'));
  write(dir, '.claude/settings.json', JSON.stringify(s, null, 2));
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  const healed = read(dir, '.claude/settings.json');
  assert.match(healed, /git-shield\.mjs/);
  assert.match(healed, /my-extra-start\.mjs/);
  assert.match(healed, /Bash\(my-own-tool \*\)/);
  const again = upgrade(dir);
  assert.equal(again.code, 0, again.out);
  assert.equal(read(dir, '.claude/settings.json'), healed);
});

test('.codex/hooks.json: user hook survives and a removed wire is restored', () => {
  const dir = installed();
  const h = JSON.parse(read(dir, '.codex/hooks.json'));
  h.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node mine.mjs' }] });
  delete h.hooks.PreToolUse;
  write(dir, '.codex/hooks.json', JSON.stringify(h, null, 2));
  assert.equal(upgrade(dir).code, 0);
  const back = read(dir, '.codex/hooks.json');
  assert.match(back, /mine\.mjs/);
  assert.match(back, /codex-guard-adapter\.mjs/);
});

test('--dry-run reports the plan and leaves the tree byte-identical', () => {
  const dir = installed();
  asOldPackage(dir, ENGINE, '// old package version\n');
  write(dir, 'scripts/board-lint.mjs', '// user patch\n');
  fs.rmSync(path.join(dir, 'scripts/orphan-process.mjs'));
  const s = JSON.parse(read(dir, '.claude/settings.json'));
  delete s.hooks.PostToolUse;
  write(dir, '.claude/settings.json', JSON.stringify(s));
  const before = snapshot(dir);
  const r = upgrade(dir, '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry-run/i);
  assert.match(r.out, /scripts\/board-lint\.mjs\.new/);
  assert.deepEqual(snapshot(dir), before);
});

test('summary lists config keys the example has and the project config lacks (notification only)', () => {
  const dir = installed();
  const example = JSON.parse(pkgBytes('agent-scaffold.config.example.json'));
  const mine = JSON.parse(read(dir, 'agent-scaffold.config.json'));
  const absent = Object.keys(example).find((k) => !k.startsWith('$') && !(k in mine));
  assert.ok(absent, 'fixture assumption: the example has a top-level key the fixture lacks');
  const before = read(dir, 'agent-scaffold.config.json');
  const r = upgrade(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /config keys/i);
  assert.ok(r.out.includes(absent), `expected ${absent} in: ${r.out}`);
  assert.equal(read(dir, 'agent-scaffold.config.json'), before);
});

test('upgrade on a directory that is not an installation exits 1', () => {
  const dir = tmp();
  const r = upgrade(dir);
  assert.equal(r.code, 1, r.out);
});
