#!/usr/bin/env node
// Enforces: R-48
/**
 * done-gate - a task may only be closed (heading flipped to done) when the configured gate
 * command has really run green on the code being committed.
 *
 * WHY: an agent can write "done" on the board without ever running the gate. This check makes
 * the claim verifiable: closing an item requires a RECORD, written by scripts/gate-record.mjs,
 * that says "config.doneGate.command exited 0 on exactly this code state".
 *
 * DESIGN (record based - the command does NOT run at commit time):
 *   code id   sha256 of `git ls-files -s` with the exempt paths removed. It is a hash of the
 *             staged CONTENT, not a commit sha, so a board-only commit does not stale the record.
 *   exempt    board, board archive, coordination file and archive, memory-bank dir, reports and
 *             specs dirs, handoff.dir, `.agent-scaffold/`, plus config.doneGate.exempt
 *             (entries without a wildcard match the path itself and everything below it).
 *   record    <git-common-dir>/agent-scaffold/gate-<codeId>.json
 *             { codeId, command, exit, startedAt, durationMs }
 *   flow      stage or commit the code -> node scripts/gate-record.mjs -> flip the item to done
 *             on the board -> commit. If the code changes after the record, record again.
 *
 * USAGE: node scripts/done-gate.mjs --staged [--root <dir>]
 *
 * CONFIG config.doneGate: { command, timeoutSec, mode: block | warn | off, exempt: [] }
 *   command empty -> the gate does not exist (exit 0, no output).
 *   mode `block` exits 1 on a missing / red / stale / foreign record; `warn` prints the same
 *   message and exits 0; `off` does nothing.
 * Only the done heading counts (board-lint doneTransitions); `live` and done -> done do not.
 * Escape (pre-commit): PRE_COMMIT_SKIP_DONE_GATE=1 - say why in the commit message.
 * Fail-open: no config, no board in the index, any internal error -> exit 0.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { boardFormat } from './lib/board-format.mjs';
import { doneTransitions } from './board-lint.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const norm = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');

function git(root, args, env = process.env) {
  return execFileSync('git', ['-C', root, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
}

/** Paths whose changes never invalidate a gate record. */
export function exemptEntries(config) {
  return [
    config.board?.file, config.board?.archive, config.coordination?.file, config.coordination?.archive,
    config.memoryBank?.dir, config.docs?.reports, config.docs?.specs, config.handoff?.dir,
    '.agent-scaffold', ...(config.doneGate?.exempt ?? []),
  ].filter(Boolean).map(norm);
}

/** Returns isExempt(path): true when the repo-relative path is covered by the exempt entries. */
export function exemptMatcher(config) {
  const entries = exemptEntries(config).map((e) => ({
    e, re: /[*{]/.test(e) ? globToRegExp(e) : null,
  }));
  return (file) => {
    const f = norm(file);
    return entries.some(({ e, re }) => (re ? re.test(f) : f === e || f.startsWith(e + '/')));
  };
}

/** sha256 of the exempt-filtered `git ls-files -s` (the index; inside a hook that is the commit's index). */
export function computeCodeId(root, config, env = process.env) {
  const isExempt = exemptMatcher(config);
  const lines = git(root, ['ls-files', '-s', '-z'], env).split('\0').filter(Boolean)
    .filter((l) => !isExempt(l.slice(l.indexOf('\t') + 1)));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Directory holding the gate records (shared by all worktrees of the repo). */
export function recordDir(root, env = process.env) {
  const common = git(root, ['rev-parse', '--git-common-dir'], env).trim();
  return path.join(path.resolve(root, common), 'agent-scaffold');
}

export const recordPath = (root, codeId, env = process.env) => path.join(recordDir(root, env), `gate-${codeId}.json`);

/** The record counts only when codeId and command match and the command exited 0. */
export function recordIsGreen(file, codeId, command) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec.codeId === codeId && rec.command === command && rec.exit === 0;
  } catch { return false; }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--staged')) { console.error('usage: done-gate.mjs --staged [--root <dir>]'); return 2; }
  const rootArg = argv.indexOf('--root');
  const { root, config, found } = loadConfig(rootArg >= 0 ? argv[rootArg + 1] : SCRIPT_DIR);
  if (!found) return 0;
  const gate = config.doneGate ?? {};
  if (!gate.command || gate.mode === 'off') return 0;

  const rel = norm(config.board.file);
  let newText = '';
  try { newText = git(root, ['show', `:./${rel}`]); } catch { return 0; } // board not in the index
  let oldText = '';
  try { oldText = git(root, ['show', `HEAD:./${rel}`]); } catch { /* first commit */ }
  const closed = doneTransitions(oldText, newText, boardFormat(config));
  if (!closed.length) return 0;

  const codeId = computeCodeId(root, config);
  if (recordIsGreen(recordPath(root, codeId), codeId, gate.command)) return 0;

  const blocking = gate.mode !== 'warn';
  console.log([
    `done-gate: ${closed.join(', ')} closed without a green gate record for this code state (mode: ${blocking ? 'block' : 'warn'}).`,
    `  run:  node scripts/gate-record.mjs      (runs: ${gate.command})`,
    '  then flip the item again and commit. Code staged since the last record needs a new record.',
  ].join('\n'));
  return blocking ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`done-gate: ${e.message}\n`); process.exitCode = 0; } // fail-open on internal errors
}
