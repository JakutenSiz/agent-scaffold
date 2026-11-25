// Shared fixture for the git-hygiene tests: a throwaway repository with a local bare "origin"
// and one branch/worktree per scenario. Not a test file (no .test.mjs suffix).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { loadConfig } from '../core/scripts/lib/config.mjs';

export const OLD = '2020-01-01T00:00:00Z';

export function git(cwd, args, env = {}) {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Tester', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...scrubGitEnv(), ...env },
  }).trim();
}

export function commit(cwd, file, date) {
  fs.writeFileSync(path.join(cwd, file), `${file} ${date}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-m', `add ${file}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/** Set the mtime of the worktree's private git dir files far in the past. */
export function ageWorktree(wt) {
  const gd = git(wt, ['rev-parse', '--absolute-git-dir']);
  const old = new Date(OLD);
  for (const f of ['HEAD', 'index', path.join('logs', 'HEAD')]) {
    try { fs.utimesSync(path.join(gd, f), old, old); } catch {}
  }
}

export function writeConfig(root, extra = {}) {
  const cfg = { version: 2, projectName: 'proj', repos: [{ name: 'app', path: '.', deployBranches: ['deploy'] }], ...extra };
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(cfg, null, 2));
  return loadConfig(root).config; // merged with DEFAULTS, as the scripts see it
}

/**
 * Scenario repo:
 *  branches: merged-old (candidate), deployed (merged only through origin/deploy, candidate),
 *            unmerged-old, fresh-merged, ignored-merged, co-branch (checked out in a dirty worktree)
 *  worktrees: wt-clean (candidate), wt-dirty (on co-branch), wt-ref (md reference), wt-fresh, wt-unmerged
 */
export function makeFixture(configExtra = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-')));
  const origin = path.join(tmp, 'origin.git');
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  git(tmp, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['init', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', origin]);
  commit(root, 'base.txt', OLD);
  git(root, ['push', 'origin', 'main']);
  git(root, ['remote', 'set-head', 'origin', 'main']);
  for (const b of ['merged-old', 'ignored-merged', 'co-branch']) git(root, ['branch', b]);

  // deployed: a commit that reaches origin/deploy but never origin/main
  git(root, ['checkout', '-b', 'deployed']);
  commit(root, 'deployed.txt', OLD);
  git(root, ['push', 'origin', 'deployed:deploy']);
  git(root, ['checkout', '-b', 'unmerged-old', 'main']);
  commit(root, 'unmerged.txt', OLD);
  git(root, ['checkout', 'main']);
  commit(root, 'fresh.txt', new Date().toISOString());
  git(root, ['branch', 'fresh-merged']);
  git(root, ['push', 'origin', 'main']);

  const wt = (name, ref, extra = []) => {
    const dir = path.join(tmp, name);
    git(root, ['worktree', 'add', ...extra, dir, ref]);
    return dir;
  };
  const clean = wt('wt-clean', 'merged-old', ['--detach']);
  const dirty = wt('wt-dirty', 'co-branch');
  fs.writeFileSync(path.join(dirty, 'scratch.txt'), 'uncommitted\n');
  const ref = wt('wt-ref', 'merged-old', ['--detach']);
  const fresh = wt('wt-fresh', 'merged-old', ['--detach']);
  const unmerged = wt('wt-unmerged', 'unmerged-old', ['--detach']);
  for (const d of [clean, dirty, ref, unmerged]) ageWorktree(d);

  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', 'notes.md'), `Experiment lives in ${ref} until Friday.\n`);
  const config = writeConfig(root, configExtra);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'git-hygiene-ignore.json'), JSON.stringify([{ repo: 'app', branch: 'ignored-merged', reason: 'kept on purpose', date: '2026-01-01' }]));
  return { tmp, root, config, worktrees: { clean, dirty, ref, fresh, unmerged }, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export function branchNames(root) {
  return git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort();
}

export function worktreePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).sort();
}
