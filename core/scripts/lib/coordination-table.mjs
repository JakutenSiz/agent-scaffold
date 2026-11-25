// Parser for the `## Active claims` table of the coordination file
// (shared by coordination-archive.mjs and any tool that lists claims).
// Pure: no side effects at module top level.
//
// Table shape (fixed English headers, scripts parse them; never translated):
//   ## Active claims
//   | Session | Item code | Since | State |
//   |---|---|---|---|
//   | <session> | <board item code> | <date> | <state; `✅ DONE <date>` closes the claim> |
//
// A row may be followed by continuation lines that do not start with `|`; they belong to the row.

export const CLAIMS_HEADING_RE = /^## Active claims/;

// Board item codes are `<MMDD>-<slug>`, e.g. `0918-gate-baseline`; the slug must contain a letter.
export const ITEM_CODE_RE = /\b\d{4}-(?=[a-z0-9-]*[a-z])[a-z0-9-]+/;

/** Splits one table row into trimmed cells. Escaped `\|` and `|` inside backticks do not split. */
export function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; }
    else if (s[i] === '`') { code = !code; cur += '`'; }
    else if (s[i] === '|' && !code) { out.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

/**
 * Reads the claims table. Returns { rows, headingIdx }; headingIdx is -1 when the section is
 * missing. Each row: { start, end, cells, raw } where start/end are line indexes (end inclusive,
 * covering continuation lines) and raw is the original lines.
 */
export function readTable(lines) {
  const head = lines.findIndex((l) => CLAIMS_HEADING_RE.test(l));
  if (head < 0) return { rows: [], headingIdx: -1 };
  let stop = lines.length;
  for (let i = head + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { stop = i; break; }
  const rows = [];
  let seen = 0;
  for (let i = head + 1; i < stop; i++) {
    if (!lines[i].startsWith('|')) continue;
    seen++;
    if (seen <= 2) continue; // header + separator
    let end = i;
    while (end + 1 < stop && lines[end + 1].trim() !== '' && !lines[end + 1].startsWith('|')) end++;
    rows.push({ start: i, end, cells: splitCells(lines[i]), raw: lines.slice(i, end + 1) });
    i = end;
  }
  return { rows, headingIdx: head };
}

/** Item code found in a cell (or a whole row); falls back to the first 40 characters. */
export function extractItemCode(text) {
  const m = String(text).match(ITEM_CODE_RE);
  return m ? m[0] : String(text).trim().slice(0, 40);
}

/** Turns a readTable row into { session, itemCode, since, state, closed, raw }. */
export function parseClaim(row) {
  const cells = splitCells(row.raw.join('\n'));
  const state = (cells[3] || '').replace(/\n/g, ' ');
  return {
    session: cells[0] || '',
    itemCode: extractItemCode(cells[1] || ''),
    since: cells[2] || '',
    state,
    closed: /^\s*✅/.test(state),
    raw: row.raw,
  };
}
