#!/usr/bin/env node
// Map guardian — PreToolUse(Edit|Write). Two jobs:
// (1) JIT MAP: on the FIRST edit in a repo per (session, agent), inject that
//     repo's memory-bank/repoMap.md + a reuse-registry summary into context.
//     We do not assume the agent already read the map; we show it at the
//     decision moment instead.
// (2) REUSE-REGISTRY GATE: if the content being written matches a trigger in
//     memory-bank/reuse-registry.json, does not reference the canonical
//     piece, and the file itself is neither the canonical nor an exempt file
//     — DENY, use the existing piece instead.
//
// Measured (source project): PreToolUse additionalContext reaches the agent
// as a separate system message, including for subagents.
//
// Config-driven: the memory-bank directory name comes from
// config.memoryBank.dir (repoMap.md / reuse-registry.json filenames are
// fixed). Fails open (exit 0, no output) when this project has not
// installed the scaffold.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../scripts/lib/config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const ti = input.tool_input || {};
const file = String(ti.file_path || '');
if (!file) process.exit(0);
const content = String(ti.content ?? ti.new_string ?? '');

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

const MB_DIR = config.memoryBank.dir;

// Repo root = nearest ancestor dir containing <memoryBankDir>/repoMap.md.
let repoRoot = '';
let d = path.dirname(path.resolve(file));
for (let i = 0; i < 10; i++) {
  if (existsSync(path.join(d, MB_DIR, 'repoMap.md'))) {
    repoRoot = d;
    break;
  }
  const up = path.dirname(d);
  if (up === d) break;
  d = up;
}
if (!repoRoot) process.exit(0); // repo without a map (e.g. the umbrella root) — stay out of the way
const rel = path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');

const stateDir = path.join(root, '.claude', '.read-guard');
try {
  mkdirSync(stateDir, { recursive: true });
} catch {}
const sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '').slice(0, 64);
const agent = String(input.agent_id || 'main').replace(/[^\w-]/g, '').slice(0, 32);
const key = createHash('sha1').update(`${sid}|${agent}|${repoRoot}`).digest('hex').slice(0, 16);
const jitFile = path.join(stateDir, `jit-${key}`);

const output = (o) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
  process.exit(0);
};

let registry = null;
try {
  registry = JSON.parse(readFileSync(path.join(repoRoot, MB_DIR, 'reuse-registry.json'), 'utf8'));
} catch {}

// (2) Reuse-registry gate — code files only.
if (registry && /\.(tsx?|jsx?|mjs|cjs)$/.test(rel) && content) {
  let existing = '';
  try {
    existing = readFileSync(path.resolve(file), 'utf8');
  } catch {}
  const allContent = content + '\n' + existing;
  for (const e of registry.entries || []) {
    const canonical = e.canonical || [];
    if (canonical.some((c) => rel === c || rel.endsWith('/' + c))) continue; // the canonical file itself
    if ((e.exempt || []).some((g) => rel.includes(g))) continue;
    const trigger = (e.triggers || []).find((t) => content.includes(t));
    if (!trigger) continue;
    const names = canonical.map((c) => path.basename(c).replace(/\.[^.]+$/, ''));
    if (names.some((n) => allContent.includes(n))) continue; // already references the canonical piece
    output({
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[map-guardian] A CANONICAL piece for "${e.name}" already exists in this repo: ${canonical.join(', ')}` +
        (e.use ? ` (${e.use})` : '') +
        `. The content you are writing matches trigger "${trigger}" but does not reference the canonical piece — ` +
        'do NOT write a new one, import/adapt the existing one. If a genuinely new piece is needed, FIRST update ' +
        `${MB_DIR}/reuse-registry.json (new canonical or exempt entry), then write.`,
    });
  }
}

// (1) JIT map — once per (session, agent, repo).
if (!existsSync(jitFile)) {
  try {
    writeFileSync(jitFile, String(Date.now()));
  } catch {}
  let map = '';
  try {
    map = readFileSync(path.join(repoRoot, MB_DIR, 'repoMap.md'), 'utf8').split('\n').slice(0, 320).join('\n');
  } catch {}
  const registryNote =
    registry && registry.entries?.length
      ? `\n\nREUSABLE PIECES (${MB_DIR}/reuse-registry.json) — use these before writing a new one:\n` +
        registry.entries.map((e) => `- ${e.name}: ${(e.canonical || []).join(', ')}${e.use ? ' — ' + e.use : ''}`).join('\n')
      : '';
  output({
    additionalContext:
      `[map-guardian] This is your FIRST edit in '${path.basename(repoRoot)}' this session. Below is that repo's ` +
      `${MB_DIR}/repoMap.md — check here first for "does a file/piece for this already exist". Rules: record any new ` +
      'source file in repoMap.md (the push gate rejects a push whose new files cannot be found there); before ' +
      'writing a shared piece (component/helper), check the reuse registry below.' +
      registryNote +
      '\n\n--- repoMap.md ---\n' +
      map,
  });
}
process.exit(0);
