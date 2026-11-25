// Tests for core/scripts/git-hygiene-clean.mjs (Enforces: R-32) against real throwaway repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runClean } from '../core/scripts/git-hygiene-clean.mjs';
import { discoverRepos, isEquivalentMerged } from '../core/scripts/lib/git-hygiene-common.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { makeFixture, branchNames, worktreePaths, git, addCleanWorktree, writeFile, addEquivalentScenarios } from './_git-hygiene-fixture.mjs';

const CLI = path.resolve('core/scripts/git-hygiene-clean.mjs');
const opts = (fx, extra = {}) => ({ root: fx.root, config: fx.config, cwds: [fx.root], ...extra });

test('dry run lists candidates and changes nothing', () => {
  const fx = makeFixture();
  try {
    const before = [branchNames(fx.root), worktreePaths(fx.root)];
    const r = runClean(opts(fx));
    assert.equal(r.mode, 'dry-run');
    assert.deepEqual(r.candidates.branches.map((b) => b.branch).sort(), ['deployed', 'merged-old']);
    assert.deepEqual(r.candidates.worktrees.map((w) => w.path), [fx.worktrees.clean]);
    assert.deepEqual([branchNames(fx.root), worktreePaths(fx.root)], before);
    assert.equal(fs.existsSync(path.join(fx.root, '.claude', '.git-hygiene-clean.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('keeps unmerged, fresh, checked-out and ignored branches with a reason', () => {
  const fx = makeFixture();
  try {
    const r = runClean(opts(fx));
    const why = (name) => r.kept.find((k) => k.kind === 'branch' && k.name === name)?.reason ?? '';
    assert.match(why('unmerged-old'), /unmerged/);
    assert.match(why('fresh-merged'), /fresh/);
    assert.match(why('co-branch'), /checked out/);
    assert.match(why('ignored-merged'), /ignore file/);
    assert.equal(r.kept.some((k) => k.name === 'main'), false, 'protected names stay silent');
  } finally { fx.cleanup(); }
});

test('keeps dirty, referenced, fresh and unmerged worktrees with a reason', () => {
  const fx = makeFixture();
  try {
    const r = runClean(opts(fx));
    const why = (p) => r.kept.find((k) => k.kind === 'worktree' && k.name === p)?.reason ?? '';
    assert.match(why(fx.worktrees.dirty), /dirty/);
    assert.match(why(fx.worktrees.ref), /referenced in coordination\.md:1/);
    assert.match(why(fx.worktrees.fresh), /fresh/);
    assert.match(why(fx.worktrees.unmerged), /unmerged/);
  } finally { fx.cleanup(); }
});

test('a worktree is kept while the current directory is inside it', () => {
  const fx = makeFixture();
  try {
    const r = runClean(opts(fx, { cwds: [path.join(fx.worktrees.clean)] }));
    assert.equal(r.candidates.worktrees.length, 0);
    assert.match(r.kept.find((k) => k.name === fx.worktrees.clean).reason, /current directory/);
  } finally { fx.cleanup(); }
});

test('a locked worktree is kept', () => {
  const fx = makeFixture();
  try {
    git(fx.root, ['worktree', 'lock', fx.worktrees.clean]);
    const r = runClean(opts(fx));
    assert.equal(r.candidates.worktrees.length, 0);
    assert.match(r.kept.find((k) => k.name === fx.worktrees.clean).reason, /locked/);
  } finally { fx.cleanup(); }
});

test('write mode deletes merged+old branches and the clean worktree, logs recovery data', () => {
  const fx = makeFixture();
  try {
    const tip = git(fx.root, ['rev-parse', 'merged-old']);
    const r = runClean(opts(fx, { write: true }));
    assert.equal(r.mode, 'write');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(branchNames(fx.root), ['co-branch', 'fresh-merged', 'ignored-merged', 'main', 'unmerged-old']);
    assert.equal(fs.existsSync(fx.worktrees.clean), false);
    for (const keepDir of [fx.worktrees.dirty, fx.worktrees.ref, fx.worktrees.fresh, fx.worktrees.unmerged]) assert.equal(fs.existsSync(keepDir), true);
    const lines = fs.readFileSync(path.join(fx.root, '.claude', '.git-hygiene-clean.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.kind === 'branch' && l.name === 'merged-old');
    assert.equal(entry.sha, tip);
    assert.equal(entry.repo, 'app');
    assert.ok(entry.ts);
    assert.ok(lines.some((l) => l.kind === 'worktree' && l.path === fx.worktrees.clean));
    // the logged sha brings the branch back
    git(fx.root, ['branch', entry.name, entry.sha]);
    assert.ok(branchNames(fx.root).includes('merged-old'));
  } finally { fx.cleanup(); }
});

test('a branch reachable only from a deploy branch counts as merged', () => {
  const fx = makeFixture();
  try {
    const r = runClean(opts(fx));
    assert.ok(r.candidates.branches.some((b) => b.branch === 'deployed'));
    const noDeploy = { ...fx.config, repos: [{ name: 'app', path: '.', deployBranches: [] }] };
    const r2 = runClean(opts(fx, { config: noDeploy }));
    assert.ok(!r2.candidates.branches.some((b) => b.branch === 'deployed'));
  } finally { fx.cleanup(); }
});

test('protectedBranches config keeps an otherwise deletable branch', () => {
  const fx = makeFixture();
  try {
    const cfg = { ...fx.config, git: { protectedBranches: ['merged-old'] } };
    const r = runClean(opts(fx, { config: cfg }));
    assert.ok(!r.candidates.branches.some((b) => b.branch === 'merged-old'));
  } finally { fx.cleanup(); }
});

test('threshold from config: a huge branchMinAgeHours keeps every branch', () => {
  const fx = makeFixture();
  try {
    const cfg = { ...fx.config, git: { hygiene: { branchMinAgeHours: 1000000 } } };
    const r = runClean(opts(fx, { config: cfg }));
    assert.equal(r.candidates.branches.length, 0);
  } finally { fx.cleanup(); }
});

test('a corrupt ignore file fails closed: write mode deletes nothing', () => {
  const fx = makeFixture();
  try {
    fs.writeFileSync(path.join(fx.root, 'scripts', 'git-hygiene-ignore.json'), '{not json');
    const before = branchNames(fx.root);
    const r = runClean(opts(fx, { write: true }));
    assert.equal(r.mode, 'dry-run');
    assert.deepEqual(branchNames(fx.root), before);
    assert.ok(r.errors.some((e) => /ignore file unreadable/.test(e)));
  } finally { fx.cleanup(); }
});

test('the shipped ignore file shape ({ $comment, entries }) is accepted', () => {
  const fx = makeFixture();
  try {
    const shipped = JSON.parse(fs.readFileSync(path.resolve('core/scripts/git-hygiene-ignore.json'), 'utf8'));
    shipped.entries = [{ repo: 'app', branch: 'merged-old', reason: 'x', date: '2026-01-01' }];
    fs.writeFileSync(path.join(fx.root, 'scripts', 'git-hygiene-ignore.json'), JSON.stringify(shipped));
    const r = runClean(opts(fx));
    assert.ok(!r.candidates.branches.some((b) => b.branch === 'merged-old'));
  } finally { fx.cleanup(); }
});

test('repos that are not git repositories are skipped, shared git dirs collapse', () => {
  const fx = makeFixture();
  try {
    fs.mkdirSync(path.join(fx.root, 'packages', 'a'), { recursive: true });
    fs.mkdirSync(path.join(fx.tmp, 'plain'));
    const cfg = { ...fx.config, repos: [{ name: 'app', path: '.', deployBranches: ['deploy'] }, { name: 'pkg-a', path: 'packages/a', deployBranches: ['extra'] }, { name: 'plain', path: '../plain' }, { name: 'ghost', path: 'nowhere' }] };
    const repos = discoverRepos(fx.root, cfg);
    assert.equal(repos.length, 1);
    assert.deepEqual(repos[0].deployBranches.sort(), ['deploy', 'extra']);
  } finally { fx.cleanup(); }
});

test('--json prints one object with branches and worktrees and deletes nothing', () => {
  const fx = makeFixture();
  try {
    const before = branchNames(fx.root);
    const out = execFileSync('node', [CLI, '--json'], { cwd: fx.root, encoding: 'utf8', env: scrubGitEnv() });
    const parsed = JSON.parse(out);
    assert.deepEqual(Object.keys(parsed).sort(), ['branches', 'worktrees']);
    assert.deepEqual(parsed.branches.map((b) => b.branch).sort(), ['deployed', 'merged-old']);
    assert.match(parsed.branches[0].sha, /^[0-9a-f]{40}$/);
    assert.equal(parsed.branches[0].repo, 'app');
    assert.deepEqual(parsed.worktrees.map((w) => w.path), [fx.worktrees.clean]);
    assert.deepEqual(branchNames(fx.root), before);
  } finally { fx.cleanup(); }
});

test('--write via the CLI removes the candidates', () => {
  const fx = makeFixture();
  try {
    execFileSync('node', [CLI, '--write'], { cwd: fx.root, encoding: 'utf8', env: scrubGitEnv() });
    assert.ok(!branchNames(fx.root).includes('merged-old'));
    assert.ok(!worktreePaths(fx.root).includes(fx.worktrees.clean));
  } finally { fx.cleanup(); }
});

test('--help documents the recovery command', () => {
  const out = execFileSync('node', [CLI, '--help'], { encoding: 'utf8', env: scrubGitEnv() });
  assert.match(out, /git branch <name> <sha>/);
});

test('only live signals hold a worktree: closed board item, spec, report and memory bank do not', () => {
  const fx = makeFixture();
  try {
    const closed = addCleanWorktree(fx, 'wt-closed-item');
    const spec = addCleanWorktree(fx, 'wt-in-spec');
    const report = addCleanWorktree(fx, 'wt-in-report');
    const bank = addCleanWorktree(fx, 'wt-in-bank');
    const archived = addCleanWorktree(fx, 'wt-in-archive');
    writeFile(fx.root, 'task-board.md', `# Board\n\n### T-1 \u2705 Old job\n**Remaining:** none, lived in ${closed}\n`);
    writeFile(fx.root, 'task-board-archive.md', `# Archive\n\nlived in ${archived}\n`);
    writeFile(fx.root, 'specs/a.md', `see ${spec}\n`);
    writeFile(fx.root, 'reports/r.md', `see ${report}\n`);
    writeFile(fx.root, 'memory-bank/activeContext.md', `see ${bank}\n`);
    const r = runClean(opts(fx));
    const paths = r.candidates.worktrees.map((w) => w.path);
    for (const p of [closed, spec, report, bank, archived]) assert.ok(paths.includes(p), `${p} should be a candidate`);
    assert.ok(!paths.includes(fx.worktrees.ref), 'coordination reference still holds');
  } finally { fx.cleanup(); }
});

test('an OPEN board item holds a worktree; a name prefix does not match', () => {
  const fx = makeFixture();
  try {
    const open = addCleanWorktree(fx, 'wt-open-item');
    const prefix = addCleanWorktree(fx, 'wt-open');
    writeFile(fx.root, 'task-board.md', `# Board\n\n### T-2 \u{1F534} Live job\n**Remaining:** finish in ${open}\n`);
    const r = runClean(opts(fx));
    const paths = r.candidates.worktrees.map((w) => w.path);
    assert.ok(!paths.includes(open));
    assert.match(r.kept.find((k) => k.name === open).reason, /referenced in task-board\.md:4/);
    assert.ok(paths.includes(prefix), 'wt-open must not be held by wt-open-item');
  } finally { fx.cleanup(); }
});

// --- equivalent merges (squash / cherry-pick), opt-in via git.hygiene.equivalentMerge ---
const withMode = (fx, mode) => ({ ...fx.config, git: { hygiene: { equivalentMerge: mode } } });
const EQUIV = ['picked', 'sq-merged'];

test('equivalentMerge cherry: a squash-merged branch is a candidate, with via=squash; off keeps it', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    const off = runClean(opts(fx));
    assert.ok(!off.candidates.branches.some((b) => b.branch === 'sq-merged'));
    assert.match(off.kept.find((k) => k.name === 'sq-merged').reason, /unmerged/);
    const on = runClean(opts(fx, { config: withMode(fx, 'cherry') }));
    const sq = on.candidates.branches.find((b) => b.branch === 'sq-merged');
    assert.ok(sq);
    assert.equal(sq.via, 'squash');
    assert.equal(on.candidates.branches.find((b) => b.branch === 'merged-old').via, 'ancestor');
  } finally { fx.cleanup(); }
});

test('equivalentMerge cherry: a cherry-picked series is a candidate (via=cherry)', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    assert.ok(!runClean(opts(fx)).candidates.branches.some((b) => b.branch === 'picked'));
    const on = runClean(opts(fx, { config: withMode(fx, 'cherry') }));
    assert.equal(on.candidates.branches.find((b) => b.branch === 'picked')?.via, 'cherry');
  } finally { fx.cleanup(); }
});

test('equivalentMerge cherry: a never-merged branch and an orphan branch stay', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    const on = runClean(opts(fx, { config: withMode(fx, 'cherry') }));
    for (const name of ['never', 'orphan']) {
      assert.ok(!on.candidates.branches.some((b) => b.branch === name), name);
      assert.match(on.kept.find((k) => k.name === name).reason, /unmerged/);
    }
  } finally { fx.cleanup(); }
});

test('equivalentMerge cherry: a commit added after the squash keeps the branch', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    const on = runClean(opts(fx, { config: withMode(fx, 'cherry') }));
    assert.ok(!on.candidates.branches.some((b) => b.branch === 'sq-extra'));
    assert.match(on.kept.find((k) => k.name === 'sq-extra').reason, /unmerged/);
  } finally { fx.cleanup(); }
});

test('equivalentMerge cherry: a worktree at a squash-merged HEAD is a candidate; dirty and fresh gates stay', () => {
  const fx = makeFixture();
  try {
    const w = addEquivalentScenarios(fx);
    assert.ok(!runClean(opts(fx)).candidates.worktrees.some((x) => x.path === w.sq));
    const on = runClean(opts(fx, { config: withMode(fx, 'cherry') }));
    assert.equal(on.candidates.worktrees.find((x) => x.path === w.sq)?.via, 'squash');
    assert.ok(!on.candidates.worktrees.some((x) => x.path === w.sqDirty || x.path === w.sqFresh));
    assert.match(on.kept.find((k) => k.name === w.sqDirty).reason, /dirty/);
    assert.match(on.kept.find((k) => k.name === w.sqFresh).reason, /fresh/);
  } finally { fx.cleanup(); }
});

test('equivalentMerge cherry: write mode deletes equivalents and journals via + sha; no ref is written', () => {
  const fx = makeFixture();
  try {
    const w = addEquivalentScenarios(fx);
    const tip = git(fx.root, ['rev-parse', 'sq-merged']);
    const refsBefore = git(fx.root, ['for-each-ref', '--format=%(refname)']).split('\n').sort();
    const r = runClean(opts(fx, { write: true, config: withMode(fx, 'cherry') }));
    assert.deepEqual(r.errors, []);
    const names = branchNames(fx.root);
    for (const b of EQUIV) assert.ok(!names.includes(b), b);
    for (const b of ['never', 'orphan', 'sq-extra']) assert.ok(names.includes(b), b);
    assert.equal(fs.existsSync(w.sq), false);
    const lines = fs.readFileSync(path.join(fx.root, '.claude', '.git-hygiene-clean.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.kind === 'branch' && l.name === 'sq-merged');
    assert.equal(entry.via, 'squash');
    assert.equal(entry.sha, tip);
    assert.equal(lines.find((l) => l.kind === 'branch' && l.name === 'picked').via, 'cherry');
    assert.equal(lines.find((l) => l.kind === 'worktree' && l.path === w.sq).via, 'squash');
    assert.equal(lines.find((l) => l.kind === 'branch' && l.name === 'merged-old').via, 'ancestor');
    // only the deleted refs differ: the temporary commit object of the squash probe left no ref
    const refsAfter = git(fx.root, ['for-each-ref', '--format=%(refname)']).split('\n').sort();
    const gone = new Set(['refs/heads/sq-merged', 'refs/heads/picked', 'refs/heads/merged-old', 'refs/heads/deployed']);
    assert.deepEqual(refsAfter, refsBefore.filter((x) => !gone.has(x)));
  } finally { fx.cleanup(); }
});

test('dry-run report prints via and the short sha', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    const cfg = withMode(fx, 'cherry');
    fs.writeFileSync(path.join(fx.root, 'agent-scaffold.config.json'), JSON.stringify({ version: 2, projectName: 'proj', repos: [{ name: 'app', path: '.', deployBranches: ['deploy'] }], git: cfg.git }));
    const out = execFileSync('node', [CLI, '--root', fx.root], { encoding: 'utf8', env: scrubGitEnv() });
    const tip = git(fx.root, ['rev-parse', '--short=7', 'sq-merged']);
    assert.match(out, new RegExp(`DELETE  branch .*sq-merged  ${tip} \\(squash\\)`));
    assert.match(out, /merged-old .*\(ancestor\)/);
  } finally { fx.cleanup(); }
});

test('isEquivalentMerged: no merge-base, bad sha or no refs all answer false', () => {
  const fx = makeFixture();
  try {
    addEquivalentScenarios(fx);
    const ref = 'refs/remotes/origin/main';
    const sha = (b) => git(fx.root, ['rev-parse', b]);
    assert.equal(isEquivalentMerged(fx.root, sha('sq-merged'), [ref]), 'squash');
    assert.equal(isEquivalentMerged(fx.root, sha('picked'), [ref]), 'cherry');
    assert.equal(isEquivalentMerged(fx.root, sha('orphan'), [ref]), false);
    assert.equal(isEquivalentMerged(fx.root, sha('never'), [ref]), false);
    assert.equal(isEquivalentMerged(fx.root, sha('sq-merged'), []), false);
    assert.equal(isEquivalentMerged(fx.root, '0'.repeat(40), [ref]), false);
    assert.equal(isEquivalentMerged(fx.root, sha('sq-merged'), ['refs/remotes/origin/nope']), false);
  } finally { fx.cleanup(); }
});
