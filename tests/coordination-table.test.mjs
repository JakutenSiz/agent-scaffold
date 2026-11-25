import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCells, readTable, parseClaim, extractItemCode } from '../core/scripts/lib/coordination-table.mjs';

const TABLE = [
  '# Title',
  '## Active claims',
  '| Session | Item code | Since | State |',
  '|---|---|---|---|',
  '| agent-a | 0918-first-item | 2026-09-18 | working |',
  '| agent-b | 0919-second-item | 2026-09-19 | working |',
  'continuation line',
  '',
  '## Next',
  '| y | z |',
];

test('splitCells: escaped pipe is kept, edge pipes dropped', () => {
  assert.deepEqual(splitCells('| a \\| b | c |'), ['a \\| b', 'c']);
  assert.deepEqual(splitCells('a|b'), ['a', 'b']);
});

test('splitCells: a pipe inside backticks does not split', () => {
  assert.deepEqual(splitCells('| `x|y` | z |'), ['`x|y`', 'z']);
});

test('splitCells: multi-line raw text keeps newlines inside the cell', () => {
  assert.deepEqual(splitCells('| a | two\nlines | c |'), ['a', 'two\nlines', 'c']);
});

test('readTable: header and separator skipped, continuation joins the previous row', () => {
  const { rows, headingIdx } = readTable(TABLE);
  assert.equal(headingIdx, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, ['agent-a', '0918-first-item', '2026-09-18', 'working']);
  assert.equal(rows[1].start, 5);
  assert.equal(rows[1].end, 6);
  assert.equal(rows[1].raw.length, 2);
});

test('readTable: tables of later sections are not read', () => {
  assert.equal(readTable(TABLE).rows.some((r) => r.cells[0] === 'y'), false);
});

test('readTable: missing section gives an empty result', () => {
  assert.deepEqual(readTable(['# x', 'text']), { rows: [], headingIdx: -1 });
});

test('parseClaim: open row, code extracted, escaped pipe and backtick pipe do not split', () => {
  const lines = ['## Active claims', '', '| Session | Item code | Since | State |', '|---|---|---|---|',
    '| s-1 | **0912-x-y** | 2026-09-12 | in progress \\| ok `a|b` |'];
  const c = parseClaim(readTable(lines).rows[0]);
  assert.equal(c.itemCode, '0912-x-y');
  assert.equal(c.since, '2026-09-12');
  assert.equal(c.closed, false);
  assert.equal(c.raw.length, 1);
});

test('parseClaim: a State starting with the done marker is closed', () => {
  const lines = ['## Active claims', '', '| a | b | c | d |', '|---|---|---|---|',
    '| s-1 | 0912-x | 2026-09-12 | ✅ DONE 2026-09-14 |', '| s-2 | 0913-y | 2026-09-13 | blocked ✅ later |'];
  const [done, open] = readTable(lines).rows.map(parseClaim);
  assert.equal(done.closed, true);
  assert.equal(open.closed, false);
});

test('extractItemCode: needs a letter in the slug, falls back to raw text', () => {
  assert.equal(extractItemCode('see 0918-gate-baseline now'), '0918-gate-baseline');
  assert.equal(extractItemCode('2026-09-18'), '2026-09-18');
  assert.equal(extractItemCode('free text'), 'free text');
});
