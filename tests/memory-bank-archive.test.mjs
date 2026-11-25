// memory-bank-archive tests - temp project with a fake memory-bank and --root; never touches a real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planArchive, parseDate } from '../core/scripts/memory-bank-archive.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scripts', 'memory-bank-archive.mjs');
const todayText = new Date().toISOString().slice(0, 10);

const CONTENT = `# Active context

Preface line.

## 2020-01-02 - old finished entry
Old work, closed.

## 2020-01-03 - old but pending
Deploy pending.

## ${todayText} - today's entry
Fresh work.
`;

function fixture(content = CONTENT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-archive-'));
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify({ repos: [{ name: 'app', path: '.' }] }));
  fs.mkdirSync(path.join(root, 'memory-bank'));
  fs.writeFileSync(path.join(root, 'memory-bank', 'activeContext.md'), content);
  return root;
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const live = (root) => fs.readFileSync(path.join(root, 'memory-bank', 'activeContext.md'), 'utf8');

test('--root dry run: file untouched, report names the entry count', () => {
  const root = fixture();
  try {
    const r = run('app', '--root', root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /archived 1/);
    assert.equal(live(root), CONTENT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--root --write: old entry moves verbatim, pending and fresh entries stay', () => {
  const root = fixture();
  try {
    const r = run('app', '--root', root, '--write');
    assert.equal(r.status, 0, r.stderr);
    const now = live(root);
    assert.doesNotMatch(now, /old finished entry/);
    assert.match(now, /old but pending/);
    assert.match(now, /today's entry/);
    const archive = fs.readFileSync(path.join(root, 'memory-bank', 'archive', 'activeContext-archive.md'), 'utf8');
    assert.match(archive, /Old work, closed\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kept entries are rewritten byte-for-byte: no extra blank line per run (idempotence)', () => {
  const root = fixture();
  try {
    run('app', '--root', root, '--write');
    const after1 = live(root);
    // expected: the original minus the moved block
    const expected = CONTENT.replace('## 2020-01-02 - old finished entry\nOld work, closed.\n\n', '');
    assert.equal(after1, expected);
    // second run has nothing to move: file must not change
    run('app', '--root', root, '--write');
    assert.equal(live(root), after1);
    // a later run that DOES move something must still leave kept entries untouched
    fs.writeFileSync(path.join(root, 'memory-bank', 'activeContext.md'), after1 + '\n## 2020-02-02 - second old entry\nMore old work.\n');
    run('app', '--root', root, '--write');
    const after3 = live(root);
    assert.equal(after3, after1.endsWith('\n') ? after1 : after1 + '\n');
    assert.equal((after3.match(/\n\n\n/g) || []).length, 0);
    const archive = fs.readFileSync(path.join(root, 'memory-bank', 'archive', 'activeContext-archive.md'), 'utf8');
    assert.equal((archive.match(/\n\n\n/g) || []).length, 0);
    assert.match(archive, /More old work\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planArchive: block already ending with a blank line gets no second one; last block without one gets exactly one', () => {
  const raw = '# T\n\n## 2020-01-01 old\nx\n\n## ' + todayText + ' new\ny';
  const plan = planArchive(raw, { days: 14, pendingPhrases: [] });
  assert.equal(plan.toMove.length, 1);
  assert.deepEqual(plan.live, ['# T', '', '## ' + todayText + ' new', 'y', '']);
});

test('planArchive: no `## ` entries returns null; undated entries are kept', () => {
  assert.equal(planArchive('# only title\ntext\n', { days: 14 }), null);
  const plan = planArchive('## no date here\nbody\n', { days: 14 });
  assert.equal(plan.toMove.length, 0);
});

test('parseDate: ISO and DD.MM.YYYY forms', () => {
  assert.equal(parseDate('## 2026-03-04 x').toISOString().slice(0, 10), '2026-03-04');
  assert.equal(parseDate('## 04.03.2026 x').toISOString().slice(0, 10), '2026-03-04');
  assert.equal(parseDate('## nothing'), null);
});

test('unknown repo name: usage error, exit 2', () => {
  const root = fixture();
  try {
    const r = run('nope', '--root', root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
