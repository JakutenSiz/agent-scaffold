// Test: core/scripts/orphan-process.mjs - pure parsing and decision logic; never runs ps or kills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { etimeMinutes, parsePs, compilePattern, isOrphan, findOrphans, summaryLine, writeEvidence } from '../core/scripts/orphan-process.mjs';

const SCRIPT = fileURLToPath(new URL('../core/scripts/orphan-process.mjs', import.meta.url));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const GB = 1024 * 1024; // KB per GB
const OPTS = { pattern: compilePattern('node --test'), maxAgeMinutes: 60, maxRssMB: 4096 };

test('etimeMinutes: formats', () => {
  near(etimeMinutes('05:12'), 5.2);
  near(etimeMinutes('01:02:03'), 62.05);
  near(etimeMinutes('02-03:04:05'), 2 * 1440 + 3 * 60 + 4 + 5 / 60);
  assert.equal(etimeMinutes('garbage'), 0);
});

test('parsePs: splits a ps line into fields and ignores junk lines', () => {
  const [s, ...rest] = parsePs('  123   1 02:03:04  2048 node --test a.mjs\nnot a ps line\n');
  assert.equal(rest.length, 0);
  assert.equal(s.pid, 123);
  assert.equal(s.ppid, 1);
  assert.equal(s.rssKb, 2048);
  assert.equal(s.command, 'node --test a.mjs');
  near(s.minutes, 123 + 4 / 60);
});

test('isOrphan: age threshold, both sides', () => {
  const command = 'node --test --test-timeout=60000 foo.test.mjs';
  assert.equal(isOrphan({ command, minutes: 59 }, OPTS), false);
  assert.equal(isOrphan({ command, minutes: 61 }, OPTS), true);
});

test('isOrphan: RSS over the limit is a candidate regardless of age; threshold is a parameter', () => {
  const command = 'node --test foo.test.mjs';
  assert.equal(isOrphan({ command, minutes: 2, rssKb: 5 * GB }, OPTS), true);
  assert.equal(isOrphan({ command, minutes: 2, rssKb: 3 * GB }, OPTS), false);
  assert.equal(isOrphan({ command, minutes: 2, rssKb: 3 * GB }, { ...OPTS, maxRssMB: 2048 }), true);
});

test('isOrphan: non-matching processes and the script itself are never targets, even when huge and old', () => {
  for (const command of ['claude', 'node /x/next dev', 'node scripts/orphan-process.mjs --kill', 'node scripts/orphan-process.mjs --test']) {
    assert.equal(isOrphan({ command, minutes: 9999, rssKb: 13 * GB }, OPTS), false, command);
  }
});

test('compilePattern: custom regex is honoured; an invalid one falls back to the default', () => {
  const custom = { ...OPTS, pattern: compilePattern('pytest|jest') };
  assert.equal(isOrphan({ command: 'python -m pytest tests', minutes: 500 }, custom), true);
  assert.equal(isOrphan({ command: 'node --test x', minutes: 500 }, custom), false);
  assert.equal(compilePattern('([bad').source, 'node --test');
});

test('findOrphans: filters ps output and excludes protected pids', () => {
  const ps = [' 10 1 03:00:00 100 node --test a.mjs', ' 11 1 00:01:00 100 node --test b.mjs', ' 12 1 05:00:00 100 vim notes.md', ' 13 1 04:00:00 100 node --test c.mjs'].join('\n');
  assert.deepEqual(findOrphans(ps, OPTS, [13]).map((s) => s.pid), [10]);
});

test('summaryLine: empty list gives an empty string (no SessionStart noise); otherwise count, age, memory', () => {
  assert.equal(summaryLine([]), '');
  const line = summaryLine([{ pid: 1, ppid: 1, minutes: 180, rssKb: 5 * GB, command: 'x' }, { pid: 2, ppid: 1, minutes: 70, rssKb: 1024, command: 'y' }]);
  assert.match(line, /^orphan test processes: 2 /);
  assert.match(line, /oldest 3\.0 h/);
  assert.match(line, /1 over 4096 MB/);
});

test('writeEvidence: JSON file with the process info is written to the given directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphans-'));
  try {
    const list = [{ pid: 77, ppid: 1, minutes: 5, rssKb: 9999, command: 'node --test x' }];
    const file = writeEvidence(list, { dir: join(dir, '.claude', '.orphans'), now: new Date('2026-11-14T10:00:00Z') });
    assert.match(file, /2026-11-14T10-00-00-000Z\.json$/);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.processes, list);
    assert.equal(readdirSync(join(dir, '.claude', '.orphans')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --line prints nothing or a single line and exits 0 (safe to run: lists only)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--line'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().split('\n').filter(Boolean).length <= 1);
});
