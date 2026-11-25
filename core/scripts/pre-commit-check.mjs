#!/usr/bin/env node
// Enforces: R-45
/**
 * pre-commit-check -- the cheap, fast logic behind .githooks/pre-commit.
 *
 * The hook is installed through core.hooksPath, so it runs for EVERY commit in the root repo
 * and every configured sub-repo. The first job is therefore to do nothing: read the staged
 * file list and, if no check applies to it, exit 0 without starting a single process.
 *
 * Checks (all optional; each runs only when a matching file is staged):
 *   - board:        config.board.file staged        -> node scripts/board-lint.mjs --staged
 *   - coordination: config.coordination.file staged -> node scripts/coordination-archive.mjs --check
 *     Both built-ins run only when the commit is made in the config-root repo itself, and are
 *     silently skipped when the script file does not exist (partial installs stay usable).
 *   - project checks: config.preCommit.checks = [{ id, command, whenStaged: [glob, ...] }].
 *     When any whenStaged glob matches a staged file, `command` runs with cwd = config root
 *     and `{files}` replaced by the matching staged files. A glob without "/" matches the
 *     file's base name ("*.sql"); otherwise it is matched against the repo-relative path
 *     (lib/config.mjs globToRegExp: **, *, {a,b}).
 *
 * A check that exits 0 but printed something (warn mode) has its output shown under a
 * `[pre-commit] <id>:` header; the commit is not stopped.
 * Exit 1 stops the commit. All applicable checks run before the verdict, so one commit shows
 * every red check; the failure block names each check, its output and its own escape hatch.
 *
 * Escape hatches (value shown in the block):
 *   board         config.board.lint.escapeEnv (default BOARD_LINT)  = skip
 *   coordination  COORDINATION_CHECK = skip   (COORDINATION_CHECK=warn makes the check itself exit 0;
 *                 config.coordination.checkMode 'warn' sets it for you, an explicit value wins)
 *   project check <check.skipEnv, default PRE_COMMIT_SKIP_<ID>>   = 1   (ID upper-cased, non-alnum -> _)
 * Mention the reason in the commit message whenever you skip.
 *
 * ENVIRONMENT -- read this before changing anything: inside a pre-commit hook GIT_INDEX_FILE
 * points at the index being committed (a temporary one for `git commit -- <path>`) and GIT_DIR
 * may be set. Calls that READ THE STAGE (git diff --cached, the built-in lint scripts, which do
 * the same with --staged) must keep these variables, otherwise they would read the real index
 * and lint something other than what is being committed. Project check commands are not about
 * the stage -- they get the file list through {files} -- so they run with scrubGitEnv(): a test
 * suite or fixture repo started from them must never inherit the hook's repository.
 *
 * Fail-open: no config, not inside a work tree, node cannot start a check -> exit 0.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { globToRegExp, loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { scrubGitEnv } from './lib/worktree-check.mjs';

const norm = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');

/** Staged paths (added/copied/modified/renamed/deleted), relative to the repo top level. KEEPS the hook's GIT_* env. */
export function stagedFiles(cwd, env = process.env) {
  const out = execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only', '--no-renames'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((l) => norm(l.trim())).filter(Boolean);
}

/** True when `file` matches one of the globs (slash-less globs match the base name). */
export function matchesAny(file, globs) {
  return (globs ?? []).some((g) => {
    const re = globToRegExp(norm(g));
    return re.test(g.includes('/') ? file : path.posix.basename(file));
  });
}

function quoteArg(f) {
  if (process.platform === 'win32') return `"${f.replaceAll('"', '\\"')}"`;
  return `'${f.replaceAll("'", `'\\''`)}'`;
}

export const envKeyFor = (id) => `PRE_COMMIT_SKIP_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * Builds the list of checks to run for a staged set. Pure: no process is started here.
 * Each entry: { id, kind: 'script'|'shell', argv?, command?, files, escapeEnv, escapeValue, defaultEnv? }.
 */
export function planChecks(root, config, staged) {
  const plan = [];
  const has = (f) => f && staged.includes(norm(f));
  const script = (rel) => existsSync(path.join(root, rel));

  if (has(config.board?.file) && script('scripts/board-lint.mjs')) {
    plan.push({ id: 'board', kind: 'script', argv: ['scripts/board-lint.mjs', '--staged'], files: [norm(config.board.file)],
      escapeEnv: config.board?.lint?.escapeEnv ?? 'BOARD_LINT', escapeValue: 'skip' });
  }
  if (has(config.coordination?.file) && script('scripts/coordination-archive.mjs')) {
    plan.push({ id: 'coordination', kind: 'script', argv: ['scripts/coordination-archive.mjs', '--check'], files: [norm(config.coordination.file)],
      escapeEnv: 'COORDINATION_CHECK', escapeValue: 'skip',
      // config.coordination.checkMode 'warn' = COORDINATION_CHECK=warn for the script; a value already
      // in the environment (non-empty) is left alone and wins over the config.
      defaultEnv: config.coordination?.checkMode === 'warn' ? { COORDINATION_CHECK: 'warn' } : undefined });
  }
  for (const c of config.preCommit?.checks ?? []) {
    if (!c?.id || !c.command) continue;
    const files = staged.filter((f) => matchesAny(f, c.whenStaged));
    if (!files.length) continue;
    plan.push({ id: c.id, kind: 'shell', command: c.command.split('{files}').join(files.map(quoteArg).join(' ')), files,
      escapeEnv: c.skipEnv ?? envKeyFor(c.id), escapeValue: '1' });
  }
  return plan;
}

/** `env` plus the check's default variables, which apply only where `env` has no non-empty value. */
function withDefaultEnv(env, defaults) {
  const out = { ...env };
  for (const [k, v] of Object.entries(defaults ?? {})) if (!out[k]) out[k] = v;
  return out;
}

/** Runs one planned check. Returns { ok, output }. Output is captured and shown only on failure. */
export function runCheck(root, check) {
  const base = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const r = check.kind === 'script'
    // The built-in lint scripts read the stage, so they inherit the hook's GIT_INDEX_FILE.
    ? spawnSync(process.execPath, check.argv, { ...base, env: withDefaultEnv(process.env, check.defaultEnv) })
    : spawnSync(check.command, { ...base, shell: true, env: scrubGitEnv() });
  if (r.error) return { ok: true, output: `could not start (${r.error.message}) -- skipped (fail-open)` };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd() };
}

/** Whole run for a config root + staged list. Returns { failures, skipped, ran, notices }. */
export function runPlan(root, plan, env = process.env) {
  const failures = [];
  const skipped = [];
  const notices = [];
  let ran = 0;
  for (const check of plan) {
    if (env[check.escapeEnv] === check.escapeValue) { skipped.push(check); continue; }
    ran++;
    const res = runCheck(root, check);
    if (!res.ok) failures.push({ check, output: res.output });
    else if (res.output) notices.push({ check, output: res.output });
  }
  return { failures, skipped, ran, notices };
}

/** Output of checks that passed (warn mode): header plus the output; never blocks. */
export function formatNotice({ check, output }) {
  return [`[pre-commit] ${check.id}:`, ...output.split('\n').map((l) => `  ${l}`)].join('\n');
}

export function formatFailure(failures) {
  const lines = ['', '[pre-commit] COMMIT BLOCKED -- red check(s):'];
  for (const { check, output } of failures) {
    lines.push('', `  [${check.id}] ${check.kind === 'script' ? `node ${check.argv.join(' ')}` : check.command}`);
    for (const l of (output || '(no output)').split('\n')) lines.push(`    ${l}`);
    lines.push(`  skip only this check: ${check.escapeEnv}=${check.escapeValue} git commit ...  (state the reason in the commit message)`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const { root, config, found } = loadConfig(process.cwd());
  if (!found) process.exit(0);

  let toplevel;
  try {
    toplevel = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
      env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    process.exit(0);
  }
  // Built-ins and project checks belong to the config-root repo; other repos only share the hook.
  let sameRoot = false;
  try { sameRoot = realpathSync(toplevel) === realpathSync(root); } catch { /* not the root */ }
  if (!sameRoot) process.exit(0);

  let staged;
  try { staged = stagedFiles(toplevel); } catch { process.exit(0); }
  if (!staged.length) process.exit(0);

  const plan = planChecks(root, config, staged);
  if (!plan.length) process.exit(0); // nothing applies: no process started

  const { failures, skipped, notices } = runPlan(root, plan);
  for (const n of notices) console.error(formatNotice(n));
  for (const s of skipped) console.log(`[pre-commit] ${s.id}: skipped (${s.escapeEnv}=${s.escapeValue}) -- say why in the commit message.`);
  if (failures.length) {
    console.error(formatFailure(failures));
    process.exit(1);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
