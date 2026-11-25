import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFormat } from '../core/scripts/lib/board-format.mjs';
import { parseHumanStep, collect, summarize, newestAge } from '../core/scripts/human-queue.mjs';

const fmt = boardFormat({ humans: ['OWNER', 'LEAD'] });
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/human-queue.mjs');
const TODAY = new Date(2026, 10, 25);

test('parseHumanStep: tags, shared tag, untagged continuation', () => {
  const parts = parseHumanStep('**Human step:** [OWNER] approve the rollout · [LEAD] pick a vendor · and a rider', fmt);
  assert.deepEqual(parts.map((p) => p.who), ['OWNER', 'LEAD']);
  assert.match(parts[1].text, /vendor · and a rider/);
  assert.equal(parseHumanStep('**Human step:** [OWNER/LEAD] decide together', fmt)[0].who, 'shared');
  assert.deepEqual(parseHumanStep('**Human step:** [OTHER] x', fmt), []);
  assert.deepEqual(parseHumanStep('**Human step:** [OWNER] ---', fmt), []); // no letters, not a step
});

test('newestAge: newest date wins, future dates are ignored', () => {
  assert.equal(newestAge('2026-11-20 and 2026-11-01', TODAY), 5);
  assert.equal(newestAge('2027-01-01', TODAY), null);
  assert.equal(newestAge('no date', TODAY), null);
});

const BOARD = [
  '# Board',
  '',
  '## Open items',
  '',
  '### 1120-fresh 🔴 [DEV] Fresh',
  '**Remaining:** x',
  '**Human step:** [OWNER] approve (2026-11-20)',
  '',
  '### 0901-stale 🔴 [DEV] Stale',
  '**Remaining:** [OWNER] not read here',
  '**Human step:** [LEAD] decide (2026-09-01) · [OWNER] sign off',
  '',
  '### 1001-evidence 🟡 [DEV] Age from evidence',
  '**Last evidence:** 2026-10-20 abc1234',
  '**Human step:** [OWNER] answer the vendor, mentioned 2026-11-24 in the text',
  '',
  '### 0501-parked ⏸️ [DEV] Deferred is skipped',
  '**Human step:** [OWNER] ignored',
  '',
  '### 0502-noline 🔴 [DEV] No human step',
  '**Remaining:** [OWNER] only in Remaining',
  '',
  '### 0601-code-age 🔴 [DEV] Age from the code prefix',
  '**Human step:** [OWNER/LEAD] shared decision',
  '',
].join('\n');

test('collect: queues, shared, age priority, deferred and no-field items skipped', () => {
  const entries = collect(BOARD, fmt, TODAY);
  const by = Object.fromEntries(entries.map((e) => [e.code, e]));
  assert.deepEqual(Object.keys(by).sort(), ['0601-code-age', '0901-stale', '1001-evidence', '1120-fresh']);
  assert.equal(by['1120-fresh'].age, 5);
  assert.equal(by['1120-fresh'].who, 'OWNER');
  assert.equal(by['0901-stale'].who, 'shared'); // two people on one item
  assert.equal(by['0901-stale'].age, 85);
  assert.equal(by['1001-evidence'].age, 36); // evidence date, not the date inside the sentence
  assert.equal(by['0601-code-age'].who, 'shared');
  assert.equal(by['0601-code-age'].age, Math.round((TODAY - new Date(2026, 5, 1)) / 86400000));
});

test('summarize: counts per person, expired, oldest', () => {
  const s = summarize(collect(BOARD, fmt, TODAY), fmt, 4);
  assert.equal(s.perPerson.OWNER, 2);
  assert.equal(s.perPerson.LEAD, 0);
  assert.equal(s.shared, 2);
  assert.equal(s.expired.length, 3); // 85, 36 and the code-age item are over 28 days
  assert.equal(s.oldest.code, '0601-code-age');
});

test('CLI: line, json and write modes with a temporary board', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-queue-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({ humans: ['OWNER', 'LEAD'] }));
    fs.writeFileSync(path.join(dir, 'task-board.md'), BOARD);
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--root', dir, '--today', '2026-11-25', ...a], { encoding: 'utf8' });
    const line = run('--line');
    assert.equal(line.status, 0);
    assert.match(line.stdout, /^human queue: OWNER 2 · LEAD 0 · shared 2 · expired 3/);
    assert.equal(line.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(run('--json').stdout).entries.length, 4);
    const out = path.join(dir, 'queue.md');
    assert.equal(run('--write', out).status, 0);
    const md = fs.readFileSync(out, 'utf8');
    assert.match(md, /# Human queue - 2026-11-25/);
    assert.match(md, /EXPIRED \[0901-stale\]/);
    assert.equal(run('--write').status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: no flag prints the full list (items per tag, expired marked); --line stays one line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-queue-full-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({ humans: ['OWNER', 'LEAD'] }));
    fs.writeFileSync(path.join(dir, 'task-board.md'), BOARD);
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--root', dir, '--today', '2026-11-25', ...a], { encoding: 'utf8' });
    const full = run();
    assert.equal(full.status, 0);
    assert.match(full.stdout, /## OWNER \(2\)/);
    assert.match(full.stdout, /## Shared \(2\)/);
    assert.match(full.stdout, /EXPIRED \[0901-stale\]/);
    assert.match(full.stdout, /\[1120-fresh\] approve/);
    assert.ok(full.stdout.trim().split('\n').length > 5);
    assert.equal(run('--line').stdout.trim().split('\n').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --line prints nothing when the queue is completely empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-queue-empty-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({ humans: ['OWNER', 'LEAD'] }));
    fs.writeFileSync(path.join(dir, 'task-board.md'), '# Board\n\n## Open items\n\n### 1120-x 🔴 [DEV] No step\n**Remaining:** x\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--today', '2026-11-25', '--line'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: a missing board prints nothing and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-queue-none-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--line'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
