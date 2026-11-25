import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pullDecision, processRepo, freshnessLine, parsePorcelain, staleDocsLine, classifyPullFailure,
  pullFailureLine, expectedNodeMajor, nodeWarning, collectStatusLines, buildNote, shellExec,
} from '../core/.claude/hooks/session-context.mjs';
import { loadConfig } from '../core/scripts/lib/config.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', '.claude', 'hooks', 'session-context.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
// Merged config exactly as the hooks see it (defaults + project file), via loadConfig.
function cfg(over) {
  const d = tmp('sc-cfg-');
  try {
    fs.writeFileSync(path.join(d, 'agent-scaffold.config.json'), JSON.stringify(over));
    return loadConfig(d).config;
  } finally {
    rm(d);
  }
}

// ---- pull decisions -------------------------------------------------------------------------------
test('pullDecision: dirty, wrong branch, diverged, ok', () => {
  const base = { branch: 'main', allowedBranches: ['main'], dirty: false, ffPossible: true };
  assert.equal(pullDecision(base).pull, true);
  assert.match(pullDecision({ ...base, dirty: true }).reason, /dirty/);
  assert.match(pullDecision({ ...base, branch: 'feat' }).reason, /feat/);
  assert.match(pullDecision({ ...base, ffPossible: false }).reason, /diverged/);
});

// fake git: answers by the first git subcommand; a value of Error throws.
function fakeGit(answers, calls = []) {
  return async (args) => {
    calls.push(args.join(' '));
    const key = args[0] === 'rev-parse' ? 'branch' : args[0];
    const v = answers[key];
    if (v instanceof Error) throw v;
    return v ?? '';
  };
}

test('processRepo: current / pulled / manual (dirty, branch) / error / detached', async () => {
  const calls = [];
  assert.equal((await processRepo({ name: 'a', git: fakeGit({ branch: 'main\n', 'rev-list': '0\n' }, calls) })).status, 'current');
  const pulled = await processRepo({
    name: 'a', deployBranches: ['prod'],
    git: fakeGit({ branch: 'prod\n', 'rev-list': '3\n', status: '', 'symbolic-ref': 'origin/main\n' }, calls),
  });
  assert.equal(pulled.status, 'pulled');
  assert.equal(pulled.behind, 3);
  assert.ok(calls.some((c) => c.startsWith('pull --ff-only')));

  const dirty = await processRepo({ name: 'a', git: fakeGit({ branch: 'main\n', 'rev-list': '1\n', status: ' M x\n' }) });
  assert.equal(dirty.status, 'manual');
  assert.match(dirty.reason, /dirty/);

  const wrongBranch = await processRepo({ name: 'a', git: fakeGit({ branch: 'feat\n', 'rev-list': '1\n', 'symbolic-ref': 'origin/main\n' }) });
  assert.equal(wrongBranch.status, 'manual');

  const noFf = await processRepo({ name: 'a', git: fakeGit({ branch: 'main\n', 'rev-list': '1\n', 'merge-base': new Error('x'), 'symbolic-ref': 'origin/main\n' }) });
  assert.equal(noFf.status, 'manual');

  const off = await processRepo({ name: 'a', autoPull: false, git: fakeGit({ branch: 'main\n', 'rev-list': '2\n' }) });
  assert.equal(off.status, 'manual');

  assert.equal((await processRepo({ name: 'a', git: fakeGit({ branch: new Error('boom') }) })).status, 'error');
  assert.equal((await processRepo({ name: 'a', git: fakeGit({ branch: 'HEAD\n' }) })).status, 'current');
});

test('freshnessLine variants', () => {
  assert.match(freshnessLine([{ name: 'a', status: 'current' }]), /all up to date/);
  assert.match(freshnessLine([{ name: 'a', status: 'error' }]), /FAILED/);
  assert.match(freshnessLine([{ name: 'a', status: 'pulled', behind: 2 }]), /UPDATED: a 2 commit/);
  assert.match(freshnessLine([{ name: 'a', status: 'manual', reason: 'dirty' }, { name: 'b', status: 'error' }]), /BEHIND \(manual\): a - dirty.*1 repo/);
});

// ---- pull failure diagnosis -----------------------------------------------------------------------
test('classifyPullFailure and pullFailureLine: diverged, dirty, network, other', () => {
  assert.equal(classifyPullFailure({ ahead: 2, behind: 1 }), 'diverged');
  assert.equal(classifyPullFailure({ reason: 'fatal: Not possible to fast-forward, aborting.' }), 'diverged');
  assert.equal(classifyPullFailure({ reason: 'error: Your local changes would be overwritten' }), 'dirty');
  assert.equal(classifyPullFailure({ reason: 'ssh: Could not resolve hostname' }), 'network');
  assert.equal(classifyPullFailure({ reason: 'weird' }), 'other');

  const div = pullFailureLine({ branch: 'main', ahead: 2, behind: 5, unique: 1, firstDate: '2026-01-02' });
  assert.match(div, /^PULL DIVERGED/);
  assert.match(div, /git switch -C main origin\/main/);
  assert.match(div, /oldest 2026-01-02/);
  assert.match(pullFailureLine({ reason: 'local changes' }), /uncommitted local changes/);
  assert.match(pullFailureLine({ reason: 'timed out' }), /remote unreachable/);
  assert.match(pullFailureLine({ reason: 'weird' }), /pull FAILED/);
  // A project with no remote / no upstream has nothing to pull: that is not a failure to report at every start.
  assert.equal(classifyPullFailure({ reason: 'There is no tracking information for the current branch.' }), 'no-upstream');
  assert.equal(pullFailureLine({ reason: 'There is no tracking information for the current branch.' }), '');
  assert.equal(pullFailureLine({ reason: 'fatal: No remote repository specified.' }), '');
});

// ---- node major -----------------------------------------------------------------------------------
test('expectedNodeMajor and nodeWarning', () => {
  const d = tmp('sc-node-');
  try {
    assert.equal(expectedNodeMajor(d), null);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ engines: { node: '>=18' } }));
    assert.equal(expectedNodeMajor(d), null);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ engines: { node: '20' } }));
    assert.deepEqual(expectedNodeMajor(d), { major: 20, source: 'package.json engines.node' });
    fs.writeFileSync(path.join(d, '.nvmrc'), 'v22.4.0\n');
    assert.deepEqual(expectedNodeMajor(d), { major: 22, source: '.nvmrc' });
  } finally {
    rm(d);
  }
  assert.equal(nodeWarning('v22.1.0', { major: 22, source: '.nvmrc' }), '');
  assert.match(nodeWarning('v18.2.0', { major: 22, source: '.nvmrc' }), /Node v18\.2.*major 22/);
  assert.equal(nodeWarning('v18.2.0', null), '');
});

// ---- stale docs -----------------------------------------------------------------------------------
test('parsePorcelain keeps only untracked and modified', () => {
  assert.deepEqual(parsePorcelain('?? a.md\n M b.md\nA  c.md\nD  d.md\n', 'sub/'), ['sub/a.md', 'sub/b.md']);
});

test('staleDocsLine: threshold, +N files, length bound', () => {
  const now = Date.now();
  const h = 3_600_000;
  assert.equal(staleDocsLine([{ path: 'a.md', mtimeMs: now - 2 * h }], now, 24), '');
  assert.match(staleDocsLine([{ path: 'a.md', mtimeMs: now - 50 * h }], now, 24), /^UNCOMMITTED DOCS \(>24h\): a\.md \(2d\)/);
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `docs/long-name-${i}.md`, mtimeMs: now - (30 + i) * h }));
  const line = staleDocsLine(many, now, 24);
  assert.match(line, /\+\d+ files/);
  assert.ok(line.length <= 260, `line too long: ${line.length}`);
  const huge = staleDocsLine([{ path: 'x/'.repeat(200) + 'f.md', mtimeMs: now - 50 * h }], now, 24);
  assert.ok(huge.length <= 260);
});

// ---- status lines ---------------------------------------------------------------------------------
test('collectStatusLines: order kept, empty/throwing/missing-script skipped, first non-empty line only', async () => {
  const started = [];
  const exec = async (command) => {
    started.push(command);
    if (command === 'boom') throw new Error('timeout');
    if (command === 'empty') return '\n  \n';
    return command === 'multi' ? '\nfirst\nsecond\n' : 'ok';
  };
  const out = await collectStatusLines({
    root: '/x',
    lines: [
      { id: 'a', command: 'multi' },
      { id: 'b', command: 'boom' },
      { id: 'c', command: 'empty' },
      { id: 'd', command: 'node scripts/missing.mjs --line' },
      { id: 'e', command: 'node scripts/present.mjs' },
      { id: 'f', command: 'other' },
      { command: 'no id' },
    ],
    exec,
    exists: (p) => p.endsWith('present.mjs'),
  });
  assert.deepEqual(out, ['first', 'ok', 'ok']); // printed as-is: scripts carry their own label
  assert.ok(!started.some((c) => c.includes('missing.mjs')), 'missing script must never be started');
});

test('collectStatusLines: per-line timeout is capped by the shared budget; exhausted budget skips lines', async () => {
  const seen = [];
  const exec = async (_c, { timeout }) => { seen.push(timeout); return 'x'; };
  await collectStatusLines({ root: '/x', lines: [{ id: 'a', command: 'c', timeoutMs: 50_000 }, { id: 'b', command: 'c' }], exec, budgetMs: 10_000 });
  assert.deepEqual(seen, [10_000, 8000]);
  let t = 0;
  const out = await collectStatusLines({ root: '/x', lines: [{ id: 'a', command: 'c' }], exec, budgetMs: 0, now: () => t });
  assert.deepEqual(out, []);
});

test('shellExec: returns stdout, rejects on timeout', async () => {
  const ok = await shellExec(`${JSON.stringify(process.execPath)} -e "console.log('hi')"`, { cwd: os.tmpdir(), timeout: 5000 });
  assert.equal(ok.trim(), 'hi');
  await assert.rejects(shellExec(`${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},10000)"`, { cwd: os.tmpdir(), timeout: 300 }));
});

// ---- note -----------------------------------------------------------------------------------------
test('buildNote: roles, claim rule, handoff skill and decision authority come from config', () => {
  const config = cfg({
    projectName: 'Demo',
    humanGatekeeper: 'Alice',
    humans: ['Alice', 'Bob'],
    delegation: { subagents: { scout: 'looker' } },
    session: { skills: ['deploy'], context: { handoffSkill: 'wrapup' } },
  });
  const note = buildNote({ config, statusLines: ['size: big'], pullLine: 'PULL', hasCoordination: true, hasBoard: true });
  assert.match(note, /^Demo session note:\nsize: big\nPULL/);
  assert.match(note, /'looker'/);
  assert.match(note, /\/deploy/);
  assert.match(note, /A claim is ONE row/);
  assert.match(note, /\/wrapup/);
  assert.match(note, /need Alice to approve/);
  assert.match(note, /Humans who instruct agents: Alice, Bob/);
  const bare = buildNote({ config: cfg({ session: { skills: [] } }) });
  assert.doesNotMatch(bare, /^3\) /m);
  assert.doesNotMatch(bare, /^5\) /m);
  assert.doesNotMatch(bare, /^6\) /m);
});

// ---- end to end -----------------------------------------------------------------------------------
function runHook(cwd, stdin, via = HOOK) {
  return spawnSync(process.execPath, [via], { input: JSON.stringify(stdin), encoding: 'utf8', env: scrubGitEnv(), timeout: 30000 });
}

function fixtureProject(extraConfig = {}) {
  const dir = tmp('sc-e2e-');
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, env: scrubGitEnv(), encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({
    projectName: 'Fixture',
    session: { autoPull: false, lines: [{ id: 'probe', command: `${JSON.stringify(process.execPath)} -e "console.log('alive')"` }] },
    ...extraConfig,
  }));
  fs.writeFileSync(path.join(dir, '.nvmrc'), '1\n');
  fs.writeFileSync(path.join(dir, 'GOREV.md'), '# board\n');
  return dir;
}

test('end to end: hook prints SessionStart JSON with the configured line and a node warning', () => {
  const dir = fixtureProject();
  try {
    const r = runHook(dir, { cwd: dir, session_id: 'sess-1' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const note = out.hookSpecificOutput.additionalContext;
    assert.match(note, /^Fixture session note:\nalive\n/);
    assert.match(note, /NODE WARNING: .*expects major 1 \(\.nvmrc\)/);
    assert.match(fs.readFileSync(path.join(dir, '.claude', '.read-guard', 'mains.txt'), 'utf8'), /^sess-1 \d+/);
  } finally {
    rm(dir);
  }
});

test('end to end: no config means silence (fail open)', () => {
  const dir = tmp('sc-none-');
  try {
    const r = runHook(dir, { cwd: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    rm(dir);
  }
});

test('end to end: runs when the hook is invoked through a symlinked path', (t) => {
  const dir = fixtureProject();
  const linkDir = tmp('sc-link-');
  try {
    const link = path.join(linkDir, 'hook-link.mjs');
    try {
      fs.symlinkSync(HOOK, link);
    } catch {
      t.skip('symlinks unavailable');
      return;
    }
    const r = spawnSync(process.execPath, [link], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: scrubGitEnv(), timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Fixture session note:/);
  } finally {
    rm(dir);
    rm(linkDir);
  }
});
