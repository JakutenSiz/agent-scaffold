import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardFormat, parseItems, duplicateKeys, stripStruck, fieldText, parseIsoDate, isoDate, todayDate, STATUS,
} from '../core/scripts/lib/board-format.mjs';

const fmt = boardFormat({});

const BOARD = [
  '# Board',
  '',
  '## Open items',
  '',
  '### 0101-alpha 🔴 [DEV] Alpha work',
  '**Remaining:** do the thing',
  '**Last evidence:** 2026-01-01 abc1234',
  '',
  '### 0102-beta ✅ [ANY] Beta shipped',
  '**Remaining:** none',
  '',
  '```',
  '### 0199-fenced 🔴 inside a fence is ignored',
  '```',
  '',
  '### 📐 not an item',
  'text',
  '',
  '## §9 Update rules',
  '',
  '### 0103-rules 🔴 [DEV] after the rules section: not an item',
  '',
].join('\n');

test('parseItems: items, status, fences and closed zone', () => {
  const items = parseItems(BOARD, fmt);
  assert.deepEqual(items.map((i) => i.code), ['0101-alpha', '0102-beta']);
  assert.equal(items[0].status, STATUS.open);
  assert.equal(items[1].status, STATUS.done);
  assert.equal(items[0].body.length, 2);
  assert.ok(items[0].hasRemaining);
  assert.equal(fieldText(items[0], fmt, 'lastEvidence'), '2026-01-01 abc1234');
});

test('parseItems: includeClosedZone keeps items after the rules section', () => {
  const codes = parseItems(BOARD, fmt, { includeClosedZone: true }).map((i) => i.code);
  assert.ok(codes.includes('0103-rules'));
});

test('parseItems: status is the first status emoji, a later one in the title is ignored', () => {
  const [it] = parseItems('### 0101-x 🔴 [DEV] title mentions ✅ done\n**Remaining:** x\n', fmt);
  assert.equal(it.status, STATUS.open);
});

test('parseItems: duplicate marker and duplicateKeys', () => {
  const text = '### 0101-a 🔴 [DEV] one\n\n### 0101-a 🔴 [DEV] twin\n\n### 0102-b 🔴 ↪ DUPLICATE see 0101-a\n\n### 0102-b 🔴 [DEV] again\n';
  const items = parseItems(text, fmt);
  assert.equal(items.filter((i) => i.duplicate).length, 1);
  assert.deepEqual(duplicateKeys(items), ['0101-a']);
});

test('Remaining block ends at the next field label, multi-line lists included', () => {
  const [it] = parseItems('### 0101-a 🔴 [DEV] t\n**Remaining:**\n- [OWNER] approve\n- more\n**Last evidence:** x\n', fmt);
  assert.match(it.remaining, /approve/);
  assert.doesNotMatch(it.remaining, /Last evidence/);
});

test('stripStruck drops struck parts and the reopen sentence', () => {
  assert.equal(stripStruck('a ~~[OWNER] old~~ b', fmt), 'a  b');
  assert.doesNotMatch(stripStruck('x **Reopen:** if it fails [OWNER] decides).', fmt), /OWNER/);
});

test('doneRe: unicode word edges, no partial-word hits', () => {
  assert.ok(fmt.doneRe.test('release is live'));
  assert.ok(!fmt.doneRe.test('delivery is alive'));
  assert.ok(fmt.doneRe.test('✅ closed'));
});

test('owner and human tags follow config', () => {
  const f = boardFormat({ humans: ['LEAD', 'CTO'], labels: { humanOnly: 'DEV', anyone: 'ANY' } });
  assert.ok(f.ownerRe.test('[LEAD] x') && f.ownerRe.test('[ANY] x') && f.ownerRe.test('[DEV] x'));
  assert.ok(!f.ownerRe.test('[OWNER] x'));
  assert.ok(f.humanTagRe.test('[CTO approval] x'));
  assert.ok(f.humanStartRe.test('- **Step:** [LEAD] x'));
});

test('a non-English board works through config only', () => {
  const tr = boardFormat({
    board: { fields: { remaining: 'Kalan', lastEvidence: 'Son kanıt', decision: 'Karar/engel', trap: 'Tuzak', history: 'Tam geçmiş', humanStep: 'İnsan adımı' } },
    humans: ['SAHİP'],
  });
  const text = '### 0101-bir ✅ [DEV] Başlık\n**Kalan:** [SAHİP] onay ver\n**Son kanıt:** 2026-01-01 abc1234\n';
  const [it] = parseItems(text, tr);
  assert.ok(it.hasRemaining);
  assert.ok(tr.ownerRe.test(it.remaining));
  assert.equal(fieldText(it, tr, 'lastEvidence'), '2026-01-01 abc1234');
});

test('date helpers', () => {
  assert.equal(parseIsoDate('2026-02-30') instanceof Date, true); // JS rolls over; shape check only
  assert.equal(parseIsoDate('26-02-03'), null);
  assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(isoDate(todayDate('2026-03-04')), '2026-03-04');
});
