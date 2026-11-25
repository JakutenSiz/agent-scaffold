// Tests for the profile layer in core/scripts/lib/config.mjs (minimal | standard | strict).
// The `standard` profile must resolve to EXACTLY the pre-profile defaults (golden copy below,
// new keys excluded), the example config must not pin anything a profile manages, and every
// key of the example config must exist in DEFAULTS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from '../core/scripts/lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(root, 'core', 'agent-scaffold.config.example.json');
const READ_GUARD = path.join(root, 'core', '.claude', 'hooks', 'read-guard.mjs');
const BOARD_LINT = path.join(root, 'core', 'scripts', 'board-lint.mjs');

// Golden copy of DEFAULTS as they were before profiles existed.
const OLD_DEFAULTS = {
  version: 2,
  projectName: 'project',
  language: 'en',
  layout: 'single',
  humanGatekeeper: 'the project owner',
  humans: ['OWNER'],
  labels: { humanOnly: 'DEV', anyone: 'ANY' },
  repos: [{ name: 'app', path: '.', stack: 'unknown', checks: {}, editCheck: [], deployBranches: [], sourceExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'] }],
  board: {
    file: 'task-board.md', archive: 'task-board-archive.md',
    ceiling: 4000, ceilingBytes: 262144, maxLineChars: 4096,
    fields: { remaining: 'Remaining', lastEvidence: 'Last evidence', decision: 'Decision/blocker', trap: 'Trap', history: 'Full history', humanStep: 'Human step' },
    lint: { mode: 'warn', escapeEnv: 'BOARD_LINT' },
    humanStepExpiryWeeks: 4,
  },
  coordination: { file: 'coordination.md', archive: 'coordination-archive.md', ceiling: 1200, ceilingBytes: 131072, staleClaimDays: 7 },
  memoryBank: { dir: 'memory-bank', ceiling: 800, ceilingBytes: 65536, maxLineChars: 2048, windowDays: 14, mapBudgetBytes: 8000, pendingPhrases: ['pending', 'awaiting', 'waiting for', 'blocked'] },
  docs: { reports: 'reports', specs: 'specs', workingRules: 'docs/agent-working-rules.md', memoryBankGuide: 'docs/memory-bank-guide.md', memoryBankSchema: 'docs/memory-bank-schema.json', toolTraps: 'docs/tool-traps.md' },
  delegation: {
    warnAfterReads: 5, denyAfterReads: 10, countShell: true, warnAfterEdits: 15, denyAfterEdits: 0,
    subagents: { scout: 'scout', analyst: 'analyst', worker: 'worker', verifier: 'verifier' },
  },
  session: {
    autoPull: true, autoPullRepos: true, ensureHooksPath: true, staleDocHours: 24, linesBudgetMs: 25000, skills: [],
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
    hygiene: { autoClean: false, branchMinAgeHours: 24, worktreeMinAgeHours: 6, staleStashDays: 14, worktreeDebtAsk: 5, ignoreFile: 'scripts/git-hygiene-ignore.json' },
  },
  preCommit: { checks: [] },
  pushGate: { maxBlobMB: 2, bigBlobMode: 'warn', bigBlobEnv: 'BIG_FILE_OK', requireHooksPath: true },
  testRunner: { processName: 'chrome-headless-shell', maxWorkers: 2, maxProcesses: 8, triggerPattern: 'playwright|e2e' },
  orphans: { pattern: 'node --test', maxAgeMinutes: 60, maxRssMB: 4096 },
  codex: { riskyPatterns: [] },
  secretScan: { tool: 'gitleaks', failClosed: true, skipEnv: 'SKIP_PUSH_GATE' },
};

// Dotted paths of keys added together with profiles (excluded from the golden comparison).
const NEW_KEYS = [
  'profile', 'secrets', 'doneGate', 'handoff',
  'git.hygiene.equivalentMerge',
  'memoryBank.reuseGate', 'pushGate.mapGate', 'pushGate.confirm', 'coordination.checkMode',
];

const clone = (o) => JSON.parse(JSON.stringify(o));
function stripNew(config) {
  const c = clone(config);
  for (const p of NEW_KEYS) {
    const parts = p.split('.');
    let o = c;
    for (const k of parts.slice(0, -1)) o = o?.[k];
    if (o) delete o[parts[parts.length - 1]];
  }
  return c;
}
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

function project(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfgprof-')));
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  return dir;
}
const resolved = (config) => {
  const dir = project(config);
  try { return cfg.loadConfig(dir).config; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

// Profile table from the spec: [dotted key, minimal, standard, strict].
const TABLE = [
  ['board.lint.mode', 'off', 'warn', 'block'],
  ['pushGate.bigBlobMode', 'warn', 'warn', 'block'],
  ['pushGate.maxBlobMB', 10, 2, 1],
  ['delegation.denyAfterReads', 0, 10, 6],
  ['delegation.warnAfterReads', 8, 5, 3],
  ['delegation.denyAfterEdits', 0, 0, 25],
  ['delegation.warnAfterEdits', 30, 15, 10],
  ['session.context.warnTokens', 600000, 300000, 200000],
  ['git.hygiene.worktreeDebtAsk', 20, 5, 2],
  ['pushGate.confirm', 'off', 'ask', 'ask'],
  ['pushGate.mapGate', 'off', 'block', 'block'],
  ['pushGate.requireHooksPath', false, true, true],
  ['memoryBank.reuseGate', 'off', 'block', 'block'],
  ['coordination.checkMode', 'warn', 'block', 'block'],
  ['testRunner.maxWorkers', 4, 2, 1],
  ['doneGate.mode', 'off', 'block', 'block'],
];

// ---------------------------------------------------------------- standard == old defaults

test('standard profile resolves to the pre-profile defaults (deep equal, new keys excluded)', () => {
  assert.deepEqual(stripNew(resolved({ profile: 'standard' })), OLD_DEFAULTS);
});

test('no profile key behaves as standard', () => {
  assert.deepEqual(stripNew(resolved({})), OLD_DEFAULTS);
  assert.equal(resolved({}).profile, 'standard');
});

test('DEFAULTS themselves are the standard profile', () => {
  assert.deepEqual(stripNew(cfg.DEFAULTS), OLD_DEFAULTS);
  assert.equal(cfg.DEFAULTS.profile, 'standard');
});

test('new mode keys default to today\'s behaviour', () => {
  const c = resolved({});
  assert.equal(c.memoryBank.reuseGate, 'block');
  assert.equal(c.pushGate.mapGate, 'block');
  assert.equal(c.pushGate.confirm, 'ask');
  assert.equal(c.coordination.checkMode, 'block');
});

test('config base keys: secrets, doneGate, equivalentMerge, handoff', () => {
  const c = resolved({});
  assert.equal(c.secrets.mode, 'block');
  assert.ok(Array.isArray(c.secrets.protectedPaths));
  assert.deepEqual(c.secrets.allow, ['.env.example', '.env.sample', '.env.template', '**/*.pub']);
  for (const p of ['.env', '.env.*', '**/*.pem', '**/*.key', '**/.ssh/**', '**/credentials*.json']) {
    assert.ok(c.secrets.protectedPaths.includes(p), `protectedPaths has ${p}`);
  }
  assert.deepEqual(c.doneGate, { command: '', timeoutSec: 900, mode: 'block', exempt: [] });
  assert.equal(c.git.hygiene.equivalentMerge, 'off');
  assert.deepEqual(c.handoff, { dir: 'handoffs', budgetBytes: 8192 });
});

// ---------------------------------------------------------------- profile values

for (const [i, name] of [[1, 'minimal'], [2, 'standard'], [3, 'strict']]) {
  test(`${name} profile pins the spec values`, () => {
    const c = resolved({ profile: name });
    assert.equal(c.profile, name);
    for (const row of TABLE) assert.equal(get(c, row[0]), row[i], `${name}: ${row[0]}`);
  });
}

test('every profile keeps the fixed safety settings', () => {
  for (const name of ['minimal', 'standard', 'strict']) {
    const c = resolved({ profile: name });
    assert.equal(c.secretScan.failClosed, true, name);
    assert.equal(c.secrets.mode, 'block', name);
  }
});

test('PROFILES contain no arrays (deepMerge would replace them wholesale)', () => {
  const walk = (o, where) => {
    for (const [k, v] of Object.entries(o)) {
      assert.ok(!Array.isArray(v), `array at ${where}.${k}`);
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
    }
  };
  for (const [n, layer] of Object.entries(cfg.PROFILES)) walk(layer, n);
});

test('the user config beats the profile', () => {
  const c = resolved({ profile: 'strict', board: { lint: { mode: 'warn' } }, delegation: { denyAfterReads: 99 } });
  assert.equal(c.board.lint.mode, 'warn');
  assert.equal(c.delegation.denyAfterReads, 99);
  assert.equal(c.delegation.warnAfterReads, 3); // untouched profile value
});

test('resolveProfile: known names resolve, unknown warns on stderr and falls back to standard', () => {
  assert.equal(cfg.resolveProfile('strict').name, 'strict');
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  let r;
  try { r = cfg.resolveProfile('paranoid'); } finally { process.stderr.write = orig; }
  assert.equal(r.name, 'standard');
  assert.match(lines.join(''), /paranoid/);
});

test('loadConfig with an unknown profile warns and equals standard', () => {
  const dir = project({ profile: 'nonsense' });
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  let c;
  try { c = cfg.loadConfig(dir).config; } finally { process.stderr.write = orig; fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(lines.join(''), /nonsense/);
  assert.equal(c.profile, 'standard');
  assert.deepEqual(stripNew(c), OLD_DEFAULTS);
});

// ---------------------------------------------------------------- example config

function leafPaths(o, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('$comment')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

test('example config is valid JSON and selects the standard profile', () => {
  const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.equal(ex.profile, 'standard');
});

test('example config does not pin any key a profile manages', () => {
  const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const exPaths = new Set(leafPaths(ex));
  const managed = new Set(TABLE.map((r) => r[0]));
  for (const layer of Object.values(cfg.PROFILES)) for (const p of leafPaths(layer)) managed.add(p);
  for (const p of managed) assert.ok(!exPaths.has(p), `example pins profile-managed key ${p}`);
});

test('every key of the example config is defined in DEFAULTS', () => {
  const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  // Optional lists with an in-code fallback (board-format.mjs); documented in the example only.
  const optional = new Set(['board.doneSignals', 'board.partialSignals']);
  for (const p of leafPaths(ex)) {
    if (optional.has(p)) continue;
    assert.notEqual(get(cfg.DEFAULTS, p), undefined, `example key ${p} missing in DEFAULTS`);
  }
});

// ---------------------------------------------------------------- consumers

test('board lint: strict blocks a violation, standard warns, minimal is off', () => {
  const oldBoard = '# Board\n\n## Open items\n\n';
  const item = '### 0101-a 🔴 [DEV] Item a\n**Remaining:** build it\n**Last evidence:** 2026-01-01 abc1234\n';
  const newBoard = `${oldBoard}${item}\n${item.replace('Item a', 'twin')}\n`; // duplicate code = L3 error
  const run = (profile) => {
    const dir = project({ profile });
    try {
      fs.writeFileSync(path.join(dir, 'old.md'), oldBoard);
      fs.writeFileSync(path.join(dir, 'new.md'), newBoard);
      return spawnSync(process.execPath, [BOARD_LINT, '--root', dir, '--files', path.join(dir, 'old.md'), path.join(dir, 'new.md')],
        { encoding: 'utf8', env: { ...process.env, BOARD_LINT: '' } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  assert.equal(run('strict').status, 1);
  assert.equal(run('standard').status, 0);
  const m = run('minimal');
  assert.equal(m.status, 0);
  assert.equal(m.stdout.trim(), '');
});

test('recursion gate stays on in the minimal profile', () => {
  const dir = project({ profile: 'minimal' });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgprof-state-'));
  try {
    const r = spawnSync(process.execPath, [READ_GUARD, 'pre'], {
      input: JSON.stringify({ cwd: dir, session_id: 'sid-prof', agent_id: 'a1', tool_name: 'Agent', tool_input: {} }),
      encoding: 'utf8', env: { ...process.env, READ_GUARD_STATE_DIR: state },
    });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
