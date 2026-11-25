#!/usr/bin/env node
// Enforces: R-25
/**
 * coordination-archive -- moves finished work out of the coordination file.
 *
 * WHY: a claim table drifts. In one measurement 7 of 10 rows already said "done" but had never
 * been moved, and the protocol gave three different closing recipes. The rule now is: the
 * `## Active claims` table is the ONLY claim mechanism; closing = writing `✅ DONE <date>` at the
 * start of the row's State cell; moving the row is this script's job; the commit gate stops a
 * commit that still carries a closed row.
 *
 * WHAT IT MOVES (to config.coordination.archive):
 *   - claim rows whose State cell starts with `✅` (whole row incl. continuation lines, under a
 *     dated heading at the top of the archive);
 *   - note sections whose heading starts with `## ✅` (closed notes);
 *   - notes whose heading carries `[expires: YYYY-MM-DD]` in the past, `###` notes under
 *     `## Handed-over work` with such a tag, and bullets under `## Open messages` carrying one (appended to a dated "Archived notes" section at
 *     the end of the archive; `##` headings are demoted to `###`).
 *   Structural sections (Protocol, Active claims, Open messages, Handed-over work, Closed) and
 *   headings inside code fences are never treated as notes.
 *
 * USAGE:
 *   node scripts/coordination-archive.mjs            # dry run (default)
 *   node scripts/coordination-archive.mjs --write    # move rows/sections to the archive
 *   node scripts/coordination-archive.mjs --check    # pre-commit gate
 *   node scripts/coordination-archive.mjs --line     # SessionStart: one line, or nothing
 *   node scripts/coordination-archive.mjs --json
 *   --force      accepted and ignored (kept so older recipes still work)
 *
 * EXIT CODES (--check): 0 = nothing to move, or COORDINATION_CHECK=warn; 1 = closed rows or
 * closed note sections still in the file (expired messages alone never fail). Other modes exit 0
 * (--write exits 1 when the safety check fails or the file changed while archiving).
 *
 * --write works on a file with uncommitted changes on purpose: the protocol says "write
 * `✅ DONE <date>` into the State cell, then run --write", and that DONE line is uncommitted by
 * definition. Concurrency is optimistic instead: the file is read, the result computed, and the
 * file re-read right before writing; if the content differs from the first read nothing is
 * written ("the coordination file changed while archiving; run again", exit 1).
 *
 * WRITE SAFETY: both new texts are computed in memory first; the number of lines leaving the
 * coordination file must equal the number of lines entering the archive (wrappers excluded) and
 * every moved line must be found in the new archive text. Only then is anything written.
 *
 * Test hooks (hidden): --file <path> --archive <path> --today <YYYY-MM-DD>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { readTable, parseClaim } from './lib/coordination-table.mjs';

const STRUCTURAL_HEADINGS = ['## Protocol', '## Active claims', '## Open messages', '## Handed-over work', '## Closed'];
const CLOSED_HEADING_RE = /^## ✅/;
const EXPIRES_RE = /\[expires:\s*(\d{4})-(\d{2})-(\d{2})\]/;
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day as a UTC-midnight Date (day arithmetic stays timezone-proof). */
export function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function parseIso(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

export function formatIso(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Heading indexes of `## ` lines outside code fences. */
function headingIndexes(lines) {
  const out = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (!fence && /^## /.test(lines[i])) out.push(i);
  }
  return out;
}

/** Note sections: every non-structural `##` section, as { start, end (exclusive), heading }. */
function findNoteSections(lines) {
  const heads = headingIndexes(lines);
  const notes = [];
  heads.forEach((start, k) => {
    const heading = lines[start];
    if (STRUCTURAL_HEADINGS.some((h) => heading.startsWith(h))) return;
    notes.push({ start, end: k + 1 < heads.length ? heads[k + 1] : lines.length, heading });
  });
  return notes;
}

/**
 * `###` notes under `## Handed-over work` (outside code fences): { start, end (exclusive), heading }.
 * A note runs to the next `###` or `##` heading.
 */
function findHandedOverNotes(lines) {
  const heads = headingIndexes(lines);
  const k = heads.findIndex((i) => lines[i].startsWith('## Handed-over work'));
  if (k < 0) return [];
  const from = heads[k] + 1;
  const to = k + 1 < heads.length ? heads[k + 1] : lines.length;
  const starts = [];
  let fence = false;
  for (let i = from; i < to; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (!fence && /^### /.test(lines[i])) starts.push(i);
  }
  return starts.map((start, n) => ({ start, end: n + 1 < starts.length ? starts[n + 1] : to, heading: lines[start] }));
}

/** Bullets under `## Open messages`: { start, end (exclusive), heading: first line }. */
function findMessageBullets(lines) {
  const heads = headingIndexes(lines);
  const k = heads.findIndex((i) => lines[i].startsWith('## Open messages'));
  if (k < 0) return [];
  const from = heads[k] + 1;
  const to = k + 1 < heads.length ? heads[k + 1] : lines.length;
  const bullets = [];
  let cur = null;
  let fence = false;
  for (let i = from; i < to; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    if (!fence && /^[-*] /.test(lines[i])) { cur = { start: i, end: i + 1, heading: lines[i] }; bullets.push(cur); continue; }
    if (lines[i].trim() === '') cur = null;
    else if (cur) cur.end = i + 1;
  }
  return bullets;
}

/**
 * Pure analysis of the coordination text.
 * Returns { lines, closedRows, closedNotes, expired, staleClaims }.
 *   closedRows   [{ start, end, claim }]  -- end inclusive
 *   closedNotes  [{ start, end, heading }] -- end exclusive
 *   expired      [{ start, end, heading, expires, kind: 'section'|'bullet'|'note' }]
 *   staleClaims  [{ session, itemCode, ageDays }]
 */
export function analyze(text, today, staleClaimDays = 7) {
  const lines = text.split('\n');
  const rows = readTable(lines).rows.map((r) => ({ ...r, claim: parseClaim(r) }));
  const closedRows = rows.filter((r) => r.claim.closed).map((r) => ({ start: r.start, end: r.end, claim: r.claim }));
  const staleClaims = [];
  for (const r of rows) {
    if (r.claim.closed) continue;
    const refreshed = [...r.raw.join('\n').matchAll(/refreshed\s+(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    const dates = [r.claim.since, ...refreshed].map(parseIso).filter(Boolean);
    if (!dates.length) continue;
    const newest = dates.reduce((a, b) => (b > a ? b : a));
    const ageDays = Math.floor((today - newest) / DAY_MS);
    if (ageDays > staleClaimDays) staleClaims.push({ session: r.claim.session, itemCode: r.claim.itemCode, ageDays });
  }
  const closedNotes = [];
  const expired = [];
  const expiry = (heading) => {
    const m = heading.match(EXPIRES_RE);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d < today ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  for (const n of findNoteSections(lines)) {
    if (CLOSED_HEADING_RE.test(n.heading)) { closedNotes.push({ start: n.start, end: n.end, heading: n.heading }); continue; }
    const e = expiry(n.heading);
    if (e) expired.push({ ...n, expires: e, kind: 'section' });
  }
  for (const n of findHandedOverNotes(lines)) {
    const e = expiry(n.heading);
    if (e) expired.push({ ...n, expires: e, kind: 'note' });
  }
  for (const b of findMessageBullets(lines)) {
    const e = expiry(lines.slice(b.start, b.end).join('\n'));
    if (e) expired.push({ ...b, expires: e, kind: 'bullet' });
  }
  return { lines, closedRows, closedNotes, expired, staleClaims };
}

/**
 * Computes the new coordination and archive texts without touching the disk.
 * Throws when the line-conservation check fails.
 */
export function buildArchive(sourceText, archiveText, analysis, today) {
  const stamp = formatIso(today);
  const src = analysis.lines.slice();
  const noteBlocks = [...analysis.closedNotes.map((n) => ({ ...n, kind: 'section' })), ...analysis.expired]
    .sort((a, b) => a.start - b.start);
  const rowBlocks = analysis.closedRows.map((r) => ({ start: r.start, end: r.end + 1 }));
  const removals = [...rowBlocks, ...noteBlocks].sort((a, b) => b.start - a.start);

  const noteLines = noteBlocks.map((n) => {
    const block = analysis.lines.slice(n.start, n.end);
    return n.kind === 'section' ? ['#' + block[0], ...block.slice(1)] : block;
  });
  const rowLines = analysis.closedRows.flatMap((r) => r.claim.raw);
  const movedCount = rowBlocks.reduce((s, b) => s + (b.end - b.start), 0) + noteBlocks.reduce((s, b) => s + (b.end - b.start), 0);

  for (const r of removals) src.splice(r.start, r.end - r.start);

  const arch = archiveText.split('\n');
  if (rowLines.length) {
    const first = arch.findIndex((l) => /^## /.test(l));
    const section = [
      `## ✅ Closed -- coordination-archive ${stamp} -- ${analysis.closedRows.length} claim row(s)`,
      '| Session | Item code | Since | State |',
      '|---|---|---|---|',
      ...rowLines,
      '',
    ];
    arch.splice(first < 0 ? arch.length : first, 0, ...section);
  }
  if (noteLines.length) {
    const title = `## Archived notes -- ${stamp} (coordination-archive: expired / closed heading)`;
    const add = noteLines.flat();
    const at = arch.findIndex((l) => l === title);
    if (at >= 0) {
      let end = arch.length;
      for (let i = at + 1; i < arch.length; i++) if (/^## /.test(arch[i])) { end = i; break; }
      if (end === arch.length) while (end > at + 1 && arch[end - 1] === '') { arch.pop(); end--; }
      if (end > at + 1 && arch[end - 1].trim() !== '') { arch.splice(end, 0, ''); end++; }
      arch.splice(end, 0, ...add);
    } else {
      while (arch.length && arch[arch.length - 1] === '') arch.pop();
      arch.push('', title, '', ...add);
    }
  }
  let newArchive = arch.join('\n');
  if (!newArchive.endsWith('\n')) newArchive += '\n';
  const newSource = src.join('\n');

  // Safety: lines out of the source == lines moved; every moved line exists in the new archive.
  if (analysis.lines.length - src.length !== movedCount) throw new Error('line conservation failed: source shrink does not match moved lines');
  const blocks = [rowLines.join('\n'), ...noteLines.map((b) => b.join('\n'))].filter(Boolean);
  for (const b of blocks) {
    if (!newArchive.includes(b)) throw new Error(`line conservation failed: block missing in archive: ${b.slice(0, 60)}`);
  }
  if (sourceText.length && newSource === sourceText && movedCount > 0) throw new Error('nothing was removed from the coordination file');
  return { source: newSource, archive: newArchive, movedLines: movedCount };
}

/**
 * Reads, computes, re-reads, writes. `read` is injectable so a test can model a peer editing the
 * file between the first read and the write. Returns { code, message }.
 */
export function writeArchive({ file, archiveFile, today, staleDays = 7, read = (f) => fs.readFileSync(f, 'utf8') }) {
  const text = read(file);
  const a = analyze(text, today, staleDays);
  const movable = a.closedRows.length + a.closedNotes.length + a.expired.length;
  if (movable === 0) return { code: 0, message: 'coordination: nothing to move.' };
  const archiveText = fs.existsSync(archiveFile) ? read(archiveFile) : '# Agent Coordination -- Archive\n';
  let built;
  try { built = buildArchive(text, archiveText, a, today); }
  catch (e) { return { code: 1, message: `coordination: aborted, nothing written (${e.message})` }; }
  if (read(file) !== text) return { code: 1, message: 'coordination: the coordination file changed while archiving; run again (nothing written).' };
  fs.writeFileSync(archiveFile, built.archive);
  fs.writeFileSync(file, built.source);
  return { code: 0, message: `coordination: moved ${a.closedRows.length} claim row(s), ${a.closedNotes.length} closed and ${a.expired.length} expired note(s) to ${path.basename(archiveFile)}.` };
}

function summary(a, staleDays) {
  const parts = [];
  if (a.closedRows.length) parts.push(`${a.closedRows.length} closed claim row(s)`);
  if (a.closedNotes.length) parts.push(`${a.closedNotes.length} closed note section(s)`);
  if (a.staleClaims.length) parts.push(`${a.staleClaims.length} claim(s) older than ${staleDays} days`);
  if (a.expired.length) parts.push(`${a.expired.length} expired note(s)`);
  return parts;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const value = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  const { root, config } = loadConfig(process.cwd());
  const coord = config.coordination || {};
  const file = path.resolve(value('--file') || path.join(root, coord.file || 'coordination.md'));
  const archiveFile = path.resolve(value('--archive') || path.join(root, coord.archive || 'coordination-archive.md'));
  const staleDays = coord.staleClaimDays ?? 7;
  const today = value('--today') ? parseIso(value('--today')) : todayUtc();
  const quiet = flag('--line') || flag('--check');

  if (!fs.existsSync(file)) {
    if (!quiet) console.log(`coordination: ${path.basename(file)} not found, nothing to do.`);
    return 0;
  }
  const text = fs.readFileSync(file, 'utf8');
  const a = analyze(text, today, staleDays);
  const movable = a.closedRows.length + a.closedNotes.length + a.expired.length;

  if (flag('--json')) {
    console.log(JSON.stringify({
      closedRows: a.closedRows.map((r) => ({ session: r.claim.session, itemCode: r.claim.itemCode, state: r.claim.state.slice(0, 80) })),
      closedNotes: a.closedNotes.map((n) => n.heading),
      expired: a.expired.map((e) => ({ heading: e.heading.slice(0, 100), expires: e.expires, kind: e.kind })),
      staleClaims: a.staleClaims,
    }, null, 2));
    return 0;
  }

  if (flag('--line')) {
    const parts = summary(a, staleDays);
    if (parts.length) console.log(`coordination: ${parts.join(', ')} -> node scripts/coordination-archive.mjs --write`);
    return 0;
  }

  if (flag('--check')) {
    if (process.env.COORDINATION_CHECK === 'warn') return 0;
    const closed = a.closedRows.length + a.closedNotes.length;
    if (closed === 0) return 0;
    if (a.closedRows.length) {
      console.log(`coordination: ${a.closedRows.length} closed claim row(s) still in the table. Run first: node scripts/coordination-archive.mjs --write`);
      for (const r of a.closedRows) console.log(`  - ${r.claim.session}: ${r.claim.itemCode} (${r.claim.state.slice(0, 60)})`);
    }
    if (a.closedNotes.length) {
      console.log(`coordination: ${a.closedNotes.length} closed note section(s) still in the file. Run first: node scripts/coordination-archive.mjs --write`);
      for (const n of a.closedNotes) console.log(`  - ${n.heading.slice(0, 80)}`);
    }
    console.log('  (bypass once with COORDINATION_CHECK=warn)');
    return 1;
  }

  if (flag('--write')) {
    const r = writeArchive({ file, archiveFile, today, staleDays });
    (r.code === 0 ? console.log : console.error)(r.message);
    return r.code;
  }

  // dry run
  console.log(`coordination (dry run): ${a.closedRows.length} closed claim row(s), ${a.closedNotes.length} closed note section(s), ${a.expired.length} expired note(s)`);
  for (const r of a.closedRows) console.log(`  -> ${r.claim.session}: ${r.claim.itemCode} (${r.claim.state.slice(0, 60)})`);
  for (const n of a.closedNotes) console.log(`  closed note: ${n.heading.slice(0, 80)}`);
  for (const e of a.expired) console.log(`  expired note [expires ${e.expires}]: ${e.heading.slice(0, 80)}`);
  for (const s of a.staleClaims) console.log(`  stale claim: ${s.session} ${s.itemCode} (${s.ageDays} days, no refresh)`);
  if (movable) console.log('  to apply: node scripts/coordination-archive.mjs --write');
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { console.error(`coordination-archive: ${e.message}`); process.exitCode = 1; }
}
