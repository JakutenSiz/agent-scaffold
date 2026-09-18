// Shared config loader for agent-scaffold hooks and scripts.
// Walks up from `startDir` (default: cwd) to find agent-scaffold.config.json.
// Never throws on a missing file: returns { root, config: DEFAULTS, found: false }
// so every hook/script stays fail-open when the scaffold is not installed.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'agent-scaffold.config.json';

export const DEFAULTS = {
  version: 1,
  projectName: 'project',
  language: 'en',
  layout: 'single',
  humanGatekeeper: 'the project owner',
  labels: { humanOnly: 'DEV', anyone: 'ANY' },
  repos: [{ name: 'app', path: '.', stack: 'unknown', checks: {}, editCheck: [], deployBranches: [], sourceExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'] }],
  board: { file: 'task-board.md', archive: 'task-board-archive.md', ceiling: 4000 },
  coordination: { file: 'coordination.md', archive: 'coordination-archive.md', ceiling: 1200 },
  memoryBank: { dir: 'memory-bank', ceiling: 800, windowDays: 14, pendingPhrases: ['pending', 'awaiting', 'waiting for', 'blocked'] },
  docs: { reports: 'reports', specs: 'specs', workingRules: 'docs/agent-working-rules.md', memoryBankGuide: 'docs/memory-bank-guide.md' },
  delegation: { warnAfterReads: 5, denyAfterReads: 10, subagents: { scout: 'scout', worker: 'worker', verifier: 'verifier' } },
  session: { autoPull: true, skills: [] },
  testRunner: { processName: 'chrome-headless-shell', maxWorkers: 2, maxProcesses: 8, triggerPattern: 'playwright|e2e' },
  secretScan: { tool: 'gitleaks', failClosed: true, skipEnv: 'SKIP_PUSH_GATE' },
};

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
    return { root, config: deepMerge(DEFAULTS, raw), found: true };
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
