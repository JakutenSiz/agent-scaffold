// Enforces: R-43
// Tests for core/.claude/hooks/lib/deploy-lock.mjs. The pure parts (candidates, elapsedMinutes)
// are tested on fixed text; the process scan is tested end to end with a real child process
// whose command line looks like a deploy push (POSIX only: needs ps and lsof).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidates, elapsedMinutes, lockCheck } from '../core/.claude/hooks/lib/deploy-lock.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const BR = ['shiplane'];

test('candidates: finds deploy pushes, with and without git -C', () => {
  const ps = [
    '  101 /usr/bin/git push origin master:shiplane',
    '  102 git -C /work/other push origin shiplane',
    '  103 git push origin master',
    '  104 node server.js',
  ].join('\n');
  assert.deepEqual(candidates(ps, BR), [
    { pid: 101, target: 'shiplane' },
    { pid: 102, target: 'shiplane', c: '/work/other' },
  ]);
});

test('candidates: ignores deletion pushes, excluded pids and an empty branch list', () => {
  const ps = [
    '  201 git push origin --delete shiplane',
    '  202 git push origin :shiplane',
    '  203 git push -d origin shiplane',
    '  204 git push origin shiplane',
  ].join('\n');
  assert.deepEqual(candidates(ps, BR), [{ pid: 204, target: 'shiplane' }]);
  assert.deepEqual(candidates(ps, BR, [204]), []);
  assert.deepEqual(candidates(ps, []), []);
  assert.deepEqual(candidates('', BR), []);
  assert.deepEqual(candidates(undefined, BR), []);
});

test('candidates: flags do not count as remote or refspec; chains stop at the operator', () => {
  const ps = '  301 git push --force-with-lease origin HEAD:shiplane && echo shiplane';
  assert.deepEqual(candidates(ps, BR), [{ pid: 301, target: 'shiplane' }]);
  assert.deepEqual(candidates('  302 git push origin master && echo shiplane', BR), []);
});

test('candidates: only a process whose argv0 is git counts (shell wrappers, node -e and grep are false positives)', () => {
  const ps = [
    '  401 zsh -c "git push origin main"',
    '  402 sh -c git push origin main',
    '  403 node -e "// git push origin main" ',
    '  404 grep -r git push origin main src',
    '  405 git push origin main',
    '  406 /usr/bin/git -C /x push origin main',
    '  407 git -c core.x=1 -C /y push origin main',
  ].join('\n');
  assert.deepEqual(candidates(ps, ['main']), [
    { pid: 405, target: 'main' },
    { pid: 406, target: 'main', c: '/x' },
    { pid: 407, target: 'main', c: '/y' },
  ]);
});

test('elapsedMinutes: parses mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  assert.equal(elapsedMinutes('00:42'), 0);
  assert.equal(elapsedMinutes('  12:05 '), 12);
  assert.equal(elapsedMinutes('01:02:03'), 62);
  assert.equal(elapsedMinutes('2-01:00:00'), 2 * 1440 + 60);
  assert.equal(elapsedMinutes('garbage'), null);
});

const posix = process.platform !== 'win32' && spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;
const tmps = [];
const children = [];
after(() => {
  for (const c of children) try { c.kill(); } catch {}
  for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
});

function gitRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q', d], { env: scrubGitEnv(), stdio: 'ignore' });
  return d;
}

// A child whose argv0 is `git push origin master:shiplane` (bash `exec -a`) and whose cwd is `cwd`.
async function fakePush(cwd) {
  const c = spawn('bash', ['-c', 'exec -a "git push origin master:shiplane" sleep 30'], { cwd, stdio: 'ignore' });
  children.push(c);
  await new Promise((r) => setTimeout(r, 300));
  return c;
}

test('lockCheck: a deploy push running in the same repo is refused', { skip: !posix }, async () => {
  const repo = gitRepo();
  const c = await fakePush(repo);
  const reason = lockCheck(repo, { cmd: 'git push origin master:shiplane', env: {}, branches: BR });
  assert.match(reason, /DEPLOY LOCK/);
  assert.match(reason, new RegExp(`pid ${c.pid}`));
  assert.match(reason, /DEPLOY_LOCK=skip/);
  c.kill();
});

test('lockCheck: DEPLOY_LOCK=skip (inline or env) passes', { skip: !posix }, async () => {
  const repo = gitRepo();
  await fakePush(repo);
  assert.equal(lockCheck(repo, { cmd: 'DEPLOY_LOCK=skip git push origin master:shiplane', env: {}, branches: BR }), null);
  assert.equal(lockCheck(repo, { cmd: 'git push origin master:shiplane', env: { DEPLOY_LOCK: 'skip' }, branches: BR }), null);
});

test('lockCheck: a push running in a different repo does not lock this one', { skip: !posix }, async () => {
  const mine = gitRepo();
  const other = gitRepo();
  await fakePush(other);
  assert.equal(lockCheck(mine, { cmd: 'git push origin master:shiplane', env: {}, branches: BR }), null);
});

test('lockCheck: no branches configured, or not a repo, never throws or locks', () => {
  assert.equal(lockCheck(os.tmpdir(), { cmd: 'git push', env: {}, branches: [] }), null);
  assert.equal(lockCheck('/definitely/not/here', { cmd: 'git push', env: {}, branches: BR }), null);
});
