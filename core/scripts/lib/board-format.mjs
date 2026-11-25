// Shared task-board parser for board-lint / board-archive / human-queue / board-staleness.
//
// Everything that depends on the board's wording comes from the project config, so a board
// written in another language works by changing `board.fields` (and `humans` / `labels`)
// only - no script edit:
//   - field names      config.board.fields   (remaining, lastEvidence, decision, trap, history, humanStep)
//   - owner tags       config.humans + config.labels.humanOnly + config.labels.anyone
//   - completion words config.board.doneSignals (falls back to the lists exported below)
//
// Item shape the parser understands (see the task-board template):
//   ### <code> <status-emoji> [TAG] <title>
//   **Remaining:** ...        (one `**<Field>:**` label per line)
// Rules of the parser:
//   - an item runs from its `###` heading to the next `#`/`##`/`###` heading;
//   - headings inside fenced code blocks are ignored (the rules section shows a template);
//   - a heading whose code does not start with a letter or digit is not an item;
//   - from the first `##` heading that looks like the rules section or an archive section on,
//     `###` headings are not items.
import { DEFAULTS } from './config.mjs';

export const DEFAULT_DONE_SIGNALS = ['done', 'closed', 'live', 'deployed', 'merged', 'shipped', 'deploy ok'];
export const DEFAULT_PARTIAL_SIGNALS = ['remaining', 'pending', 'awaiting', 'blocked', 'todo'];

// Status emojis, stored without the U+FE0F variation selector so both spellings match.
export const STATUS = {
  done: '✅', live: '🟢', smoke: '🧪', open: '🔴', partial: '🟡',
  external: '🔵', deferred: '⏸', research: '🔬', info: 'ℹ',
};
const STATUS_LIST = Object.values(STATUS);

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex matching a line that starts with the bold field label, e.g. `**Remaining:**`. */
export function fieldRegExp(label) {
  return new RegExp('^\\*\\*' + escapeRegExp(label) + ':\\*\\*');
}

const unique = (list) => [...new Set(list.filter(Boolean))];

/** Builds the parsing format from a loaded config (partial configs are filled from DEFAULTS). */
export function boardFormat(config = {}) {
  const board = config.board ?? {};
  const fields = { ...DEFAULTS.board.fields, ...(board.fields ?? {}) };
  const humans = unique(config.humans ?? DEFAULTS.humans);
  const labels = { ...DEFAULTS.labels, ...(config.labels ?? {}) };
  const owners = unique([...humans, labels.humanOnly, labels.anyone]);
  const doneSignals = (board.doneSignals && board.doneSignals.length ? board.doneSignals : DEFAULT_DONE_SIGNALS)
    .map((s) => String(s).toLowerCase());
  const reopen = fields.reopen ?? 'Reopen';

  const re = {};
  for (const [key, label] of Object.entries(fields)) re[key] = fieldRegExp(label);

  // Labels that end the Remaining block: every other field except the human step.
  const enders = unique([fields.lastEvidence, fields.decision, fields.trap, fields.history]
    .flatMap((l) => [l, ...String(l).split('/')]).map((s) => s.trim()));
  const templateLabels = new Set(unique([...Object.values(fields), reopen,
    ...String(fields.decision).split('/')]).map((s) => s.trim()));

  const tagAlternatives = (list) => list.map(escapeRegExp).join('|');
  const letterEdge = (sig) => '(?<![\\p{L}\\p{N}])' + escapeRegExp(sig) + '(?![\\p{L}\\p{N}])';

  return {
    fields,
    re,
    humans,
    owners,
    status: STATUS,
    // `[OWNER]`, `[DEV]`, `[ANY]` anywhere in a text
    ownerRe: new RegExp('\\[(?:' + tagAlternatives(owners) + ')\\]'),
    // `[OWNER ...]` including suffixes such as `[OWNER approval]`
    humanTagRe: new RegExp('\\[(?:' + tagAlternatives(humans) + ')[^\\]]*\\]'),
    // a text that BEGINS with a human tag (after list/bold decoration)
    humanStartRe: new RegExp('^\\s*(?:[-*]\\s+)?(?:\\*\\*[^*]*\\*\\*\\s*)?\\[(?:' + tagAlternatives(humans) + ')[^\\]]*\\]'),
    blockEndRe: new RegExp('^\\*\\*(?:' + enders.map(escapeRegExp).join('|') + ')'),
    reopenRe: new RegExp('\\*\\*' + escapeRegExp(reopen) + ':\\*\\*.*?\\)\\.', 'g'),
    templateLabels,
    doneSignals,
    doneRe: new RegExp('✅|' + doneSignals.map(letterEdge).join('|'), 'iu'),
    partialSignals: (board.partialSignals && board.partialSignals.length ? board.partialSignals : DEFAULT_PARTIAL_SIGNALS)
      .map((s) => String(s).toLowerCase()),
  };
}

/** Drops struck-through parts and the conditional reopen sentence: owner tags there are not pending work. */
export function stripStruck(text, fmt) {
  const noStrike = String(text).replace(/~~[^~]*~~/g, '');
  return fmt ? noStrike.replace(fmt.reopenRe, '') : noStrike;
}

const CLOSED_ZONE_RE = /^##\s+(?:9\.|.*(?:§\s*9|Update rules|Archive))/i;
const DUPLICATE_RE = /↪\s*DUPLICATE/i;
const normalizeCode = (code) => code.replace(/\s*\/\s*/g, '/');

function parseHeading(headingLine) {
  const text = headingLine.replace(/^###\s+/, '');
  const m = text.match(/^(.*?)\s*(?=[^\x00-\x7F]|\[|$)/u);
  const code = (m ? m[1] : text.split(/\s+/)[0]).trim();
  const rest = m ? text.slice(m[0].length) : '';
  let status = '';
  let best = Infinity;
  for (const s of STATUS_LIST) {
    const at = rest.indexOf(s);
    if (at >= 0 && at < best) { best = at; status = s; }
  }
  return { code, status };
}

function remainingBlock(body, fmt) {
  const start = body.findIndex((l) => fmt.re.remaining.test(l));
  if (start < 0) return { present: false, text: '' };
  let end = body.length;
  for (let j = start + 1; j < body.length; j++) if (fmt.blockEndRe.test(body[j])) { end = j; break; }
  return { present: true, text: body.slice(start, end).join('\n') };
}

/**
 * Parses the board text into items.
 * Item: { start, end, bodyEnd, heading, code, key, status, duplicate, body[], remaining, hasRemaining }
 *   start..end  = raw line range (end exclusive, includes trailing blank lines)
 *   bodyEnd     = end without trailing blank lines
 *   key         = code with ` / ` normalised to `/` (duplicate detection)
 *   status      = first status emoji of the heading (no U+FE0F), '' when none
 * Options: { includeClosedZone: false } keeps items found after the rules/archive sections.
 */
export function parseItems(text, fmt, opts = {}) {
  const lines = String(text).split('\n');
  const limit = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const items = [];
  let cur = null;
  let fenced = false;
  let closedZone = false;

  const finish = (end) => {
    if (!cur) return;
    let bodyEnd = end;
    while (bodyEnd > cur.start + 1 && lines[bodyEnd - 1].trim() === '') bodyEnd--;
    const body = lines.slice(cur.start + 1, bodyEnd);
    const rem = remainingBlock(body, fmt);
    items.push({ ...cur, end, bodyEnd, body, remaining: rem.text, hasRemaining: rem.present });
    cur = null;
  };

  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^#{1,2}\s/.test(line)) {
      finish(i);
      if (CLOSED_ZONE_RE.test(line)) closedZone = true;
      continue;
    }
    if (/^###\s/.test(line)) {
      finish(i);
      if (closedZone && !opts.includeClosedZone) continue;
      const { code, status } = parseHeading(line);
      if (!/^[A-Za-z0-9]/.test(code)) continue;
      cur = { start: i, heading: line, code, key: normalizeCode(code), status, duplicate: DUPLICATE_RE.test(line) };
    }
  }
  finish(limit);
  return items;
}

/** Item codes that appear in more than one non-duplicate heading. */
export function duplicateKeys(items) {
  const count = new Map();
  for (const it of items) {
    if (it.duplicate) continue;
    count.set(it.key, (count.get(it.key) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1).map(([key]) => key);
}

/** Text of the field line after its label, or '' when the field is missing. */
export function fieldText(item, fmt, key) {
  const line = item.body.find((l) => fmt.re[key].test(l));
  return line ? line.replace(fmt.re[key], '').trim() : '';
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** `YYYY-MM-DD` -> local Date at midnight; null when malformed. */
export function parseIsoDate(text) {
  const m = String(text ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function todayDate(override) {
  const parsed = parseIsoDate(override);
  if (parsed) return parsed;
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
