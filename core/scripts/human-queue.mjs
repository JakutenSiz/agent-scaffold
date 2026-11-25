#!/usr/bin/env node
// Enforces: R-26
/**
 * human-queue - lists the board items that wait on a human step, one queue per person.
 *
 * SOURCE: the single-line Human step field of every `###` item, e.g.
 *   **Human step:** [OWNER] approve the rollout (2026-11-02) · [OWNER/LEAD] pick the vendor
 * Tags are the entries of config.humans (default `[OWNER]`); a tag such as `[A/B]` names several
 * people and lands in the shared queue. A part without a tag continues the previous part.
 * The Remaining field is NOT read. Deferred items and `↪ DUPLICATE` items are skipped.
 *
 * AGE: the newest parenthesised ISO date `(YYYY-MM-DD)` on the Human step line wins; else the
 * newest ISO date on the Last evidence line; else the newest one in the heading; else the
 * `<MMDD>-` prefix of the item code (rolled back to the previous year when it lies in the
 * future); else unknown. Older than config.board.humanStepExpiryWeeks (default 4) is flagged
 * EXPIRED. The decision stays with the human: this script never drops an item.
 *
 * USAGE:
 *   node scripts/human-queue.mjs                 # full list: items per tag, expired ones marked
 *   node scripts/human-queue.mjs --line          # SessionStart: one summary line, or NOTHING when the queue is empty
 *   node scripts/human-queue.mjs --json | --write <file>   [--weeks N]
 *   (hidden, for tests) --source <board> --today <YYYY-MM-DD> --root <dir>
 *
 * EXIT CODES: always 0 (informational); `--write` without a file gives 1; a missing board
 * prints nothing (fail-open).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { boardFormat, parseItems, escapeRegExp, isoDate, parseIsoDate, todayDate } from './lib/board-format.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHARED = 'shared';
const DAY_MS = 86400000;

const ageOf = (date, today) => Math.round((today - date) / DAY_MS);

/** Newest-date age in days from every ISO date in `text`; future dates are ignored; null if none. */
export function newestAge(text, today) {
  const ages = [...String(text).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)]
    .map((m) => parseIsoDate(m[1]))
    .filter((d) => d && d <= today)
    .map((d) => ageOf(d, today));
  return ages.length ? Math.min(...ages) : null;
}

function codeAge(code, today) {
  const m = code.match(/^(\d{2})(\d{2})-/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  // Code scheme is <MMDD>-<slug>
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let d = new Date(today.getFullYear(), month - 1, day);
  if (d > today) d = new Date(today.getFullYear() - 1, month - 1, day);
  return ageOf(d, today);
}

/** `**Human step:** [A] text · [B] text` line -> [{tag, who, text}]. */
export function parseHumanStep(line, fmt) {
  const names = fmt.humans.map(escapeRegExp).join('|');
  const tagStart = new RegExp('^\\s*\\[((?:' + names + ')(?:\\/(?:' + names + '))*)\\]\\s*');
  const out = [];
  for (const part of line.replace(fmt.re.humanStep, '').split(' · ')) {
    const m = part.match(tagStart);
    if (m) { out.push({ tag: m[1], who: m[1].includes('/') ? SHARED : m[1], text: part.slice(m[0].length).replace(/\s+/g, ' ').trim() }); continue; }
    if (out.length) out[out.length - 1].text += ' · ' + part.replace(/\s+/g, ' ').trim();
  }
  return out
    .filter((x) => /\p{L}/u.test(x.text))
    .map((x) => ({ ...x, text: x.text.length > 160 ? x.text.slice(0, 157) + '...' : x.text }));
}

/** Collects the queue entries: [{code, who, text, age}] */
export function collect(boardText, fmt, today) {
  const entries = [];
  for (const it of parseItems(boardText, fmt)) {
    if (it.duplicate || it.status === fmt.status.deferred) continue;
    const stepLine = it.body.find((l) => fmt.re.humanStep.test(l));
    if (!stepLine) continue;
    const parts = parseHumanStep(stepLine, fmt);
    if (!parts.length) continue;
    const whos = new Set(parts.map((x) => x.who));
    const who = whos.size > 1 || whos.has(SHARED) ? SHARED : [...whos][0];
    const text = parts.length === 1 ? parts[0].text : parts.map((x) => `[${x.tag}] ${x.text}`).join(' · ');
    // only a parenthesised date resets the age; dates inside the sentence must not hide staleness
    const stepDates = [...stepLine.matchAll(/\(\d{4}-\d{2}-\d{2}\)/g)].map((x) => x[0]).join(' ');
    const evidence = it.body.find((l) => fmt.re.lastEvidence.test(l));
    const age = newestAge(stepDates, today)
      ?? (evidence ? newestAge(evidence, today) : null)
      ?? newestAge(it.heading, today)
      ?? codeAge(it.code, today);
    entries.push({ code: it.code, who, text, age });
  }
  return entries;
}

export function summarize(entries, fmt, weeks) {
  const perPerson = Object.fromEntries(fmt.humans.map((h) => [h, entries.filter((e) => e.who === h).length]));
  const shared = entries.filter((e) => e.who === SHARED).length;
  const expired = entries.filter((e) => e.age !== null && e.age > weeks * 7);
  const oldest = entries.filter((e) => e.age !== null).sort((a, b) => b.age - a.age)[0];
  return { perPerson, shared, expired, oldest };
}

/** Markdown-ish list: one section per person, then the shared one, then the count line. */
export function renderLists(entries, fmt, weeks, s) {
  const section = (title, who) => {
    const list = entries.filter((e) => e.who === who).sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
    return [`## ${title} (${list.length})`, '',
      ...list.map((e) => `- ${e.age !== null && e.age > weeks * 7 ? 'EXPIRED ' : ''}[${e.code}] ${e.text} - ${e.age === null ? 'unknown' : e.age + ' days'}`), ''];
  };
  return [
    ...fmt.humans.flatMap((h) => section(h, h)), ...section('Shared', SHARED),
    `**Count:** ${fmt.humans.map((h) => `${h} ${s.perPerson[h]}`).join(' · ')} · shared ${s.shared} · expired ${s.expired.length}`, '',
  ];
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (a) => argv.includes(a);
  const value = (a) => { const i = argv.indexOf(a); return i >= 0 ? argv[i + 1] : null; };
  const { root, config } = loadConfig(value('--root') ?? SCRIPT_DIR);
  const fmt = boardFormat(config);
  const weeks = Number(value('--weeks') ?? config.board.humanStepExpiryWeeks ?? 4);
  const today = todayDate(value('--today'));
  const source = path.resolve(value('--source') ?? path.join(root, config.board.file));
  if (!fs.existsSync(source)) return 0; // fail-open: no board, no line

  const entries = collect(fs.readFileSync(source, 'utf8'), fmt, today);
  const s = summarize(entries, fmt, weeks);

  if (flag('--json')) {
    console.log(JSON.stringify({ entries, perPerson: s.perPerson, shared: s.shared, expired: s.expired.length, weeks }, null, 2));
    return 0;
  }
  if (flag('--write')) {
    const target = value('--write');
    if (!target || target.startsWith('--')) { console.error('human-queue: --write <file> requires a file'); return 1; }
    const md = [
      `# Human queue - ${isoDate(today)}`, '',
      `> Output of \`node scripts/human-queue.mjs\` (the Human step line of each board item). Age = date of the step or item; older than ${weeks} weeks is marked EXPIRED. The decision stays with the human: without evidence or a step the item is deferred.`, '',
      ...renderLists(entries, fmt, weeks, s),
    ].join('\n');
    fs.writeFileSync(path.resolve(target), md);
    console.log(`human-queue: ${entries.length} entries -> ${target}`);
    return 0;
  }
  if (flag('--line')) {
    if (!entries.length) return 0; // nothing to report, no output
    const old = s.oldest ? ` (oldest ${s.oldest.code} ${s.oldest.age} days)` : '';
    const counts = fmt.humans.map((h) => `${h} ${s.perPerson[h]}`).join(' · ');
    console.log(`human queue: ${counts} · shared ${s.shared} · expired ${s.expired.length}${old} -> node scripts/human-queue.mjs`);
    return 0;
  }
  // default: the full list
  console.log([`# Human queue - ${isoDate(today)}`, '', ...renderLists(entries, fmt, weeks, s)].join('\n'));
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`human-queue: ${e.message}\n`); process.exitCode = 0; } // fail-open
}
