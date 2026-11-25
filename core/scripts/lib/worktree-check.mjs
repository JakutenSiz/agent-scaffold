// Enforces: R-43
// Two small git helpers shared by the push gates.
//
// scrubGitEnv(): git hooks run with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE set. A child
// process that inherits them (a test suite creating fixture repos, another `git -C`) acts
// on the WRONG repository. Measured: a pre-push hook ran the test suite with GIT_DIR
// inherited, the fixtures committed into the real repo, and over a hundred fixture commits
// reached the default branch. Every git call and every child command started from a hook
// goes through this.
//
// assertWorktree(root, sha): a gate result only proves something about the commit being
// pushed when the checked tree IS that commit: HEAD equals the pushed sha and nothing is
// modified or untracked. Otherwise "green" describes a different tree.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const GIT_ENV = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i;

export function scrubGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_ENV.test(key)));
}

function git(root, args) {
  const abs = path.resolve(root);
  return execFileSync('git', ['-c', `safe.directory=${abs.replaceAll('\\', '/')}`, '-C', abs, ...args], {
    env: scrubGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true,
  }).trim();
}

/** Throws unless HEAD of `root` is `sha` and the tree is clean. Returns { sha, repo }. */
export function assertWorktree(root, sha) {
  const target = git(root, ['rev-parse', '--verify', `${sha}^{commit}`]);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head !== target) {
    throw new Error(`SHA mismatch: HEAD is ${head.slice(0, 12)}, the push carries ${target.slice(0, 12)}. Check the pushed commit in a clean worktree (git worktree add --detach <dir> ${target.slice(0, 12)}).`);
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])) {
    throw new Error('No SHA proof: the working tree differs from the commit (modified or untracked files). Commit them, or check the pushed commit in a clean worktree.');
  }
  return { sha: target, repo: path.resolve(abs(root), git(root, ['rev-parse', '--git-common-dir'])).replaceAll('\\', '/') };
}

function abs(root) { return path.resolve(root); }
