#!/usr/bin/env node
/**
 * pre-push-check — the config-driven logic behind .githooks/pre-push.
 *
 * Reads the ref-update lines git pipes to a pre-push hook on stdin
 * ("local_ref local_sha remote_ref remote_sha", one per updated ref). If the
 * push targets one of the CURRENT repo's configured deploy branches
 * (repo.deployBranches in agent-scaffold.config.json), runs:
 *
 *   1. a secret scan over the pushed commit range (config.secretScan) --
 *      FAILS CLOSED (blocks the push) if the tool is missing and
 *      config.secretScan.failClosed is true.
 *   2. a per-repo syntax check: repo.checks.syntax run once per changed
 *      file (with {file} substituted by the absolute path), filtered to
 *      repo.sourceExtensions when that list is non-empty.
 *   3. a one-shot repo.checks.typecheck, if configured.
 *
 * Fully config-driven and fail-open: with no agent-scaffold.config.json
 * anywhere above the pushed repo's top-level, or no matching repo entry, or
 * no deployBranches configured for that repo, this exits 0 immediately --
 * the scaffold is either not installed here or not asking to gate this repo.
 *
 * Escape hatch: set the env var named in config.secretScan.skipEnv to "1"
 * (only takes effect once we already know the push targets a deploy
 * branch, so it doesn't print anything on ordinary pushes).
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, repoFor } from './lib/config.mjs';

const ZERO_SHA = '0'.repeat(40);

function readStdinLines() {
  try {
    return readFileSync(0, 'utf8').split('\n').filter((l) => l.trim().length);
  } catch {
    return [];
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function fail(message, skipEnvName) {
  console.error('');
  console.error(`[prod-gate] PUSH BLOCKED: ${message}`);
  if (skipEnvName) console.error(`[prod-gate] Deliberate skip: ${skipEnvName}=1 git push ...`);
  process.exit(1);
}

let toplevel;
try {
  toplevel = git(['rev-parse', '--show-toplevel']);
} catch {
  process.exit(0); // not inside a git repo somehow -- nothing to do
}

const { root, config, found } = loadConfig(toplevel);
if (!found) process.exit(0); // scaffold not installed above this repo -- fail open

const repo =
  (config.repos ?? []).find((r) => path.resolve(root, r.path || '.') === path.resolve(toplevel)) ||
  repoFor(root, config, toplevel);
if (!repo) process.exit(0); // this repo is not listed in the config -- nothing to gate

const deployBranches = new Set(repo.deployBranches ?? []);
if (!deployBranches.size) process.exit(0); // no deploy branch configured for this repo

let gatedBranch = null;
let range = '';
let logOpts = '';
for (const line of readStdinLines()) {
  const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
  if (!remoteRef) continue;
  if (localSha === ZERO_SHA) continue; // branch deletion -- never gated
  const branch = remoteRef.replace(/^refs\/heads\//, '');
  if (!deployBranches.has(branch)) continue;
  gatedBranch = branch;
  if (remoteSha === ZERO_SHA) {
    // no remote branch yet (first push of this branch) -- scan the last 50 commits
    range = '';
    logOpts = `-n 50 ${localSha}`;
  } else {
    range = `${remoteSha}..${localSha}`;
    logOpts = range;
  }
}

if (!gatedBranch) process.exit(0); // none of the updated refs are a deploy branch

const scan = { tool: 'gitleaks', failClosed: true, skipEnv: 'SKIP_PUSH_GATE', ...(config.secretScan ?? {}) };

if (scan.skipEnv && process.env[scan.skipEnv] === '1') {
  console.log(`[prod-gate] ${scan.skipEnv}=1 -- gate skipped.`);
  process.exit(0);
}

console.log(`[prod-gate] '${repo.name}' push to deploy branch '${gatedBranch}' -- checks starting...`);

// --- 1) secret scan ---
function findOnPath(bin) {
  try {
    const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0];
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

let scanBin = findOnPath(scan.tool);
if (!scanBin && scan.tool === 'gitleaks' && process.env.LOCALAPPDATA) {
  const candidates = [
    path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gitleaks.exe'),
    path.join(
      process.env.LOCALAPPDATA,
      'Microsoft', 'WinGet', 'Packages',
      'Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe', 'gitleaks.exe',
    ),
  ];
  scanBin = candidates.find((p) => existsSync(p)) || null;
}

if (scanBin) {
  console.log(`[prod-gate] ${scan.tool} scan (${logOpts})...`);
  try {
    if (scan.tool === 'gitleaks') {
      execFileSync(scanBin, ['git', '--no-banner', '--redact', '--exit-code', '1', `--log-opts=${logOpts}`, toplevel], { stdio: 'inherit' });
    } else {
      execFileSync(scanBin, [toplevel], { stdio: 'inherit' });
    }
  } catch {
    fail(`${scan.tool} found a problem in the pushed commits. If it is a false positive, allow-list it in the tool's own ignore file.`, scan.skipEnv);
  }
} else if (scan.failClosed) {
  console.error(`[prod-gate] WARNING: ${scan.tool} is not installed -- secret scan CANNOT run (a leaked secret would pass through silently).`);
  console.error('[prod-gate] Install: brew install gitleaks (Windows: winget install Gitleaks.Gitleaks)');
  fail(`${scan.tool} is not installed; secret scan could not run.`, scan.skipEnv);
} else {
  console.log(`[prod-gate] NOTE: ${scan.tool} is not installed -- secret scan skipped (secretScan.failClosed is false).`);
}

// --- 2) per-repo syntax + typecheck gate ---
const checks = repo.checks ?? {};
if (range && checks.syntax) {
  let changed = [];
  try {
    changed = git(['diff', '--name-only', range], toplevel).split('\n').filter(Boolean).slice(0, 200);
  } catch {
    changed = [];
  }
  const exts = new Set((repo.sourceExtensions ?? []).map((e) => e.replace(/^\./, '')));
  const files = exts.size ? changed.filter((f) => exts.has(f.split('.').pop())) : changed;
  if (files.length) {
    console.log('[prod-gate] syntax check (changed files)...');
    for (const f of files) {
      const abs = path.join(toplevel, f);
      if (!existsSync(abs)) continue;
      const cmd = checks.syntax.split('{file}').join(abs);
      try {
        execSync(cmd, { cwd: toplevel, stdio: 'inherit' });
      } catch {
        fail(`syntax check failed: ${f}`, scan.skipEnv);
      }
    }
  }
}

if (checks.typecheck) {
  console.log('[prod-gate] typecheck...');
  try {
    execSync(checks.typecheck, { cwd: toplevel, stdio: 'inherit' });
  } catch {
    fail('typecheck failed.', scan.skipEnv);
  }
}

console.log('[prod-gate] All checks PASSED -- push proceeding.');
process.exit(0);
