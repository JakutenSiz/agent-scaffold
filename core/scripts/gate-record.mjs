#!/usr/bin/env node
/**
 * gate-record - runs config.doneGate.command for the CURRENT code state and records the result,
 * so scripts/done-gate.mjs can verify it when an item is closed.
 *
 * USAGE: node scripts/gate-record.mjs [--root <dir>]
 *
 * Refuses (exit 1, nothing written) when, outside the exempt paths, the working tree differs
 * from the index (modified, deleted or untracked files): the result would describe code that
 * is not what gets committed. Stage or commit the code first. See done-gate.mjs for the code
 * id, the exempt paths and the record format.
 *
 * The command runs with cwd = config root, with git's hook variables scrubbed, and is killed
 * after config.doneGate.timeoutSec (default 900). A timeout or a non-zero exit is RED: the
 * record is written with that exit code (124 on timeout) and this script exits 1.
 * Empty command -> nothing to record (exit 0).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { scrubGitEnv } from './lib/worktree-check.mjs';
import { computeCodeId, exemptMatcher, recordDir, recordPath } from './done-gate.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function gitLines(root, args, env) {
  const r = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** Non-exempt paths where the working tree differs from the index (modified, deleted, untracked). */
export function dirtyPaths(root, config, env = scrubGitEnv()) {
  const isExempt = exemptMatcher(config);
  const changed = gitLines(root, ['diff', '--name-only', '-z', '--no-renames'], env);
  const untracked = gitLines(root, ['ls-files', '--others', '--exclude-standard', '-z'], env);
  return [...new Set([...changed, ...untracked])].filter((p) => !isExempt(p));
}

function main() {
  const argv = process.argv.slice(2);
  const rootArg = argv.indexOf('--root');
  const { root, config, found } = loadConfig(rootArg >= 0 ? argv[rootArg + 1] : SCRIPT_DIR);
  const gate = config.doneGate ?? {};
  if (!found || !gate.command) { console.log('gate-record: no doneGate.command configured - nothing to record.'); return 0; }

  const env = scrubGitEnv();
  const dirty = dirtyPaths(root, config, env);
  if (dirty.length) {
    console.error(`gate-record: refused - the working tree differs from the index outside the exempt paths (${dirty.length} file(s)):`);
    for (const p of dirty.slice(0, 20)) console.error(`  ${p}`);
    console.error('Stage or commit the code first, then record again.');
    return 1;
  }

  const codeId = computeCodeId(root, config, env);
  const timeoutSec = Number(gate.timeoutSec) > 0 ? Number(gate.timeoutSec) : 900;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const r = spawnSync(gate.command, { cwd: root, shell: true, env, stdio: 'inherit', windowsHide: true, timeout: timeoutSec * 1000, killSignal: 'SIGKILL' });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const exit = timedOut ? 124 : (typeof r.status === 'number' ? r.status : 1);
  const durationMs = Date.now() - t0;

  fs.mkdirSync(recordDir(root, env), { recursive: true });
  fs.writeFileSync(recordPath(root, codeId, env), JSON.stringify({ codeId, command: gate.command, exit, startedAt, durationMs }, null, 2) + '\n');
  if (exit === 0) { console.log(`gate-record: green (${durationMs} ms), recorded for code ${codeId.slice(0, 12)}.`); return 0; }
  console.error(`gate-record: RED (${timedOut ? `timed out after ${timeoutSec}s` : `exit ${exit}`}); recorded - the item cannot be closed on this code.`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`gate-record: ${e.message}\n`); process.exitCode = 1; }
}
