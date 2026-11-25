#!/usr/bin/env node
// Enforces: R-32
// Lossless cleanup of merged local branches and finished worktrees.
//
// WHY: "delete your branch and worktree when the work is done" never held as advice: in one
// week seventeen merged worktrees (11 GB) and thirty-four merged branches had to be removed by
// hand, after an earlier pile of 156 branches and months-old dead worktrees. The post-condition
// is now a script that runs at a deterministic moment. DEFAULT IS A DRY RUN.
//
// A local BRANCH is deleted <=> all of: its tip is an ancestor of origin/<default branch> or of
//   origin/<b> for any deployBranches entry (merge-base --is-ancestor; no `git cherry`) - not
//   checked out in any worktree (except worktrees removed in the same run) - not in the ignore
//   file - not a protected name (default branch, deployBranches, git.protectedBranches) - last
//   commit older than git.hygiene.branchMinAgeHours.
// A WORKTREE is removed <=> all of: clean (files under .claude/ do not count) - HEAD merged as
//   above - its private git dir (HEAD/index/logs) untouched for git.hygiene.worktreeMinAgeHours -
//   not locked - the current directory is not inside it - no live signal mentions its path: the
//   coordination file (all of it) or an OPEN board item (closed items, specs, reports, the memory
//   bank and the archives are not scanned).
// When unsure the script KEEPS: a wrong keep is cheap, a wrong delete is not.
// Remote branches are never deleted; stashes are never touched; nothing is fetched.
//
// RECOVERY: every deletion is appended to .claude/.git-hygiene-clean.jsonl as
//   {ts, repo, kind, name, sha, path}. A deleted branch comes back with `git branch <name> <sha>`
//   (run inside that repo). A removed worktree held no uncommitted work and its HEAD was merged.
//
// USAGE:
//   node scripts/git-hygiene-clean.mjs                 # dry run: what would be deleted / kept and why
//   node scripts/git-hygiene-clean.mjs --write         # delete (and `git worktree prune`)
//   node scripts/git-hygiene-clean.mjs --json          # ONE JSON object on stdout:
//                                                      #   { "branches": [...], "worktrees": [...] }
//                                                      # = deletable candidates (other hooks rely on this shape)
//   node scripts/git-hygiene-clean.mjs --repo <name|path>   # one repo only
//   Test flags: --now <epoch> --root <dir>
// Exit code is always 0 (called from hooks). Per-repo git errors go to stderr; that repo is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { scrubGitEnv } from './lib/worktree-check.mjs';
import { git, discoverRepos, loadIgnore, evaluateRepo, liveSignalFiles, dirtyCount } from './lib/git-hygiene-common.mjs';

export const LOG_FILE = path.join('.claude', '.git-hygiene-clean.jsonl');

function journal(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function run(dir, args, timeout) {
  execFileSync('git', args, { cwd: dir, env: scrubGitEnv(), stdio: 'ignore', timeout, windowsHide: true });
}

/**
 * Evaluate every repo and (when `write`) delete the candidates.
 * @param {{root:string, config:object, write?:boolean, now?:number, only?:string|null, cwds?:string[], ignorePath?:string|null, logPath?:string|null}} opts
 */
export function runClean(opts) {
  const { root, config, write = false, only = null } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cwds = opts.cwds ?? [process.cwd(), ...(process.env.PWD ? [process.env.PWD] : [])];
  const logPath = opts.logPath ?? path.join(root, LOG_FILE);
  const errors = [];
  const ignore = loadIgnore(root, config, opts.ignorePath ?? null);
  // A broken ignore file fails closed: report, delete nothing.
  const writing = write && ignore.ok;
  if (write && !ignore.ok) errors.push(`ignore file unreadable (${ignore.file}); nothing is deleted`);

  const repos = discoverRepos(root, config, { only });
  let docs = null;
  const docsLoader = () => (docs ||= liveSignalFiles(root, config));
  const result = { mode: writing ? 'write' : 'dry-run', candidates: { branches: [], worktrees: [] }, kept: [], skipped: [], removed: { branches: [], worktrees: [] }, errors };

  for (const repo of repos) {
    let ev;
    try {
      ev = evaluateRepo(repo, { root, config, now, ignore, cwds, docsLoader });
    } catch (e) {
      errors.push(`${repo.name}: skipped (${String(e?.message || '').split('\n')[0]})`);
      continue;
    }
    if (ev.skipped) {
      result.skipped.push({ repo: repo.name, reason: ev.skipped });
      continue;
    }
    result.candidates.branches.push(...ev.candidates.branches);
    result.candidates.worktrees.push(...ev.candidates.worktrees);
    result.kept.push(...ev.kept);
    if (!writing) continue;

    for (const w of ev.candidates.worktrees) {
      try {
        // Tool-cache files under .claude/ show as untracked, so removal needs --force; cleanliness was checked above.
        const raw = git(w.path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']).trim();
        if (dirtyCount(w.path) !== 0) throw new Error('became dirty');
        run(repo.path, ['worktree', 'remove', ...(raw ? ['--force'] : []), w.path], 120000);
        journal(logPath, { repo: repo.name, kind: 'worktree', name: w.branch || '(detached)', sha: w.sha, path: w.path });
        result.removed.worktrees.push(w);
      } catch (e) {
        errors.push(`${repo.name}: worktree ${w.path} not removed (${String(e.message).split('\n')[0]})`);
      }
    }
    try {
      git(repo.path, ['worktree', 'prune']);
    } catch {}
    for (const b of ev.candidates.branches) {
      try {
        run(repo.path, ['branch', '-D', b.branch], 10000);
        journal(logPath, { repo: repo.name, kind: 'branch', name: b.branch, sha: b.sha, path: repo.path });
        result.removed.branches.push(b);
      } catch (e) {
        errors.push(`${repo.name}: branch ${b.branch} not deleted (${String(e.message).split('\n')[0]})`);
      }
    }
  }
  return result;
}

function printReport(r) {
  console.log(r.mode === 'write' ? '== WRITE mode ==' : '== DRY RUN (nothing is deleted; use --write to delete) ==');
  for (const b of r.candidates.branches) console.log(`  DELETE  branch    ${b.repo}: ${b.branch}  ${b.sha.slice(0, 7)}`);
  for (const w of r.candidates.worktrees) console.log(`  REMOVE  worktree  ${w.repo}: ${w.path}  ${(w.sha || '').slice(0, 7)}`);
  for (const k of r.kept) console.log(`  KEPT    ${k.kind.padEnd(8)}  ${k.repo}: ${k.name} - ${k.reason}`);
  for (const s of r.skipped) console.log(`  SKIPPED ${s.repo}: ${s.reason}`);
  for (const b of r.removed.branches) console.log(`  DELETED branch    ${b.repo}: ${b.branch}  ${b.sha.slice(0, 7)}`);
  for (const w of r.removed.worktrees) console.log(`  REMOVED worktree  ${w.repo}: ${w.path}`);
  console.log(`\ncandidates: ${r.candidates.branches.length} branches + ${r.candidates.worktrees.length} worktrees - kept: ${r.kept.length} - removed: ${r.removed.branches.length} branches + ${r.removed.worktrees.length} worktrees`);
  if (r.removed.branches.length || r.removed.worktrees.length) console.log(`recovery: ${LOG_FILE} lists every deletion; a branch returns with: git branch <name> <sha>`);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  if (flag('--help') || flag('-h')) {
    console.log('usage: node scripts/git-hygiene-clean.mjs [--write] [--json] [--repo <name|path>]\nDry run by default. Deletions are logged to ' + LOG_FILE + '; recover a branch with: git branch <name> <sha>');
    return;
  }
  const loaded = loadConfig(value('--root', process.cwd()));
  const root = value('--root', null) ? path.resolve(value('--root')) : loaded.root;
  const r = runClean({ root, config: loaded.config, write: flag('--write'), now: value('--now', null) ? Number(value('--now')) : undefined, only: value('--repo', null) });
  for (const e of r.errors) process.stderr.write(`git-hygiene-clean: ${e}\n`);
  if (flag('--json')) process.stdout.write(JSON.stringify({ branches: r.candidates.branches, worktrees: r.candidates.worktrees }, null, 2) + '\n');
  else printReport(r);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`git-hygiene-clean: ${String(e?.message || e).split('\n')[0]}\n`);
  }
  process.exit(0);
}
