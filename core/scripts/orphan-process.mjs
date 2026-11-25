#!/usr/bin/env node
// Enforces: R-42
// Orphan test-process finder.
//
// WHY: a hung test runner parent once sat on 13 GB of memory for hours, and stuck runs pile up
// across sessions until the machine chokes. This script finds processes whose command line
// matches config.orphans.pattern (a regex; default "node --test") AND that are either older than
// config.orphans.maxAgeMinutes (default 60) or larger than config.orphans.maxRssMB (default 4096).
//
// USAGE: node scripts/orphan-process.mjs [--minutes N] [--rss-mb N] [--line] [--kill]
//   (default)   list candidates, change nothing
//   --line      one-line summary for the SessionStart note; prints NOTHING when there are none
//   --kill      send SIGKILL to the candidates. Before each kill the process info is written to
//               .claude/.orphans/<timestamp>.json as evidence. Killing is for a human or an
//               explicit instruction ONLY - never wire --kill to a hook.
//   --minutes / --rss-mb override the config thresholds for this run.
// On Windows the script silently reports nothing (it relies on `ps`). The script itself and its
// parent are never candidates.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const DEFAULT_PATTERN = 'node --test';
export const DEFAULT_MAX_AGE_MINUTES = 60;
export const DEFAULT_MAX_RSS_MB = 4096;

/** `[[dd-]hh:]mm:ss` -> minutes (fractional); unrecognised format -> 0. */
export function etimeMinutes(str) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(str ?? '').trim());
  if (!m) return 0;
  const [, d = 0, h = 0, mm, ss] = m;
  return Number(d) * 1440 + Number(h) * 60 + Number(mm) + Number(ss) / 60;
}

/** `ps -axo pid=,ppid=,etime=,rss=,command=` output -> [{pid, ppid, minutes, rssKb, command}] */
export function parsePs(out) {
  const list = [];
  for (const line of String(out ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), minutes: etimeMinutes(m[3]), rssKb: Number(m[4]), command: m[5] });
  }
  return list;
}

/** Compile config.orphans.pattern; an invalid regex falls back to the default pattern. */
export function compilePattern(pattern) {
  try { return new RegExp(String(pattern || DEFAULT_PATTERN)); } catch { return new RegExp(DEFAULT_PATTERN); }
}

/** Does this process match the pattern and exceed the age or memory threshold? The script itself is never a target. */
export function isOrphan({ command, minutes, rssKb = 0 }, { pattern, maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES, maxRssMB = DEFAULT_MAX_RSS_MB }) {
  const c = String(command ?? '');
  if (/orphan-process/.test(c)) return false;
  if (!(pattern instanceof RegExp ? pattern : compilePattern(pattern)).test(c)) return false;
  return minutes > maxAgeMinutes || rssKb > maxRssMB * 1024;
}

/** Pure decision: ps output -> candidates (excluding protected pids). */
export function findOrphans(psOut, opts, protectedPids = []) {
  const skip = new Set(protectedPids);
  return parsePs(psOut).filter((s) => !skip.has(s.pid) && isOrphan(s, opts));
}

export function summaryLine(list, { maxRssMB = DEFAULT_MAX_RSS_MB } = {}) {
  if (!list.length) return '';
  const oldestH = Math.max(...list.map((s) => s.minutes)) / 60;
  const mb = Math.round(list.reduce((t, s) => t + s.rssKb, 0) / 1024);
  const big = list.filter((s) => s.rssKb > maxRssMB * 1024).length;
  return `orphan test processes: ${list.length} (oldest ${oldestH.toFixed(1)} h, ~${mb} MB rss total${big ? `, ${big} over ${maxRssMB} MB` : ''})`;
}

/** Write the evidence file BEFORE killing. Returns the file path. */
export function writeEvidence(list, { dir, now = new Date() }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ at: now.toISOString(), processes: list }, null, 2) + '\n');
  return file;
}

function numArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && Number(argv[i + 1]) > 0 ? Number(argv[i + 1]) : null;
}

function main(argv) {
  if (process.platform === 'win32') return; // no ps: silently nothing
  const { root, config } = loadConfig(process.cwd());
  const oc = config.orphans ?? {};
  const opts = {
    pattern: compilePattern(oc.pattern),
    maxAgeMinutes: numArg(argv, '--minutes') ?? oc.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES,
    maxRssMB: numArg(argv, '--rss-mb') ?? oc.maxRssMB ?? DEFAULT_MAX_RSS_MB,
  };
  let psOut;
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,rss=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return; // ps unavailable: fail open
  }
  const targets = findOrphans(psOut, opts, [process.pid, process.ppid]);
  if (argv.includes('--kill')) {
    if (!targets.length) return console.log('orphan test processes: 0');
    const file = writeEvidence(targets, { dir: path.join(root, '.claude', '.orphans') });
    let killed = 0;
    for (const s of targets) {
      try { process.kill(s.pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
    }
    return console.log(`orphan test processes: ${killed} killed (evidence: ${path.relative(root, file)})`);
  }
  if (argv.includes('--line')) {
    const line = summaryLine(targets, opts);
    if (line) console.log(line);
    return;
  }
  console.log(targets.length ? summaryLine(targets, opts) : 'orphan test processes: 0');
  for (const s of targets) console.log(`  pid ${s.pid} ppid ${s.ppid} ${(s.minutes / 60).toFixed(1)} h ${Math.round(s.rssKb / 1024)} MB  ${s.command.slice(0, 120)}`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
