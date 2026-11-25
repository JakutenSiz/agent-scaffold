#!/usr/bin/env node
// Enforces: R-23
/**
 * board-duplicate - the duplicate check to run BEFORE opening a new board item.
 *
 * WHY: the manual three-step ritual (recent commits, grep the board and its archive, is the
 * code free) was slow and inconsistent, and two sessions kept writing the same finding.
 * One command prints four blocks and a verdict.
 *
 * WHAT IT PRINTS: (1) the last commits plus a warning for any board commit in the last
 * `--minutes`; (2) lines in the board, the archive and any `<archive-stem>-*.md` part that
 * match a keyword, with the nearest heading; (3) whether a given code is free, or the next
 * code suggestion `<MMDD>-<slug>`; (4) a verdict. The verdict is information, not a decision.
 *
 * USAGE:
 *   node scripts/board-duplicate.mjs "<keyword>" ["<keyword 2>" ...] [--code <code>] [--minutes 90]
 *
 * EXIT CODES: always 0, except a call without arguments (prints usage, exit 2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { escapeRegExp, pad2 } from './lib/board-format.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MINUTES = 90;
const MAX_HITS_PER_FILE = 15;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const words = [];
  let code = null;
  let minutes = DEFAULT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--code') { code = argv[++i] ?? null; continue; }
    if (a === '--minutes') { minutes = Number(argv[++i]); if (!Number.isFinite(minutes) || minutes <= 0) minutes = DEFAULT_MINUTES; continue; }
    if (a === '--root') { i++; continue; }
    words.push(a);
  }
  return { words, code, minutes };
}

/** Case-insensitive containment (locale-aware lowercasing). */
export function lineMatches(line, word) {
  return line.toLowerCase().includes(word.toLowerCase());
}

/**
 * Lines matching ANY keyword, each with the nearest preceding `#`..`######` heading.
 * At most 15 hits per file.
 */
export function searchFile(fileName, text, words) {
  const lines = text.split(/\r?\n/);
  let heading = null;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#{1,6}\s*/, '').trim();
    if (words.some((w) => lineMatches(line, w))) {
      hits.push({ file: fileName, line: i + 1, heading, excerpt: line.slice(0, 120) });
      if (hits.length >= MAX_HITS_PER_FILE) break;
    }
  }
  return hits;
}

/** Is there a `### <code>` heading (`ab1` does not match `ab10`)? */
export function codeTaken(boardText, code) {
  const re = new RegExp(`^###\\s+${escapeRegExp(code)}(?![A-Za-z0-9_-])`);
  const lines = boardText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return { taken: true, line: i + 1 };
  return { taken: false, line: null };
}

/** Lowercase ASCII slug of a keyword (accents folded, other characters become `-`). */
export function slugify(word) {
  return word.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `MMDD` of a date - the first part of a new item code. */
export function monthDay(date = new Date()) {
  return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

/** Lines of `git log --format=%h|%ct|%s` -> "N min ago" warning lines. */
export function recentCommitWarnings(lines, nowSeconds, boardName = 'board') {
  return lines.filter(Boolean).map((s) => {
    const [h, ct, ...rest] = s.split('|');
    const minutes = Math.max(0, Math.round((nowSeconds - Number(ct)) / 60));
    return `! ${boardName} commit ${minutes} min ago: ${h} ${rest.join('|')}`;
  });
}

/** Runs git safely; null when git or the repository is unavailable. */
export function gitSafe(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

function readOrNull(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

function main() {
  const argv = process.argv.slice(2);
  if (parseArgs(argv).words.length === 0) {
    console.log('Usage: node scripts/board-duplicate.mjs "<keyword>" ["<keyword 2>" ...] [--code <code>] [--minutes 90]');
    return 2;
  }
  const rootArg = argv.indexOf('--root');
  const { root, config } = loadConfig(rootArg >= 0 ? argv[rootArg + 1] : SCRIPT_DIR);
  const { words, code, minutes } = parseArgs(argv);
  const boardName = config.board.file;
  const archiveName = config.board.archive;

  console.log('1) Recent commits:');
  const recent = gitSafe(['log', '-5', '--format=%h %ci %s'], root);
  if (recent === null) console.log('  (git log unavailable - no git or not a repository)');
  else for (const l of recent.split(/\r?\n/).filter(Boolean)) console.log(`  ${l}`);
  const boardCommits = gitSafe(['log', `--since=${minutes} minutes ago`, '--format=%h|%ct|%s', '--', boardName], root);
  let recentBoardCommit = false;
  if (boardCommits !== null) {
    for (const w of recentCommitWarnings(boardCommits.split(/\r?\n/), Math.floor(Date.now() / 1000), boardName)) { console.log(`  ${w}`); recentBoardCommit = true; }
  }
  console.log('');

  console.log('2) Board matches:');
  let total = 0;
  const stem = path.basename(archiveName, path.extname(archiveName));
  let parts = [];
  try {
    parts = fs.readdirSync(path.dirname(path.resolve(root, archiveName)))
      .filter((n) => n.startsWith(stem + '-') && n.endsWith('.md')).sort();
  } catch { parts = []; }
  const archiveDir = path.dirname(archiveName);
  const partPaths = parts.map((n) => (archiveDir === '.' ? n : path.join(archiveDir, n)));
  for (const name of [boardName, archiveName, ...partPaths]) {
    const text = readOrNull(path.resolve(root, name));
    if (text === null) { console.log(`  ${name}: unreadable, skipped`); continue; }
    const hits = searchFile(name, text, words);
    total += hits.length;
    if (!hits.length) { console.log(`  ${name}: no match`); continue; }
    for (const h of hits) console.log(`  ${h.file}:${h.line}  [${(h.heading ?? '').slice(0, 80)}]  ${h.excerpt}`);
  }
  console.log('');

  console.log('3) Code:');
  const boardText = readOrNull(path.resolve(root, boardName)) ?? '';
  if (code) {
    const { taken, line } = codeTaken(boardText, code);
    console.log(`  ${code} -> ${taken ? `CODE TAKEN (line ${line})` : 'CODE FREE'}`);
  } else {
    console.log(`  Suggested new item code: ${monthDay()}-${slugify(words[0] ?? '')}`);
  }
  console.log('');

  if (total > 0 || recentBoardCommit) console.log('VERDICT: MAY BE A DUPLICATE - read the matches above; a `↪ DUPLICATE` mark may be needed');
  else console.log('VERDICT: no match, a new item can be opened');
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`board-duplicate: ${e.message}\n`); process.exitCode = 0; } // information only
}
