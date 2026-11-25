// Tests for core/scripts/pre-push-check.mjs (pre-push gate).
// Each test builds a throwaway project (git repo + agent-scaffold.config.json), feeds the
// script ref-update lines on stdin exactly as git does, and checks exit code and output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { parseRefUpdates, pickDeployTargets, parseBlobSizes, ZERO_SHA } from '../core/scripts/pre-push-check.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/pre-push-check.mjs');
const CLEAN = scrubGitEnv();

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pushgate-'))); }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args],
    { env: CLEAN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function project(config, files = {}) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  const full = { version: 2, secretScan: { tool: 'no-such-scanner-xyz', failClosed: false }, ...config };
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(full));
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  return dir;
}

function commit(dir, msg = 'c') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function runGate(cwd, lines, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd, input: lines.join('\n') + '\n', encoding: 'utf8', env: { ...CLEAN, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const line = (branch, sha, remote = ZERO_SHA) => `refs/heads/${branch} ${sha} refs/heads/${branch} ${remote}`;
const deployRepo = (extra = {}) => ({ repos: [{ name: 'app', path: '.', deployBranches: ['main'], sourceExtensions: ['js'], checks: {}, ...extra }] });

// ---------------------------------------------------------------- pure helpers

test('parseRefUpdates reads ref lines and derives the branch', () => {
  const u = parseRefUpdates(`refs/heads/a aaa refs/heads/main bbb\n\nbroken\n`);
  assert.equal(u.length, 1);
  assert.equal(u[0].branch, 'main');
  assert.equal(u[0].localSha, 'aaa');
  assert.equal(u[0].remoteSha, 'bbb');
});

test('pickDeployTargets ignores deletions and rejects different shas', () => {
  const mk = (b, s) => ({ branch: b, localSha: s, remoteSha: ZERO_SHA });
  assert.deepEqual(pickDeployTargets([mk('main', ZERO_SHA)], ['main']).targets, []);
  assert.equal(pickDeployTargets([mk('main', 'a'), mk('prod', 'a')], ['main', 'prod']).error, null);
  assert.match(pickDeployTargets([mk('main', 'a'), mk('prod', 'b')], ['main', 'prod']).error, /different shas/);
});

test('parseBlobSizes keeps only blobs above the limit', () => {
  const hits = parseBlobSizes('blob 3000 big.bin\nblob 10 small.txt\ntree 99999 dir\nblob 5000 \n', 1000);
  assert.deepEqual(hits, [{ bytes: 3000, file: 'big.bin' }]);
});

// ---------------------------------------------------------------- fail-open

test('no config above the repo: exit 0 silently', () => {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x');
  const sha = commit(dir);
  const r = runGate(dir, [line('main', sha)]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
});

test('non-deploy branch: exit 0 without running checks', () => {
  const dir = project(deployRepo({ checks: { syntax: 'node -e "process.exit(1)"' } }), { 'a.js': 'x' });
  const sha = commit(dir);
  const r = runGate(dir, [line('feature', sha)]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /checks starting/);
});

// ---------------------------------------------------------------- git env leak (lock test)

test('children run without GIT_DIR / GIT_INDEX_FILE even when the gate is started with them', () => {
  const decoy = tmp();
  git(decoy, 'init', '-q', '-b', 'main');
  const dir = project(deployRepo({ checks: { syntax: 'node dump-env.mjs {file}' } }), {
    'a.js': 'let ok = 1;\n',
    'dump-env.mjs': `import fs from 'node:fs';
const bad = Object.keys(process.env).filter((k) => /^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX)$/i.test(k));
fs.writeFileSync('env-report.json', JSON.stringify({ bad, cwd: process.cwd() }));
`,
  });
  const sha = commit(dir);
  const dirty = { GIT_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index') };
  const r = runGate(dir, [line('main', sha)], dirty);
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'env-report.json'), 'utf8'));
  assert.deepEqual(report.bad, [], 'child command inherited git env variables');
  assert.equal(fs.realpathSync(report.cwd), dir, 'child must run in the pushed repo, not the decoy');
  // The decoy repository must be untouched (no commits, no config pollution).
  assert.equal(git(decoy, 'rev-list', '--all', '--count'), '0');
});

// ---------------------------------------------------------------- big file gate

function bigRepo(maxBlobMB, mode) {
  const dir = project({ pushGate: { maxBlobMB, bigBlobMode: mode } }, { 'small.txt': 'hi' });
  const base = commit(dir, 'base');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1.5 * 1048576, 7));
  const head = commit(dir, 'add big');
  return { dir, base, head };
}

test('big blob, warn mode (default): lists the file and passes', () => {
  const { dir, base, head } = bigRepo(1, 'warn');
  const r = runGate(dir, [line('feature', head, base)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /big\.bin/);
  assert.match(r.out, /WARN mode/);
});

test('big blob, block mode: blocks on ANY branch and names the escape variable', () => {
  const { dir, base, head } = bigRepo(1, 'block');
  const r = runGate(dir, [line('feature', head, base)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /big\.bin/);
  assert.match(r.out, /BIG_FILE_OK=1/);
  assert.match(r.out, /\[push-gate\] PUSH BLOCKED/);
  assert.doesNotMatch(r.out, /prod-gate/);
});

test('big blob, block mode: deliberate pass with BIG_FILE_OK=1', () => {
  const { dir, base, head } = bigRepo(1, 'block');
  assert.equal(runGate(dir, [line('feature', head, base)], { BIG_FILE_OK: '1' }).code, 0);
});

test('big blob: custom escape variable name comes from config.pushGate.bigBlobEnv', () => {
  const dir = project({ pushGate: { maxBlobMB: 1, bigBlobMode: 'block', bigBlobEnv: 'LET_IT_GO' } });
  const base = commit(dir, 'base');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1.5 * 1048576, 7));
  const head = commit(dir, 'add big');
  assert.equal(runGate(dir, [line('feature', head, base)]).code, 1);
  assert.equal(runGate(dir, [line('feature', head, base)], { LET_IT_GO: '1' }).code, 0);
});

test('big blob already on the remote is not new: block mode passes', () => {
  const { dir, head } = bigRepo(1, 'block');
  fs.writeFileSync(path.join(dir, 'next.txt'), 'small');
  const next = commit(dir, 'small follow-up');
  assert.equal(runGate(dir, [line('feature', next, head)]).code, 0);
});

test('unknown remote sha falls back to --remotes: blob reachable from a remote ref is not new', () => {
  const { dir, head } = bigRepo(1, 'block');
  git(dir, 'update-ref', 'refs/remotes/origin/main', head);
  fs.writeFileSync(path.join(dir, 'next.txt'), 'small');
  const next = commit(dir, 'small follow-up');
  const unfetched = 'a'.repeat(40);
  assert.equal(runGate(dir, [line('feature', next, unfetched)]).code, 0);
});

// ---------------------------------------------------------------- deploy gate

test('syntax gate checks the PUSHED content, not the working tree (bad commit, fixed tree)', () => {
  const dir = project(deployRepo({ checks: { syntax: 'node --check {file}' } }), { 'a.js': 'let x = 1;\n' });
  const base = commit(dir, 'base');
  fs.writeFileSync(path.join(dir, 'a.js'), 'let x = ;\n'); // broken, committed
  const bad = commit(dir, 'break');
  fs.writeFileSync(path.join(dir, 'a.js'), 'let x = 1;\n'); // fixed only in the working tree
  const r = runGate(dir, [line('main', bad, base)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /syntax check failed: a\.js/);
});

test('syntax gate checks the PUSHED content, not the working tree (good commit, broken tree)', () => {
  const dir = project(deployRepo({ checks: { syntax: 'node --check {file}' } }), { 'a.js': 'let x = 1;\n' });
  const base = commit(dir, 'base');
  fs.writeFileSync(path.join(dir, 'a.js'), 'let x = 2;\n');
  const good = commit(dir, 'change');
  fs.writeFileSync(path.join(dir, 'a.js'), 'let x = ;\n'); // uncommitted breakage must not matter
  const r = runGate(dir, [line('main', good, base)]);
  assert.equal(r.code, 0, r.out);
});

test('unknown remote sha does not mean "no changed files": broken file in an unfetched range is caught', () => {
  const dir = project(deployRepo({ checks: { syntax: 'node --check {file}' } }), { 'a.js': 'let x = ;\n' });
  const sha = commit(dir, 'broken');
  const r = runGate(dir, [line('main', sha, 'b'.repeat(40))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /syntax check failed/);
});

test('several deploy targets with different shas are rejected', () => {
  const dir = project({ repos: [{ name: 'app', path: '.', deployBranches: ['main', 'prod'], checks: {} }] }, { 'a.js': '1' });
  const one = commit(dir, 'one');
  fs.writeFileSync(path.join(dir, 'b.js'), '2');
  const two = commit(dir, 'two');
  const r = runGate(dir, [line('main', one), line('prod', two)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /different shas/);
  // The same sha to both targets is fine.
  assert.equal(runGate(dir, [line('main', two), line('prod', two)]).code, 0);
});

test('typecheck counts only when the tree is the pushed commit', () => {
  const dir = project(deployRepo({ checks: { typecheck: 'node -e "process.exit(0)"' } }), { 'a.js': '1' });
  const sha = commit(dir, 'base');
  assert.equal(runGate(dir, [line('main', sha)]).code, 0, 'clean tree at the pushed sha must pass');
  fs.writeFileSync(path.join(dir, 'a.js'), 'dirty'); // dirty tree: a green typecheck would describe another tree
  const r = runGate(dir, [line('main', sha)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not verified for this commit/);
  // A failing typecheck on a clean tree blocks too.
  const dir2 = project(deployRepo({ checks: { typecheck: 'node -e "process.exit(3)"' } }), { 'a.js': '1' });
  const sha2 = commit(dir2, 'base');
  const r2 = runGate(dir2, [line('main', sha2)]);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /typecheck failed/);
});

test('repo identity uses the git common dir: a linked worktree outside the project still matches', () => {
  const dir = project(deployRepo({ checks: { syntax: 'node --check {file}' } }), { 'a.js': 'let x = 1;\n' });
  commit(dir, 'base');
  const wt = path.join(tmp(), 'wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'topic', wt);
  fs.writeFileSync(path.join(wt, 'a.js'), 'let x = ;\n');
  const bad = commit(wt, 'break in worktree');
  const r = runGate(wt, [line('main', bad, git(dir, 'rev-parse', 'main'))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /syntax check failed/);
});

test('secret scan fail-closed: missing tool blocks; skipEnv skips; failClosed=false passes', () => {
  const closed = { secretScan: { tool: 'no-such-scanner-xyz', failClosed: true, skipEnv: 'SKIP_PUSH_GATE' } };
  const dir = project({ ...deployRepo(), ...closed }, { 'a.js': '1' });
  const sha = commit(dir, 'base');
  const blocked = runGate(dir, [line('main', sha)]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /SKIP_PUSH_GATE=1/);
  assert.equal(runGate(dir, [line('main', sha)], { SKIP_PUSH_GATE: '1' }).code, 0);
  const open = project({ ...deployRepo(), secretScan: { tool: 'no-such-scanner-xyz', failClosed: false } }, { 'a.js': '1' });
  assert.equal(runGate(open, [line('main', commit(open, 'base'))]).code, 0);
});
