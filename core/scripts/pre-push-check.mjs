#!/usr/bin/env node
// Enforces: R-43
/**
 * pre-push-check — the config-driven logic behind .githooks/pre-push.
 *
 * Reads the ref-update lines git pipes to a pre-push hook on stdin
 * ("local_ref local_sha remote_ref remote_sha", one per updated ref).
 *
 *   A. Big-file gate (EVERY pushed branch, not only deploy branches): blobs that are NEW in
 *      this push and larger than config.pushGate.maxBlobMB (default 2). Mode
 *      config.pushGate.bigBlobMode: "warn" (default, lists and passes) | "block".
 *      Deliberate pass: <config.pushGate.bigBlobEnv>=1 (default BIG_FILE_OK=1).
 *
 *   B. Deploy gate: when the push targets one of the CURRENT repo's configured deploy
 *      branches (repo.deployBranches), runs
 *        1. a secret scan over the pushed commit range (config.secretScan) -- FAILS CLOSED
 *           (blocks the push) if the tool is missing and config.secretScan.failClosed is true.
 *        2. repo.checks.syntax once per changed file, against the CONTENT OF THE PUSHED SHA
 *           (git show <sha>:<file> -> temp dir), never the working-tree file. {file} is
 *           replaced by the temp path. Filtered to repo.sourceExtensions when non-empty.
 *        3. repo.checks.typecheck: a whole-tree command, so it only counts as evidence about
 *           the pushed commit when the working tree IS that commit (HEAD == sha, clean --
 *           lib/worktree-check.mjs assertWorktree). Otherwise the push is REJECTED with
 *           "not verified for this commit" instead of a false green on a dirty tree.
 *
 * Design rules (each one is an incident the gate was hardened against):
 *   - Every git call and every child command runs with scrubGitEnv() and an explicit cwd/-C.
 *     A hook inherits GIT_DIR / GIT_INDEX_FILE; a child that keeps them acts on the wrong
 *     repository (a test suite's fixture repos committed into the real one).
 *   - Repo identity comes from `git rev-parse --git-common-dir`, not from the top-level path,
 *     so submodules and linked worktrees match the right config entry.
 *   - Several deploy targets carrying DIFFERENT shas in one push are rejected ("last line
 *     wins" would verify only one of them).
 *   - An unknown remote sha (never fetched) must not turn into "no changed files -> pass":
 *     the base falls back to `--not --remotes`.
 *
 * Fully config-driven and fail-open: with no agent-scaffold.config.json anywhere above the
 * pushed repo, or no matching repo entry, or no deployBranches for it, the deploy gate exits
 * 0 -- the scaffold is not asking to gate this repo.
 *
 * Escape hatch: the env var named in config.secretScan.skipEnv set to "1" skips everything.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { assertWorktree, scrubGitEnv } from './lib/worktree-check.mjs';

export const ZERO_SHA = '0'.repeat(40);
const MAX_FILES = 200;
const MAX_OBJECT_LINES = 5000;
const RECENT_COMMITS = 200;

// ---------------------------------------------------------------- git helpers

/** git always runs from an explicit directory with the hook's GIT_* variables removed. */
function git(args, cwd, input) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: scrubGitEnv(), encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

function gitBuffer(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: scrubGitEnv(), maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
}

function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

/** Absolute, symlink-resolved common git dir: identical for a repo and all its worktrees. */
export function commonDirOf(dir) {
  try {
    const out = git(['rev-parse', '--git-common-dir'], dir);
    return realpathSync(path.resolve(dir, out));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pure helpers

/** Parses pre-push stdin into { localRef, localSha, remoteRef, remoteSha, branch } records. */
export function parseRefUpdates(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!remoteRef) continue;
    out.push({ localRef, localSha, remoteRef, remoteSha, branch: remoteRef.replace(/^refs\/heads\//, '') });
  }
  return out;
}

/**
 * Picks the deploy targets of a push. Branch deletions and non-deploy branches are ignored.
 * Several targets with different shas are an error: one verification cannot vouch for both.
 * Returns { targets, error }.
 */
export function pickDeployTargets(updates, deployBranches) {
  const wanted = new Set(deployBranches ?? []);
  const targets = updates.filter((u) => u.localSha !== ZERO_SHA && wanted.has(u.branch));
  const shas = new Set(targets.map((t) => t.localSha));
  if (shas.size > 1) {
    return { targets, error: 'multi-ref: deploy targets carrying different shas cannot be verified in one push; push each sha separately.' };
  }
  return { targets, error: null };
}

/** Parses `git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)'` output. */
export function parseBlobSizes(text, limitBytes) {
  const hits = [];
  for (const line of String(text).split('\n')) {
    const m = /^blob (\d+) (.+)$/.exec(line);
    if (m && Number(m[1]) > limitBytes) hits.push({ bytes: Number(m[1]), file: m[2] });
  }
  return hits;
}

// ---------------------------------------------------------------- gates

/** Base arguments that exclude what the remote already has (or, if unknown, any remote ref). */
function notBase(toplevel, remoteSha) {
  if (remoteSha !== ZERO_SHA && gitOk(['cat-file', '-e', `${remoteSha}^{commit}`], toplevel)) return [remoteSha];
  return ['--remotes'];
}

/** Blobs introduced by this push (not reachable from the remote tip) above limitBytes. */
export function findNewBigBlobs(toplevel, sha, remoteSha, limitBytes) {
  const base = notBase(toplevel, remoteSha);
  let list = git(['rev-list', '--objects', sha, '--not', ...base], toplevel);
  if (list.split('\n').length > MAX_OBJECT_LINES) {
    // Huge range (first push of a long history): limit to the most recent commits.
    list = git(['rev-list', '--objects', '-n', String(RECENT_COMMITS), sha, '--not', ...base], toplevel);
  }
  if (!list) return [];
  const sizes = git(['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], toplevel, `${list}\n`);
  return parseBlobSizes(sizes, limitBytes).map((h) => {
    let commit = '';
    try { commit = git(['log', '--format=%h', '-n1', sha, '--', h.file], toplevel); } catch { /* informational only */ }
    return { ...h, commit };
  });
}

/** Files changed by the push. Known remote tip: its diff (errors propagate). Else: commits not on any remote. */
export function changedFiles(toplevel, sha, remoteSha) {
  if (remoteSha !== ZERO_SHA && gitOk(['cat-file', '-e', `${remoteSha}^{commit}`], toplevel)) {
    return git(['diff', '--name-only', `${remoteSha}..${sha}`], toplevel).split('\n').filter(Boolean);
  }
  const commits = git(['rev-list', '-n', String(RECENT_COMMITS), sha, '--not', '--remotes'], toplevel).split('\n').filter(Boolean);
  const files = new Set();
  for (const c of commits) {
    const out = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', c], toplevel);
    for (const f of out.split('\n').filter(Boolean)) files.add(f);
  }
  return [...files];
}

function findOnPath(bin) {
  try {
    const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0];
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

function fail(message, skipEnvName) {
  console.error('');
  console.error(`[push-gate] PUSH BLOCKED: ${message}`);
  if (skipEnvName) console.error(`[push-gate] Deliberate skip: ${skipEnvName}=1 git push ...`);
  process.exit(1);
}

function runChild(command, cwd) {
  execSync(command, { cwd, env: scrubGitEnv(), stdio: 'inherit', windowsHide: true });
}

function matchRepo(root, config, toplevel, commonDir) {
  const top = realpathSync(toplevel);
  for (const r of config.repos ?? []) {
    const dir = path.resolve(root, r.path || '.');
    if (!existsSync(dir)) continue;
    const c = commonDirOf(dir);
    if (c && commonDir && c === commonDir) return r;
  }
  // Fallback when git cannot answer for a configured directory: exact path match only.
  return (config.repos ?? []).find((r) => {
    try { return realpathSync(path.resolve(root, r.path || '.')) === top; } catch { return false; }
  }) ?? null;
}

function bigFileGate(toplevel, updates, config, scan) {
  const gate = config.pushGate ?? {};
  const envName = gate.bigBlobEnv ?? 'BIG_FILE_OK';
  if (process.env[envName] === '1' || (scan.skipEnv && process.env[scan.skipEnv] === '1')) return;
  const maxMb = Number(gate.maxBlobMB ?? 2);
  const limit = maxMb * 1048576;
  const block = (gate.bigBlobMode ?? 'warn') === 'block';
  const report = [];
  for (const u of updates) {
    if (u.localSha === ZERO_SHA) continue; // deletions are never gated
    let hits = [];
    try { hits = findNewBigBlobs(toplevel, u.localSha, u.remoteSha, limit); } catch (e) {
      console.error(`[big-file] note: could not list new objects for ${u.branch} (${e.message}) -- not checked.`);
    }
    for (const h of hits) report.push(`[big-file]   ${(h.bytes / 1048576).toFixed(1)} MB\t${h.file}  (commit ${h.commit || '?'}, branch ${u.branch})`);
  }
  if (!report.length) return;
  console.error(`[big-file] NEW files over ${maxMb} MB in this push:`);
  console.error(report.join('\n'));
  if (block) {
    console.error(`[big-file] Put large assets in object storage / LFS. Deliberate pass: ${envName}=1 git push ...`);
    fail('large file push (list above).');
  }
  console.error(`[big-file] WARN mode (config.pushGate.bigBlobMode="warn") -- push allowed.`);
}

function secretScanGate(toplevel, scan, logOpts) {
  let scanBin = findOnPath(scan.tool);
  if (!scanBin && scan.tool === 'gitleaks' && process.env.LOCALAPPDATA) {
    const candidates = [
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gitleaks.exe'),
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages',
        'Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe', 'gitleaks.exe'),
    ];
    scanBin = candidates.find((p) => existsSync(p)) || null;
  }
  if (scanBin) {
    console.log(`[push-gate] ${scan.tool} scan (${logOpts})...`);
    const args = scan.tool === 'gitleaks'
      ? ['git', '--no-banner', '--redact', '--exit-code', '1', `--log-opts=${logOpts}`, toplevel]
      : [toplevel];
    try {
      execFileSync(scanBin, args, { cwd: toplevel, env: scrubGitEnv(), stdio: 'inherit', windowsHide: true });
    } catch {
      fail(`${scan.tool} found a problem in the pushed commits. If it is a false positive, allow-list it in the tool's own ignore file.`, scan.skipEnv);
    }
  } else if (scan.failClosed) {
    console.error(`[push-gate] WARNING: ${scan.tool} is not installed -- secret scan CANNOT run (a leaked secret would pass through silently).`);
    console.error('[push-gate] Install: brew install gitleaks (Windows: winget install Gitleaks.Gitleaks)');
    fail(`${scan.tool} is not installed; secret scan could not run.`, scan.skipEnv);
  } else {
    console.log(`[push-gate] NOTE: ${scan.tool} is not installed -- secret scan skipped (secretScan.failClosed is false).`);
  }
}

/** Runs repo.checks.syntax on the pushed sha's content of each changed file. */
function syntaxGate(toplevel, repo, files, sha, scan) {
  const exts = new Set((repo.sourceExtensions ?? []).map((e) => e.replace(/^\./, '')));
  let picked = exts.size ? files.filter((f) => exts.has(f.split('.').pop())) : files;
  if (picked.length > MAX_FILES) {
    console.log(`[push-gate] note: ${picked.length} changed source files; checking the first ${MAX_FILES}.`);
    picked = picked.slice(0, MAX_FILES);
  }
  if (!picked.length) return;
  console.log('[push-gate] syntax check (pushed content of changed files)...');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'push-gate-'));
  try {
    let n = 0;
    for (const f of picked) {
      if (!gitOk(['cat-file', '-e', `${sha}:${f}`], toplevel)) continue; // deleted in the pushed commit
      const dir = path.join(tmp, String(n++));
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(f));
      writeFileSync(target, gitBuffer(['show', `${sha}:${f}`], toplevel));
      try {
        runChild(repo.checks.syntax.split('{file}').join(target), toplevel);
      } catch {
        fail(`syntax check failed: ${f}`, scan.skipEnv);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function typecheckGate(toplevel, repo, sha, scan) {
  console.log('[push-gate] typecheck...');
  try {
    assertWorktree(toplevel, sha);
  } catch (e) {
    fail(`typecheck not verified for this commit: ${e.message}`, scan.skipEnv);
  }
  try {
    runChild(repo.checks.typecheck, toplevel);
  } catch {
    fail('typecheck failed.', scan.skipEnv);
  }
}

// ---------------------------------------------------------------- main

function main() {
  let stdin = '';
  try { stdin = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const updates = parseRefUpdates(stdin);
  if (!updates.length) process.exit(0);

  let toplevel;
  try {
    toplevel = git(['rev-parse', '--show-toplevel'], process.cwd());
  } catch {
    process.exit(0); // not inside a work tree (bare repo, ...) -- nothing to do
  }
  const commonDir = commonDirOf(toplevel);

  // Config lookup: from the work tree; a linked worktree outside the project falls back to the
  // common git dir, which lives inside the project that owns the repository.
  let loaded = loadConfig(toplevel);
  if (!loaded.found && commonDir) loaded = loadConfig(commonDir);
  const { root, config, found } = loaded;
  if (!found) process.exit(0); // scaffold not installed above this repo -- fail open

  const scan = { tool: 'gitleaks', failClosed: true, skipEnv: 'SKIP_PUSH_GATE', ...(config.secretScan ?? {}) };

  bigFileGate(toplevel, updates, config, scan);

  const repo = matchRepo(root, config, toplevel, commonDir);
  if (!repo) process.exit(0); // this repo is not listed in the config -- nothing to gate
  if (!(repo.deployBranches ?? []).length) process.exit(0);

  const { targets, error } = pickDeployTargets(updates, repo.deployBranches);
  if (error) fail(error, scan.skipEnv);
  if (!targets.length) process.exit(0); // none of the updated refs is a deploy branch

  if (scan.skipEnv && process.env[scan.skipEnv] === '1') {
    console.log(`[push-gate] ${scan.skipEnv}=1 -- gate skipped.`);
    process.exit(0);
  }

  const sha = targets[0].localSha;
  console.log(`[push-gate] '${repo.name}' push to deploy branch '${targets.map((t) => t.branch).join(', ')}' -- checks starting...`);

  // 1) secret scan. Known bases -> only the new commits; otherwise (new branch, unfetched tip,
  // several targets) the last 50 commits / the whole history of the pushed sha.
  let logOpts;
  if (targets.length > 1) logOpts = sha;
  else if (notBase(toplevel, targets[0].remoteSha)[0] !== '--remotes') logOpts = `${targets[0].remoteSha}..${sha}`;
  else logOpts = `-n 50 ${sha}`;
  secretScanGate(toplevel, scan, logOpts);

  // 2) syntax on the pushed content
  const checks = repo.checks ?? {};
  if (checks.syntax) {
    const files = new Set();
    try {
      for (const t of targets) for (const f of changedFiles(toplevel, sha, t.remoteSha)) files.add(f);
    } catch (e) {
      fail(`could not determine the changed files (${e.message}); not passing silently.`, scan.skipEnv);
    }
    syntaxGate(toplevel, repo, [...files], sha, scan);
  }

  // 3) whole-tree typecheck: evidence only when the tree is the pushed commit
  if (checks.typecheck) typecheckGate(toplevel, repo, sha, scan);

  console.log('[push-gate] All checks PASSED -- push proceeding.');
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
