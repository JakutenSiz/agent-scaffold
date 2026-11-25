// Shared config loader for agent-scaffold hooks and scripts.
// Walks up from `startDir` (default: cwd) to find agent-scaffold.config.json.
// Never throws on a missing file: returns { root, config: DEFAULTS, found: false }
// so every hook/script stays fail-open when the scaffold is not installed.
//
// DEBUGGING TRAP (Windows + Git Bash): an MSYS path such as /c/Users/... or /tmp/...
// passed as startDir is NOT resolved by Node; the walk-up finds nothing and every
// hook goes silent (exit 0, no output) - indistinguishable from "nothing to say".
// When testing hooks by hand from Git Bash, pass `pwd -W` (a C:\\ path).
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'agent-scaffold.config.json';

// DEFAULTS are the `standard` profile. `profile` (minimal | standard | strict) selects a partial
// layer from PROFILES below; the user's config file is merged on top of it and always wins.
export const DEFAULTS = {
  version: 2,
  profile: 'standard',
  projectName: 'project',
  language: 'en',
  layout: 'single',
  humanGatekeeper: 'the project owner',
  // Tags usable in a board item's "Human step" field: [OWNER] ... One entry per human who
  // instructs agents; scripts/human-queue.mjs builds one queue per tag.
  humans: ['OWNER'],
  labels: { humanOnly: 'DEV', anyone: 'ANY' },
  repos: [{ name: 'app', path: '.', stack: 'unknown', checks: {}, editCheck: [], deployBranches: [], sourceExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'] }],
  board: {
    file: 'task-board.md', archive: 'task-board-archive.md',
    ceiling: 4000, ceilingBytes: 262144, maxLineChars: 4096,
    // Field names of the compact item template. Translate them here if the board is not English.
    fields: { remaining: 'Remaining', lastEvidence: 'Last evidence', decision: 'Decision/blocker', trap: 'Trap', history: 'Full history', humanStep: 'Human step' },
    lint: { mode: 'warn', escapeEnv: 'BOARD_LINT' },
    humanStepExpiryWeeks: 4,
  },
  // checkMode: block | warn - what the commit-time coordination check does with findings.
  coordination: { file: 'coordination.md', archive: 'coordination-archive.md', ceiling: 1200, ceilingBytes: 131072, staleClaimDays: 7, checkMode: 'block' },
  // reuseGate: block | off - the reuse-registry deny in the map guardian (the map injection stays).
  memoryBank: { dir: 'memory-bank', ceiling: 800, ceilingBytes: 65536, maxLineChars: 2048, windowDays: 14, mapBudgetBytes: 8000, pendingPhrases: ['pending', 'awaiting', 'waiting for', 'blocked'], reuseGate: 'block' },
  docs: { reports: 'reports', specs: 'specs', workingRules: 'docs/agent-working-rules.md', memoryBankGuide: 'docs/memory-bank-guide.md', memoryBankSchema: 'docs/memory-bank-schema.json', toolTraps: 'docs/tool-traps.md' },
  delegation: {
    // denyAfterReads / denyAfterEdits: 0 = never deny (warn only).
    warnAfterReads: 5, denyAfterReads: 10, countShell: true, warnAfterEdits: 15, denyAfterEdits: 0,
    subagents: { scout: 'scout', analyst: 'analyst', worker: 'worker', verifier: 'verifier' },
  },
  session: {
    autoPull: true, autoPullRepos: true, ensureHooksPath: true, staleDocHours: 24, linesBudgetMs: 25000, skills: [],
    // One-line status scripts printed in the SessionStart note. Contract: the command prints at
    // most one line (or nothing) and its exit code is ignored. Add your own lines here.
    lines: [
      { id: 'size', command: 'node scripts/md-size-watch.mjs --line' },
      { id: 'board', command: 'node scripts/board-staleness.mjs --line' },
      { id: 'coordination', command: 'node scripts/coordination-archive.mjs --line' },
      { id: 'humans', command: 'node scripts/human-queue.mjs --line' },
      { id: 'hygiene', command: 'node scripts/git-hygiene-watch.mjs --line' },
      { id: 'orphans', command: 'node scripts/orphan-process.mjs --line' },
      { id: 'memory-bank', command: 'node scripts/memory-bank-check.mjs --line' },
      { id: 'rules', command: 'node scripts/rule-inventory.mjs --line' },
    ],
    context: { warnTokens: 300000, idleMinutes: 60, idleMinTokens: 100000, handoffSkill: 'handoff', offEnv: 'CONTEXT_WATCH' },
  },
  git: {
    protectedBranches: [],
    shield: { escapeEnv: 'AGENT_DESTRUCTIVE_OK', forbiddenCommands: [] },
    hygiene: { autoClean: false, branchMinAgeHours: 24, worktreeMinAgeHours: 6, staleStashDays: 14, worktreeDebtAsk: 5, ignoreFile: 'scripts/git-hygiene-ignore.json',
      // off | cherry - cherry also recognises branches merged by squash / cherry-pick (read by the hygiene scripts).
      equivalentMerge: 'off' },
  },
  preCommit: { checks: [] },
  // mapGate: block | off (repo-map check on pushed source files); confirm: ask | off (deploy-branch ask).
  pushGate: { maxBlobMB: 2, bigBlobMode: 'warn', bigBlobEnv: 'BIG_FILE_OK', requireHooksPath: true, mapGate: 'block', confirm: 'ask' },
  testRunner: { processName: 'chrome-headless-shell', maxWorkers: 2, maxProcesses: 8, triggerPattern: 'playwright|e2e' },
  orphans: { pattern: 'node --test', maxAgeMinutes: 60, maxRssMB: 4096 },
  codex: { riskyPatterns: [] },
  secretScan: { tool: 'gitleaks', failClosed: true, skipEnv: 'SKIP_PUSH_GATE' },
  // Secret-file shield. Globs without "/" match the base name. `allow` is subtracted from `protectedPaths`.
  secrets: {
    mode: 'block',
    protectedPaths: [
      '.env', '.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*',
      '**/.ssh/**', '**/.aws/credentials', '**/.npmrc', '**/.netrc', '**/.git-credentials',
      '**/service-account*.json', '**/credentials*.json',
    ],
    allow: ['.env.example', '.env.sample', '.env.template', '**/*.pub'],
  },
  // Completion gate: `command` runs before a task may be closed; empty = gate disabled.
  doneGate: { command: '', timeoutSec: 900, mode: 'block', exempt: [] },
  // Handoff packet: directory and size budget.
  handoff: { dir: 'handoffs', budgetBytes: 8192 },
};

// Partial config layers selected by `profile`. Rules: no arrays here (deepMerge replaces arrays
// wholesale); only keys that differ from DEFAULTS (= standard). Fixed in EVERY profile and thus
// never listed: destructive-git denial, subagent-recursion denial, secretScan.failClosed,
// secrets.mode.
export const PROFILES = {
  minimal: {
    board: { lint: { mode: 'off' } },
    pushGate: { maxBlobMB: 10, bigBlobMode: 'warn', requireHooksPath: false, mapGate: 'off', confirm: 'off' },
    delegation: { warnAfterReads: 8, denyAfterReads: 0, warnAfterEdits: 30, denyAfterEdits: 0 },
    session: { context: { warnTokens: 600000 } },
    git: { hygiene: { worktreeDebtAsk: 20 } },
    memoryBank: { reuseGate: 'off' },
    coordination: { checkMode: 'warn' },
    testRunner: { maxWorkers: 4 },
    doneGate: { mode: 'off' },
  },
  standard: {},
  strict: {
    board: { lint: { mode: 'block' } },
    pushGate: { maxBlobMB: 1, bigBlobMode: 'block', requireHooksPath: true, mapGate: 'block', confirm: 'ask' },
    delegation: { warnAfterReads: 3, denyAfterReads: 6, warnAfterEdits: 10, denyAfterEdits: 25 },
    session: { context: { warnTokens: 200000 } },
    git: { hygiene: { worktreeDebtAsk: 2 } },
    memoryBank: { reuseGate: 'block' },
    coordination: { checkMode: 'block' },
    testRunner: { maxWorkers: 1 },
    doneGate: { mode: 'block' },
  },
};

/**
 * Resolves a profile name to { name, layer }. A missing name means `standard`; an unknown name
 * prints one stderr warning and falls back to `standard`.
 */
export function resolveProfile(name) {
  if (name === undefined || name === null || name === '') return { name: 'standard', layer: PROFILES.standard };
  if (typeof name === 'string' && Object.hasOwn(PROFILES, name)) return { name, layer: PROFILES[name] };
  process.stderr.write(`[agent-scaffold] unknown profile ${JSON.stringify(name)} (expected ${Object.keys(PROFILES).join(' | ')}); using standard\n`);
  return { name: 'standard', layer: PROFILES.standard };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function findRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(startDir = process.cwd()) {
  const root = findRoot(startDir);
  if (!root) return { root: path.resolve(startDir), config: DEFAULTS, found: false };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    const profile = resolveProfile(raw?.profile);
    const config = deepMerge(deepMerge(DEFAULTS, profile.layer), raw);
    config.profile = profile.name; // an unknown name resolves to standard
    return { root, config, found: true };
  } catch (e) {
    process.stderr.write(`[agent-scaffold] ${CONFIG_FILE} unreadable (${e.message}); using defaults\n`);
    return { root, config: DEFAULTS, found: false };
  }
}

/** Repo entry whose path contains `filePath` (deepest match), or null. */
export function repoFor(root, config, filePath) {
  const abs = path.resolve(root, filePath);
  let best = null;
  for (const r of config.repos ?? []) {
    const rp = path.resolve(root, r.path || '.');
    const rel = path.relative(rp, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || rp.length > path.resolve(root, best.path || '.').length) best = r;
  }
  return best;
}

const SPECIALS = '.+^$()|[]\\';
const escapeRe = (s) => s.split('').map(ch => (SPECIALS.includes(ch) ? '\\' + ch : ch)).join('');

/** Tiny glob → RegExp (supports **, *, {a,b}). Enough for editCheck tables. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map(s => escapeRe(s));
      re += '(?:' + alts.join('|') + ')';
      i = end;
    } else if (SPECIALS.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
