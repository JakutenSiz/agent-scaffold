#!/usr/bin/env node
// Post-edit check — PostToolUse(Edit|Write) hook (async, rewake).
//
// Config-driven: for the repo owning the edited file (config.repos[], via
// scripts/lib/config.mjs `repoFor`), the FIRST entry in that repo's
// editCheck[] whose glob matches the file's repo-relative path runs.
// `{file}` expands to the absolute file path, `{repo}` to the absolute repo
// path. `serialize: true` entries are de-duplicated with a lock file (only
// one run in flight per repo+glob; an edit arriving while it runs is
// silently skipped — the next edit re-triggers).
//
// A failing check exits 2 so the hook infrastructure wakes the agent back up
// with the error. Fails open (exit 0, no output) when this project has not
// installed the scaffold.
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, repoFor, globToRegExp } from '../../scripts/lib/config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = input?.tool_input?.file_path || input?.tool_response?.filePath || '';
if (!file) process.exit(0);

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

const absFile = path.resolve(file);
const repo = repoFor(root, config, absFile);
if (!repo) process.exit(0);

const repoAbs = path.resolve(root, repo.path || '.');
const rel = path.relative(repoAbs, absFile).split(path.sep).join('/');
if (rel.startsWith('..')) process.exit(0);

const entry = (repo.editCheck || []).find((e) => e.glob && globToRegExp(e.glob).test(rel));
if (!entry || !entry.command) process.exit(0);

const command = entry.command.replaceAll('{file}', `"${absFile}"`).replaceAll('{repo}', `"${repoAbs}"`);

const SERIALIZE_STALE_MS = 175000; // slightly under the 180s hook timeout
const SERIALIZE_TIMEOUT_MS = 170000;
const DEFAULT_TIMEOUT_MS = 15000;

function runSerialized() {
  const lockDir = path.join(root, '.claude');
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch {}
  const lockKey = createHash('sha1').update(`${repo.name || repo.path}|${entry.glob}`).digest('hex').slice(0, 12);
  const lock = path.join(lockDir, `.edit-check-${lockKey}.lock`);
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < SERIALIZE_STALE_MS) return null; // another run in flight
  } catch {}
  try {
    writeFileSync(lock, String(process.pid));
  } catch {}
  try {
    return spawnSync(command, { cwd: repoAbs, shell: true, encoding: 'utf8', timeout: SERIALIZE_TIMEOUT_MS });
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

let result;
if (entry.serialize) {
  result = runSerialized();
  if (result === null) process.exit(0); // skipped — another run already in flight
} else {
  result = spawnSync(command, { cwd: repoAbs, shell: true, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS });
}

if (result && result.status !== 0 && result.status !== null) {
  const out = ((result.stdout || '') + (result.stderr || '')).split('\n').slice(0, 40).join('\n');
  process.stderr.write(`edit-check FAILED (${rel}): ${command}\n${out}`);
  process.exit(2);
}
process.exit(0);
