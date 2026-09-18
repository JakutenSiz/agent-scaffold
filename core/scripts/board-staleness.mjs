#!/usr/bin/env node
/**
 * board-staleness — flags task-board items whose heading still looks OPEN
 * while the body already reads like the work is done.
 *
 * WHY: the usual failure mode is not the board's size, it is that whoever
 * finishes an item appends "done" evidence to the body but never flips the
 * open marker in the `###`/`####` heading. Tooling and other agents read the
 * heading first, so a finished item still looks open — and somebody repeats
 * the work.
 *
 * WHAT IT DOES: lists headings marked OPEN whose body contains
 * completion-looking phrases (config.board.doneSignals) net of
 * partial/still-open phrases (config.board.partialSignals). It hands down
 * NO VERDICT — it produces a suspects list; a human or the architect agent
 * decides (an item that says "web is live, mobile is still open" is
 * correctly still open).
 *
 * Emoji legend used across boards this tool understands (only the OPEN
 * markers below trigger scanning; the rest are informational statuses this
 * tool leaves alone):
 *   🔴 blocked   🟡 in progress   🔵 info/decision   🧪 experiment
 *   ⏸️ paused    ✅ done          🟢 shipped         🔬 research   ℹ️ note
 *
 * SUPPRESSION: a `## Staleness suppressions` section in the board can hold a
 * markdown table whose first column is a backtick-quoted item code that has
 * been manually reviewed and judged a persistent false positive. Those codes
 * are dropped from the default report. `--all` disables this suppression
 * (shows everything again).
 *
 * USAGE:
 *   node scripts/board-staleness.mjs
 *   node scripts/board-staleness.mjs --strict   # exit 1 if any suspects remain
 *   node scripts/board-staleness.mjs --all      # ignore the suppression list
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const strict = process.argv.includes('--strict');
const all = process.argv.includes('--all');
// Skip the CLI body when imported (e.g. by a test) -- it only runs when this
// file is executed directly (`node scripts/board-staleness.mjs`).
const runningDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const DEFAULT_DONE_SIGNALS = ['done', 'closed', 'live', 'deployed', 'merged', 'shipped', 'deploy ok'];
const DEFAULT_PARTIAL_SIGNALS = ['remaining', 'pending', 'awaiting', 'blocked', 'todo'];
const THRESHOLD = 2; // net (done-signal hits - partial-signal hits) needed for an OPEN heading to become a suspect

/**
 * Extracts the backtick-quoted item codes from the first column of the
 * markdown table under a `## Staleness suppressions` heading. Stops at the
 * next `## ` heading.
 * @param {string} boardText
 * @returns {string[]}
 */
export function readSuppressedCodes(boardText) {
  const lines = boardText.split('\n');
  let inside = false;
  const codes = [];
  for (const line of lines) {
    if (/^##\s+Staleness suppressions/i.test(line)) { inside = true; continue; }
    if (inside && /^##\s+/.test(line)) break;
    if (!inside) continue;
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (m) codes.push(m[1].trim());
  }
  return codes;
}

if (runningDirectly) {
  const { root, config, found } = loadConfig(SCRIPT_DIR);
  if (!found) {
    console.log('[agent-scaffold] agent-scaffold.config.json not found; board-staleness has nothing configured to check (fail-open).');
    process.exit(0);
  }

  const boardPath = path.join(root, config.board.file);
  if (!fs.existsSync(boardPath)) {
    console.error(`Board file not found: ${boardPath}`);
    process.exit(2);
  }

  const DONE_SIGNALS = (config.board.doneSignals && config.board.doneSignals.length ? config.board.doneSignals : DEFAULT_DONE_SIGNALS)
    .map((s) => s.toLowerCase());
  const PARTIAL_SIGNALS = (config.board.partialSignals && config.board.partialSignals.length ? config.board.partialSignals : DEFAULT_PARTIAL_SIGNALS)
    .map((s) => s.toLowerCase());

  const OPEN_MARK = /🔴|🟡/; // 🔴 blocked, 🟡 in progress
  const CLOSED_MARK = /✅|🟢|~~/; // already marked ✅ done / 🟢 shipped / struck through

  const boardText = fs.readFileSync(boardPath, 'utf-8');
  const suppressedCodes = new Set(all ? [] : readSuppressedCodes(boardText));

  const lines = boardText.split('\n');
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{3,4}\s/.test(l)) {
      if (cur) sections.push(cur);
      cur = { heading: l, line: i + 1, body: [] };
    } else if (cur) cur.body.push(l);
  }
  if (cur) sections.push(cur);

  const suspects = [];
  const suppressed = [];
  for (const s of sections) {
    if (!OPEN_MARK.test(s.heading)) continue;
    if (CLOSED_MARK.test(s.heading)) continue; // already marked closed in the heading, not our concern
    const body = s.body.join('\n');
    if (!body.trim()) continue;
    const bodyLower = body.toLowerCase();

    const doneFound = DONE_SIGNALS.filter((sig) => bodyLower.includes(sig));
    const partialFound = PARTIAL_SIGNALS.filter((sig) => bodyLower.includes(sig));
    const score = doneFound.length - partialFound.length;
    if (score < THRESHOLD) continue;

    const code = (s.heading.match(/^#{3,4}\s+(\S+)/) || [, '?'])[1];
    if (suppressedCodes.has(code)) { suppressed.push(code); continue; }
    suspects.push({ ...s, score, doneFound, partialFound, code });
  }

  suspects.sort((a, b) => b.score - a.score);

  function printSuppressionLine() {
    if (suppressed.length > 0) {
      console.log(`  Suppressed by "Staleness suppressions": ${suppressed.length} (${suppressed.join(', ')})\n`);
    }
  }

  console.log(`\nboard-staleness — scanned ${sections.length} heading(s)\n`);
  if (suspects.length === 0) {
    console.log('  No suspects: no OPEN heading had completion evidence in its body.\n');
    printSuppressionLine();
    process.exit(0);
  }

  console.log(`  ${suspects.length} SUSPECT item(s) — heading is OPEN but the body reads done:\n`);
  for (const s of suspects) {
    console.log(`  score ${String(s.score).padStart(2)} · line ${s.line} · ${s.code}`);
    console.log(`     ${s.heading.replace(/^#{3,4}\s*/, '').slice(0, 96)}`);
    console.log(`     evidence: ${s.doneFound.join(', ')}${s.partialFound.length ? `  (partial-signal hits: ${s.partialFound.join(', ')})` : ''}`);
    console.log('');
  }
  console.log('  This is NOT a verdict, it is a suspects list. For each one:');
  console.log('    git -C <repo> merge-base --is-ancestor <sha> origin/<deployBranch>   # exit 0 = already live');
  console.log('  If confirmed, update the HEADING too — adding a done mark to the body alone is not enough.\n');
  printSuppressionLine();

  process.exit(strict ? 1 : 0);
}
