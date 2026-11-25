// Enforces: R-43
// Tests for core/.claude/hooks/push-guard.mjs (PreToolUse push gates). Pure parsing is tested
// through the exported functions; the gates run the hook as a real child process fed the real
// stdin JSON, against a temporary bare remote + clone inside a temporary project that carries
// an agent-scaffold.config.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitCommand, parsePushCommands } from '../core/.claude/hooks/push-guard.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, '..', 'core', '.claude', 'hooks', 'push-guard.mjs');
const env = () => ({ ...scrubGitEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.excludesFile=', '-c', 'core.hooksPath=', ...args], { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

const tmps = [];
const children = [];
after(() => {
  for (const c of children) try { c.kill(); } catch {}
  for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
});

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// project/ (config + .githooks/pre-push) / origin.git, clone/ (deploy branch: "release")
function makeFixture({ hooks = true, configExtra = {}, config = true } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  tmps.push(project);
  const bare = path.join(project, 'origin.git');
  git(project, 'init', '--bare', '-q', '-b', 'master', bare);
  const clone = path.join(project, 'clone');
  git(project, 'clone', '-q', bare, clone);
  git(clone, 'config', 'user.email', 't@t');
  git(clone, 'config', 'user.name', 't');
  git(clone, 'checkout', '-q', '-b', 'master');
  write(path.join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', 'a.txt');
  git(clone, 'commit', '-q', '-m', 'A');
  git(clone, 'push', '-q', 'origin', 'master');
  git(clone, 'branch', 'release');
  git(clone, 'push', '-q', 'origin', 'release');
  // remote branch `old` is one commit ahead of master: the clone is "behind" it
  git(clone, 'checkout', '-q', '-b', 'old');
  write(path.join(clone, 'b.txt'), 'b\n');
  git(clone, 'add', 'b.txt');
  git(clone, 'commit', '-q', '-m', 'B');
  git(clone, 'push', '-q', 'origin', 'old');
  git(clone, 'checkout', '-q', 'master');
  git(clone, 'branch', '-D', 'old');
  const hooksDir = path.join(project, '.githooks');
  if (hooks) {
    write(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(hooksDir, 'pre-push'), 0o755);
    git(clone, 'config', 'core.hooksPath', hooksDir);
  }
  if (config) {
    write(
      path.join(project, 'agent-scaffold.config.json'),
      JSON.stringify({ version: 2, repos: [{ name: 'clone', path: 'clone', deployBranches: ['release'] }], ...configExtra }),
    );
  }
  return { project, clone, bare, hooksDir };
}

function hook(fx, command, cwd = fx.clone) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    timeout: 30000,
    env: env(),
    windowsHide: true,
  });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch { out = { raw: r.stdout }; }
  return { status: r.status, decision: out?.hookSpecificOutput?.permissionDecision ?? null, reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '', stdout: r.stdout };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('splitCommand: splits on operators outside quotes and strips quotes', () => {
  assert.deepEqual(splitCommand('cd "a b" && git push origin x; echo "a && b"'), [
    ['cd', 'a b'],
    ['git', 'push', 'origin', 'x'],
    ['echo', 'a && b'],
  ]);
});

test('parsePushCommands: remote, refspecs, delete forms', () => {
  const one = (c) => parsePushCommands(c, '/w')[0];
  assert.equal(one('git push origin master').remote, 'origin');
  assert.equal(one('git push origin master:release').specs[0].dst, 'release');
  assert.equal(one('git push origin HEAD:refs/heads/release').specs[0].dst, 'release');
  for (const c of ['git push origin --delete old', 'git push origin -d old', 'git push --delete origin old', 'git push origin :old']) {
    const p = one(c);
    assert.equal(p.deleting, true, c);
    assert.equal(p.remote, 'origin', c);
    assert.deepEqual(p.specs.map((s) => s.dst), ['old'], c);
  }
  assert.equal(one('git push --force-with-lease origin master').force, true);
  assert.equal(one('git push origin +master').specs[0].force, true);
  assert.equal(one('git push origin master').deleting, false);
});

test('parsePushCommands: git -C belongs to ITS OWN push, not to a neighbouring command', () => {
  const p = parsePushCommands('git -C /other status && git push origin master', '/w');
  assert.equal(p.length, 1);
  assert.equal(p[0].dir, path.resolve('/w'));
  const q = parsePushCommands('git -C /other log -1; git -C /third push origin master', '/w');
  assert.equal(q.length, 1);
  assert.equal(q[0].dir, path.resolve('/third'));
});

test('parsePushCommands: cd chain, several pushes, shell -c, env prefixes', () => {
  const p = parsePushCommands('cd /a && git push origin x && cd /b && DEPLOY_LOCK=skip git push origin y', '/w');
  assert.deepEqual(p.map((x) => x.dir), [path.resolve('/a'), path.resolve('/b')]);
  const s = parsePushCommands("bash -c 'git -C /c push origin z'", '/w');
  assert.equal(s[0].dir, path.resolve('/c'));
  assert.deepEqual(parsePushCommands('git status && echo push', '/w'), []);
  assert.deepEqual(parsePushCommands('git commit -m "then git push later"', '/w'), []);
});

// ---------------------------------------------------------------------------
// Delete gate
// ---------------------------------------------------------------------------

for (const cmd of ['git push origin --delete old', 'git push origin -d old', 'git push origin :old', 'git push --delete origin old']) {
  test(`delete push is not blocked by the behind gate: ${cmd}`, () => {
    const r = hook(makeFixture(), cmd);
    assert.equal(r.status, 0);
    assert.equal(r.decision, null, `${r.decision}: ${r.reason}`);
  });
}

for (const b of ['release', 'master']) {
  test(`deploy/main branch cannot be deleted: ${b}`, () => {
    const r = hook(makeFixture(), `git push origin --delete ${b}`);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /DELETE GATE/);
  });
}

test('delete gate also protects config.git.protectedBranches', () => {
  const fx = makeFixture({ configExtra: { git: { protectedBranches: ['old'] } } });
  const r = hook(fx, 'git push origin :old');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /DELETE GATE/);
});

// ---------------------------------------------------------------------------
// Behind gate / deploy confirm / chains
// ---------------------------------------------------------------------------

test('regression: a checkout that is behind still hits the behind gate', () => {
  const fx = makeFixture();
  const r = hook(fx, 'git push origin old');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /BEHIND-PUSH GATE/);
});

test('regression: an up-to-date push to a normal branch is silent', () => {
  const r = hook(makeFixture(), 'git push origin master');
  assert.equal(r.status, 0);
  assert.equal(r.decision, null, r.reason);
});

test('deploy branch push asks once (hooks path set, no lock)', () => {
  const r = hook(makeFixture(), 'git push origin master:release');
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /DEPLOY CONFIRM GATE/);
});

test('two deploy pushes in one chain produce a single ask', () => {
  const r = hook(makeFixture(), 'git push origin master:release && git push origin release');
  assert.equal(r.decision, 'ask');
  assert.equal((r.reason.match(/DEPLOY CONFIRM GATE/g) || []).length, 1);
});

test('a deploy branch name inside a push option does not trigger the deploy ask', () => {
  const r = hook(makeFixture(), 'git push origin master -o "note: release"');
  assert.equal(r.decision, null, r.reason);
});

test('repo not listed in the config falls back to asking on main/master', () => {
  const fx = makeFixture({ configExtra: { repos: [{ name: 'x', path: 'elsewhere', deployBranches: ['release'] }] } });
  assert.equal(hook(fx, 'git push origin master').decision, 'ask');
});

test('fails open when the scaffold config is absent', () => {
  const fx = makeFixture({ config: false });
  const r = hook(fx, 'git push origin master:release');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test("chained command: another repo's `git -C` is not attributed to the push", () => {
  const fx = makeFixture();
  // second clone with an unpushed, unmapped source file + a map: if the hook mistook it for
  // the push's repo it would deny with a map/sha reason
  const other = path.join(fx.project, 'other');
  git(fx.project, 'clone', '-q', fx.bare, other);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  write(path.join(other, 'memory-bank/repoMap.md'), '# Repo map\n');
  write(path.join(other, 'components/unmapped-widget.ts'), 'export const widget = 1;\n');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'unmapped');
  const r = hook(fx, `git -C ${other} log -1 --oneline && git push origin master`);
  assert.equal(r.decision, null, `${r.decision}: ${r.reason}`);
  // and the same repo addressed by -C is judged (and denied) on its own merits
  const d = hook(fx, `git -C ${other} push origin master`, fx.project);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /MAP GATE/);
});

// ---------------------------------------------------------------------------
// Map gate + SHA proof
// ---------------------------------------------------------------------------

function addUnmapped(clone) {
  write(path.join(clone, 'memory-bank/repoMap.md'), '# Repo map\n');
  write(path.join(clone, 'components/unmapped-widget.ts'), 'export const widget = 1;\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'unmapped source');
}

test('map gate: an unmapped source file in the pushed range is denied', () => {
  const fx = makeFixture();
  addUnmapped(fx.clone);
  const r = hook(fx, 'git push origin master');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /MAP GATE/);
  assert.match(r.reason, /unmapped-widget\.ts/);
});

test('map gate: once the file is in the map and committed, the push passes', () => {
  const fx = makeFixture();
  addUnmapped(fx.clone);
  write(path.join(fx.clone, 'memory-bank/repoMap.md'), '# Repo map\ncomponents/unmapped-widget.ts\n');
  git(fx.clone, 'add', '.');
  git(fx.clone, 'commit', '-qm', 'map fix');
  const r = hook(fx, 'git push origin master');
  assert.equal(r.decision, null, `${r.decision}: ${r.reason}`);
});

test('map SHA gate: HEAD map cannot vouch for a different pushed ref', () => {
  const fx = makeFixture();
  addUnmapped(fx.clone);
  git(fx.clone, 'branch', 'bad-source');
  write(path.join(fx.clone, 'memory-bank/repoMap.md'), '# Repo map\ncomponents/unmapped-widget.ts\n');
  git(fx.clone, 'add', '.');
  git(fx.clone, 'commit', '-qm', 'HEAD map fix');
  const r = hook(fx, 'git push origin bad-source:master');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /MAP SHA GATE/);
  assert.match(r.reason, /SHA mismatch/);
});

test('map SHA gate: a dirty working tree is not proof either', () => {
  const fx = makeFixture();
  write(path.join(fx.clone, 'memory-bank/repoMap.md'), '# Repo map\n');
  git(fx.clone, 'add', '.');
  git(fx.clone, 'commit', '-qm', 'map');
  write(path.join(fx.clone, 'scratch.txt'), 'untracked\n');
  const r = hook(fx, 'git push origin master');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /MAP SHA GATE/);
  assert.match(r.reason, /No SHA proof/);
});

test('without a repo map the SHA proof is not required', () => {
  const fx = makeFixture();
  write(path.join(fx.clone, 'scratch.txt'), 'untracked\n');
  const r = hook(fx, 'git push origin master');
  assert.equal(r.decision, null, r.reason);
});

// ---------------------------------------------------------------------------
// Hooks path gate
// ---------------------------------------------------------------------------

test('hooks path gate: deploy push without core.hooksPath is denied with the fix command', () => {
  const fx = makeFixture({ hooks: false });
  write(path.join(fx.project, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  const r = hook(fx, 'git push origin master:release');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /HOOKSPATH GATE/);
  assert.match(r.reason, /setup-hooks\.(sh|bat)/);
});

test('hooks path gate: hooksPath pointing at a directory without pre-push is denied', () => {
  const fx = makeFixture();
  const empty = path.join(fx.project, 'empty-hooks');
  fs.mkdirSync(empty);
  git(fx.clone, 'config', 'core.hooksPath', empty);
  const r = hook(fx, 'git push origin master:release');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /HOOKSPATH GATE/);
});

test('hooks path gate: non-deploy pushes are unaffected', () => {
  const fx = makeFixture({ hooks: false });
  write(path.join(fx.project, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  assert.equal(hook(fx, 'git push origin master').decision, null);
});

test('hooks path gate: config.pushGate.requireHooksPath=false turns it off', () => {
  const fx = makeFixture({ hooks: false, configExtra: { pushGate: { requireHooksPath: false } } });
  write(path.join(fx.project, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  assert.equal(hook(fx, 'git push origin master:release').decision, 'ask');
});

test('hooks path gate: a project without a shipped pre-push hook is not nagged', () => {
  const fx = makeFixture({ hooks: false });
  assert.equal(hook(fx, 'git push origin master:release').decision, 'ask');
});

// ---------------------------------------------------------------------------
// Deploy lock (end to end, POSIX with lsof)
// ---------------------------------------------------------------------------

const hasLsof = process.platform !== 'win32' && spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

test('deploy lock: a running deploy push in the same repo denies; DEPLOY_LOCK=skip passes to the ask', { skip: !hasLsof }, async () => {
  const fx = makeFixture({ configExtra: { repos: [{ name: 'clone', path: 'clone', deployBranches: ['lockedlane'] }] } });
  git(fx.clone, 'branch', 'lockedlane');
  git(fx.clone, 'push', '-q', 'origin', 'lockedlane');
  const c = spawn('bash', ['-c', 'exec -a "git push origin master:lockedlane" sleep 30'], { cwd: fx.clone, stdio: 'ignore' });
  children.push(c);
  await new Promise((r) => setTimeout(r, 300));
  const locked = hook(fx, 'git push origin master:lockedlane');
  assert.equal(locked.decision, 'deny');
  assert.match(locked.reason, /DEPLOY LOCK/);
  const skipped = hook(fx, 'DEPLOY_LOCK=skip git push origin master:lockedlane');
  assert.equal(skipped.decision, 'ask');
  c.kill();
});
