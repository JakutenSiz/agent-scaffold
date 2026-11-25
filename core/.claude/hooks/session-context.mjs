#!/usr/bin/env node
// Enforces: R-20
// SessionStart hook - injects a short per-session working note.
// Runs under both Claude Code (.claude) and Codex (.codex/hooks.json) so the
// coordination file becomes an async message channel both agents see every
// session.
//
// Fully config-driven: see scripts/lib/config.mjs and
// agent-scaffold.config.example.json for every parameter used below. If this
// project has not installed the scaffold (no agent-scaffold.config.json
// found), the hook FAILS OPEN - exits 0 with no output - so it never
// interferes with a project that hasn't opted in.
//
// STATUS LINES (config.session.lines): a list of { id, command, timeoutMs? }.
// Each command runs from the config root through the shell (default timeout
// 8000 ms). CONTRACT: a status script prints ONE line or NOTHING; its exit
// code is ignored. The first non-empty stdout line becomes a line
// of the note AS IS (status scripts carry their own label, e.g. "human queue: ..."; `id` is only
// the entry's identity in the config and is never printed). No output, a failure, a timeout, or
// a missing script (a command of the form `node <path>` whose file does not exist is never even started) all
// drop the line silently. All lines share one time budget
// (config.session.linesBudgetMs, default 25000 ms) so SessionStart never hits
// its own timeout; they run concurrently.
//
// AUTO-PULL: the root checkout is fast-forwarded when config.session.autoPull
// is true. Every configured sub-repo (config.repos entries with a path other
// than ".") that is behind its remote is fast-forwarded only when
// config.session.autoPullRepos is true (default) AND its tree is clean AND
// HEAD is on one of that repo's deployBranches or on the remote default
// branch AND the update is a pure fast-forward. Otherwise it is only reported.
//
// The module is a pure library plus main(); main() runs only when the file is
// executed directly, so every decision below is unit-testable.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

const execFileP = promisify(execFile);

export const DEFAULT_LINE_TIMEOUT_MS = 8000;
export const DEFAULT_LINES_BUDGET_MS = 25000;
const PULL_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 9000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests).
// ---------------------------------------------------------------------------

/** Should a behind sub-repo be fast-forwarded automatically? */
export function pullDecision({ branch, allowedBranches, dirty, ffPossible }) {
  if (dirty) return { pull: false, reason: 'working tree is dirty' };
  if (!allowedBranches.includes(branch)) {
    return { pull: false, reason: `on branch ${branch} (allowed: ${allowedBranches.join(', ') || 'none'})` };
  }
  if (!ffPossible) return { pull: false, reason: 'cannot fast-forward (branches diverged)' };
  return { pull: true, reason: '' };
}

// git: (args, { timeout }) => Promise<stdout>; the test passes a fake. Never throws: failures
// become a `status` field. Result: { name, status: current|pulled|manual|error, behind, reason }.
export async function processRepo({ name, git, deployBranches = [], autoPull = true }) {
  const result = { name, status: 'current', behind: 0, reason: '' };
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'HEAD') return result; // detached: no branch to follow
    await git(['fetch', '--quiet', 'origin', branch], { timeout: FETCH_TIMEOUT_MS });
    const behind = parseInt((await git(['rev-list', '--count', `HEAD..origin/${branch}`])).trim(), 10) || 0;
    if (behind === 0) return result;
    result.behind = behind;
    if (!autoPull) return { ...result, status: 'manual', reason: 'auto-pull disabled' };
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
    let ffPossible = false;
    try {
      await git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
      ffPossible = true;
    } catch {}
    let allowedBranches = [...deployBranches];
    if (!dirty) {
      let defaults = [];
      try {
        const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
        if (head) defaults = [head.replace(/^origin\//, '')];
      } catch {
        defaults = ['main', 'master'];
      }
      allowedBranches = [...new Set([...allowedBranches, ...defaults])];
    }
    const decision = pullDecision({ branch, allowedBranches, dirty, ffPossible });
    if (!decision.pull) return { ...result, status: 'manual', reason: decision.reason };
    try {
      await git(['pull', '--ff-only', '--quiet', 'origin', branch], { timeout: PULL_TIMEOUT_MS });
      return { ...result, status: 'pulled' };
    } catch (e) {
      const why = String(e?.stderr || e?.message || '').split('\n')[0].slice(0, 80);
      return { ...result, status: 'manual', reason: `pull failed (${why})` };
    }
  } catch {
    return { ...result, status: 'error' };
  }
}

export function freshnessLine(results) {
  const errors = results.filter((r) => r.status === 'error').length;
  if (results.length && errors === results.length) {
    return 'Repo freshness: check FAILED (every fetch failed - network/SSH?); repos may be BEHIND. ' +
      'Run `git fetch` + `git status` by hand in the one you are about to work in.';
  }
  const pulled = results.filter((r) => r.status === 'pulled');
  const manual = results.filter((r) => r.status === 'manual');
  const parts = [];
  if (pulled.length) parts.push(`UPDATED: ${pulled.map((r) => `${r.name} ${r.behind} commit(s) (ff)`).join(' | ')}`);
  if (manual.length) parts.push(`BEHIND (manual): ${manual.map((r) => `${r.name} - ${r.reason}`).join(' | ')}`);
  const tail = errors ? ` (${errors} repo(s) could not be fetched, unverified)` : '';
  if (!parts.length) return `Repo freshness: all up to date.${tail}`;
  return `Repo freshness: ${parts.join(' - ')}${tail}`;
}

/** `git status --porcelain` output -> untracked (`??`) and modified (` M`) paths, with `prefix` prepended. */
export function parsePorcelain(porcelain, prefix = '') {
  const paths = [];
  for (const row of String(porcelain).split('\n')) {
    const code = row.slice(0, 2);
    if (code !== '??' && code !== ' M') continue;
    const p = row.slice(3).trim();
    if (p) paths.push(`${prefix}${p}`);
  }
  return paths;
}

// entries: [{ path, mtimeMs }]. Lists the ones older than `hours`; the line stays within ~220 characters.
export function staleDocsLine(entries, now = Date.now(), hours = 24) {
  const old = entries
    .map((e) => ({ path: e.path, age: (now - e.mtimeMs) / 3_600_000 }))
    .filter((e) => e.age > hours)
    .sort((a, b) => b.age - a.age);
  if (!old.length) return '';
  const head = `UNCOMMITTED DOCS (>${hours}h): `;
  const tail = ' - written but never committed, so invisible from other machines; commit or delete.';
  const budget = 220 - head.length - tail.length - 14; // room for ", +NN files"
  const picked = [];
  let used = 0;
  for (const e of old) {
    const item = `${e.path} (${Math.floor(e.age / 24)}d)`;
    const cost = item.length + (picked.length ? 2 : 0);
    if (used + cost > budget) break;
    picked.push(item);
    used += cost;
  }
  if (!picked.length) {
    const e = old[0];
    const sfx = ` (${Math.floor(e.age / 24)}d)`;
    picked.push(`...${e.path.slice(-Math.max(8, budget - sfx.length - 3))}${sfx}`);
  }
  const rest = old.length - picked.length;
  return `${head}${picked.join(', ')}${rest > 0 ? `, +${rest} files` : ''}${tail}`;
}

/** Why did `git pull --ff-only` fail? no-upstream | diverged | dirty | network | other. */
export function classifyPullFailure({ reason = '', ahead = 0, behind = 0 }) {
  // No remote or no tracking branch: there is nothing to pull, and saying so at every start is noise.
  if (/no tracking information|no remote repository specified|no such remote|no upstream configured/i.test(reason)) return 'no-upstream';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (/diverg|not possible to fast-forward|cannot fast-forward/i.test(reason)) return 'diverged';
  if (/would be overwritten|local changes|uncommitted|unstaged|your changes/i.test(reason)) return 'dirty';
  if (/could not resolve|unable to access|connection|timed out|timeout|could not read from remote|network|ssh|unreachable/i.test(reason)) return 'network';
  return 'other';
}

// One line per failure kind, each ending with what to do. A diverged checkout makes pull fail at
// every start; a bare "pull failed" went unnoticed for weeks in one project while sessions ran on stale rules.
export function pullFailureLine({ branch, upstream, ahead = 0, behind = 0, unique = 0, firstDate = '', reason = '' }) {
  const kind = classifyPullFailure({ reason, ahead, behind });
  if (kind === 'no-upstream') return '';
  const b = branch || 'main';
  if (kind === 'diverged') {
    const u = upstream || `origin/${b}`;
    const content = unique > 0 ? `${unique} of them have content missing upstream` : 'all of their content exists upstream';
    const step1 = unique > 0
      ? '(1) `git log --oneline @{u}..HEAD` - push the commits whose content is missing upstream from a clean worktree based on the remote branch; '
      : '(1) nothing to push; ';
    return (
      `PULL DIVERGED (pull fails at every start): local ${b} is ${behind} commit(s) BEHIND and has ${ahead} local commit(s) not upstream ` +
      `(${content}${firstDate ? `; oldest ${firstDate}` : ''}). This session runs on STALE rules/hooks - TELL THE USER NOW. Fix: ${step1}` +
      `(2) \`git branch backup/${b}-<date>\`, move any dirty files aside, then \`git switch -C ${b} ${u}\` (git refuses if it would lose work). ` +
      `Never reset --hard or stash on a shared checkout. Prevention: do not commit directly on local ${b}; push docs from a worktree based on the remote branch.`
    );
  }
  if (kind === 'dirty') {
    return `WARNING: git pull failed - uncommitted local changes block the fast-forward (${reason}). Board/coordination files may be STALE; commit the work (or continue in a separate worktree), then run \`git pull --ff-only\`.`;
  }
  if (kind === 'network') {
    return `WARNING: git pull failed - remote unreachable (${reason}). Working offline: board/coordination files may be STALE; run \`git pull --ff-only\` when the network is back.`;
  }
  return `WARNING: git pull FAILED (${reason}) - board/coordination files may be STALE; run \`git pull --ff-only\` by hand when convenient.`;
}

/** Expected Node major from `.nvmrc`, else a plain `engines.node` (ranges like ">=18" are ignored). null = unknown. */
export function expectedNodeMajor(root) {
  try {
    const rc = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
    const m = /^v?(\d+)/.exec(rc);
    if (m) return { major: parseInt(m[1], 10), source: '.nvmrc' };
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const range = String(pkg?.engines?.node ?? '').trim();
    const m = /^[\^~=v]*(\d+)(?:\.[\dx*]+)*$/.exec(range);
    if (m) return { major: parseInt(m[1], 10), source: 'package.json engines.node' };
  } catch {}
  return null;
}

export function nodeWarning(version, expected) {
  if (!expected) return '';
  const m = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!m || parseInt(m[1], 10) === expected.major) return '';
  return `NODE WARNING: local Node v${m[1]}.${m[2]} but this project expects major ${expected.major} (${expected.source}) - "works on my machine" trap; switch versions.`;
}

const SCRIPT_CMD = /^\s*node\s+("?)([^\s"-][^\s"]*)\1/;

/**
 * Run the configured status lines. exec: async (command, { cwd, timeout }) => stdout string (throws on
 * timeout/spawn failure; a non-zero exit with output still returns that output). Returns ["<id>: <text>", ...]
 * in config order.
 */
export async function collectStatusLines({ root, lines, exec, exists = existsSync, budgetMs = DEFAULT_LINES_BUDGET_MS, now = Date.now }) {
  const deadline = now() + budgetMs;
  const out = await Promise.all(
    (lines || []).map(async (l) => {
      if (!l || !l.id || !l.command) return null;
      const m = SCRIPT_CMD.exec(l.command);
      if (m && !exists(path.resolve(root, m[2]))) return null; // missing script: never start it
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      const timeout = Math.max(1, Math.min(l.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS, remaining));
      try {
        const stdout = await exec(l.command, { cwd: root, timeout });
        const first = String(stdout ?? '').split('\n').map((s) => s.trim()).find(Boolean);
        return first || null;
      } catch {
        return null; // failure or timeout: silent
      }
    }),
  );
  return out.filter(Boolean);
}

/** Assemble the session note. Every dynamic part is passed in so this stays pure. */
export function buildNote({ config, statusLines = [], pullLine = '', repoLine = '', staleDocs = '', nodeLine = '', hasCoordination = false, hasBoard = false }) {
  const skillList = (config.session.skills || []).map((s) => `/${s}`).join(', ');
  const subs = config.delegation.subagents || {};
  const scout = subs.scout || 'scout';
  const analyst = subs.analyst || 'analyst';
  const worker = subs.worker || 'worker';
  const verifier = subs.verifier || 'verifier';
  const handoff = config.session.context?.handoffSkill || 'handoff';
  const humans = (config.humans || []).join(', ');
  const mb = config.memoryBank.dir;
  const parts = [`${config.projectName || 'Project'} session note:`];
  parts.push(...statusLines);
  if (pullLine) parts.push(pullLine);
  if (repoLine) parts.push(repoLine);
  if (staleDocs) parts.push(staleDocs);
  if (nodeLine) parts.push(nodeLine);
  parts.push(
    `1) Before starting non-trivial work, read the ${mb}/ directory of the repo you are working in (especially repoMap.md + activeContext.md).`,
    `2) When meaningful work is done, update ${mb}/activeContext.md + progress.md in that repo. If you added a new source file, ` +
      `record it in ${mb}/repoMap.md (the push gate rejects a push whose new files cannot be found there). Before writing a ` +
      `shared piece (component/helper), check ${mb}/reuse-registry.json - do not re-write a registered canonical piece.`,
  );
  if (skillList) {
    parts.push(
      `3) Use the project's skills for repeated rituals: ${skillList}. If the same procedure is being carried out a 3rd time ` +
        '(2nd if the first run cost a trap), turn it into a skill instead of repeating it from memory.',
    );
  }
  parts.push(
    `4) Work delegation-first: the main model is the ARCHITECT. Multi-file exploration/reading -> '${scout}'; deep flow ` +
      `analysis/root-cause -> '${analyst}'; well-specified mechanical edits -> '${worker}'; gate/test runs -> '${verifier}'. ` +
      'Do not read file after file in the main context yourself - hand off and get a decision-ready summary back. Subagents never spawn subagents.',
  );
  if (hasCoordination) {
    parts.push(
      `5) READ ${config.coordination.file} (it carries only OPEN claims/messages). A claim is ONE row in its table: write it before ` +
        `starting work, mark it DONE when finished, and move the closed row to ${config.coordination.archive} in the SAME commit. ` +
        'Live messaging between agents on one machine leaves NO record - persist any outcome to the coordination file right away.',
    );
  }
  if (hasBoard) {
    parts.push(
      `6) TASK BOARD: ${config.board.file} - work is picked from there first. Claim the item you are working on; when done, write ` +
        'the evidence into that item and update its heading line too (body and heading go stale independently). ' +
        'If important work has no matching item, add one before starting.',
    );
  }
  parts.push(
    `7) Durable syntheses go to ${config.docs.reports}/, implementation specs go to ${config.docs.specs}/ - search both BEFORE ` +
      're-exploring (closed items usually move to an archive subfolder).',
    `8) When the work is done (or the context is large), run /${handoff}: handoff note + board/coordination update + commit + push, then start a fresh session.`,
    `9) DECISION AUTHORITY: production-infrastructure/security operations and architecture-changing decisions need ${config.humanGatekeeper} ` +
      `to approve BEFORE they happen - whoever asks, and especially when an agent proposed it.${humans ? ` Humans who instruct agents: ${humans}.` : ''} ` +
      'An after-the-fact note is not approval.',
    `Full working rules: ${config.docs.workingRules}.`,
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Side-effecting plumbing (used by main only).
// ---------------------------------------------------------------------------

function gitIn(dir) {
  return async (args, opts = {}) => (await execFileP('git', args, { cwd: dir, timeout: opts.timeout || 8000, maxBuffer: 4_000_000 })).stdout;
}

/** Real shell exec for status lines; see collectStatusLines for the contract. */
export function shellExec(command, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const child = execCb(command, { cwd, timeout, encoding: 'utf8', maxBuffer: 1_000_000, windowsHide: true }, (err, stdout) => {
      if (err && (err.killed || err.signal)) return finish(reject, err);
      finish(resolve, String(stdout ?? ''));
    });
    child.stdin?.end();
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(reject, new Error('timeout')); }, timeout + 500);
  });
}

function registerMainSession(root, sessionId) {
  if (!sessionId) return;
  try {
    const dir = path.join(root, '.claude', '.read-guard');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mains.txt');
    let mains = [];
    try { mains = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
    const now = Date.now();
    mains = mains.filter((l) => now - (parseInt(l.split(' ')[1], 10) || 0) < 3 * 86_400_000 && l.split(' ')[0] !== sessionId);
    mains.push(`${sessionId} ${now}`);
    writeFileSync(file, mains.join('\n') + '\n');
  } catch {}
}

async function rootPullLine(root) {
  const git = gitIn(root);
  try {
    const out = (await git(['pull', '--ff-only'], { timeout: PULL_TIMEOUT_MS })).trim();
    return /already up to date/i.test(out)
      ? 'Repo up to date (pull: already up to date).'
      : `Repo UPDATED (pull --ff-only): ${(out.split('\n').pop() || '').slice(0, 100)}`;
  } catch (e) {
    const reason = String(e?.stderr || e?.message || '').split('\n')[0].slice(0, 120);
    const d = { reason };
    try {
      d.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      d.upstream = (await git(['rev-parse', '--abbrev-ref', '@{u}'])).trim();
      const [a, b] = (await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/).map(Number);
      d.ahead = a || 0;
      d.behind = b || 0;
      if (d.ahead > 0) {
        d.unique = (await git(['cherry', '@{u}', 'HEAD'])).split('\n').filter((l) => l.startsWith('+')).length;
        d.firstDate = (await git(['log', '--reverse', '--format=%cs', '@{u}..HEAD'])).split('\n')[0] || '';
      }
    } catch {}
    return pullFailureLine(d);
  }
}

function subRepos(root, config) {
  return (config.repos || [])
    .filter((r) => r.path && path.resolve(root, r.path) !== path.resolve(root))
    .map((r) => ({ ...r, dir: path.resolve(root, r.path) }))
    .filter((r) => existsSync(path.join(r.dir, '.git')));
}

async function repoFreshness(root, config) {
  const repos = subRepos(root, config);
  if (!repos.length) return '';
  const cacheFile = path.join(root, '.claude', '.repo-freshness-cache.json');
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.ts < 5 * 60_000 && typeof cached.line === 'string') return `${cached.line} [cached <5min]`;
  } catch {}
  const results = await Promise.all(
    repos.map((r) => processRepo({
      name: r.name || r.path,
      git: gitIn(r.dir),
      deployBranches: r.deployBranches || [],
      autoPull: config.session.autoPullRepos !== false,
    })),
  );
  const line = freshnessLine(results);
  try { writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), line })); } catch {}
  return line;
}

async function staleDocEntries(root, config) {
  const mb = config.memoryBank.dir;
  const rootSpecs = [config.board.file, config.board.archive, config.coordination.file, config.coordination.archive, config.docs.reports, config.docs.specs]
    .filter(Boolean);
  const jobs = [];
  const subs = subRepos(root, config);
  const subDirs = new Set(subs.map((r) => r.dir));
  const rootMb = (config.repos || [])
    .filter((r) => !subDirs.has(path.resolve(root, r.path || '.')))
    .map((r) => path.posix.join((r.path || '.').split(path.sep).join('/'), mb).replace(/^\.\//, ''));
  const collect = async (dir, prefix, specs) => {
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain', '-uall', '--', ...specs], { cwd: dir, timeout: 8000, maxBuffer: 4_000_000 });
      return parsePorcelain(stdout, prefix).flatMap((p) => {
        try { return [{ path: p, mtimeMs: statSync(path.join(root, p)).mtimeMs }]; } catch { return []; }
      });
    } catch {
      return [];
    }
  };
  jobs.push(collect(root, '', [...rootSpecs, ...rootMb]));
  for (const r of subs) jobs.push(collect(r.dir, `${path.relative(root, r.dir).split(path.sep).join('/')}/`, [mb]));
  return (await Promise.all(jobs)).flat().filter((e) => e.path.endsWith('.md'));
}

async function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { root, config, found } = loadConfig(startDir);
  if (!found) return; // scaffold not installed here - stay silent

  // Main-session registration for read-guard's subagent exemption. SessionStart only runs for real
  // sessions (never for Task/Agent subagents), so a session_id NOT in mains.txt means "subagent".
  registerMainSession(root, String(input.session_id || '').replace(/[^\w-]/g, '').slice(0, 64));

  // Pull first so the board/coordination files and status lines below are read fresh.
  let pullLine = '';
  if (config.session.autoPull) {
    try { pullLine = await rootPullLine(root); } catch {}
  }

  const safe = (p) => p.catch(() => '');
  const [repoLine, staleDocs, statusLines] = await Promise.all([
    safe(repoFreshness(root, config)),
    safe(staleDocEntries(root, config).then((e) => staleDocsLine(e, Date.now(), config.session.staleDocHours ?? 24))),
    collectStatusLines({
      root,
      lines: config.session.lines,
      exec: shellExec,
      budgetMs: config.session.linesBudgetMs ?? DEFAULT_LINES_BUDGET_MS,
    }).catch(() => []),
  ]);

  const note = buildNote({
    config,
    statusLines,
    pullLine,
    repoLine,
    staleDocs,
    nodeLine: nodeWarning(process.version, expectedNodeMajor(root)),
    hasCoordination: existsSync(path.join(root, config.coordination.file)),
    hasBoard: existsSync(path.join(root, config.board.file)),
  });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }));
}

if (isMainModule(import.meta.url)) {
  try { await main(); } catch { /* fail open */ }
}
