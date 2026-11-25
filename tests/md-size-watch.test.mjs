import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureText, buildTargets, warningLine } from '../core/scripts/md-size-watch.mjs';
import { DEFAULTS } from '../core/scripts/lib/config.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scripts', 'md-size-watch.mjs');

// Fixture project: a config file plus a board; run the script with --root from the repo's own script path.
function run(boardText, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-size-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), '{}');
    fs.writeFileSync(path.join(dir, DEFAULTS.board.file), boardText);
    return spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('few lines but huge UTF-8 content trips the byte and longest-line ceilings; default exit 0', () => {
  const res = run('ş'.repeat(150_000), ['--line']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /bytes=300000\/262144/);
  assert.match(res.stdout, /longest-line=150000\/4096/);
});

test('--strict fails on byte overrun, also in --line mode', () => {
  assert.equal(run('x'.repeat(300_000), ['--strict']).status, 1);
  assert.equal(run('x'.repeat(300_000), ['--line', '--strict']).status, 1);
});

test('longest-line ceiling trips alone; code points are counted, not UTF-16 units', () => {
  const over = run('x'.repeat(5000), ['--line', '--strict']);
  assert.equal(over.status, 1);
  assert.match(over.stdout, /longest-line=5000\/4096/);
  assert.doesNotMatch(over.stdout, /bytes=/);
  const emoji = run('\u{1F600}'.repeat(3000), ['--line', '--strict']);
  assert.equal(emoji.status, 0);
  assert.equal(emoji.stdout, '');
});

test('small file: --line prints nothing (contract: one line or nothing)', () => {
  const res = run('# Board\nShort.\n', ['--line', '--strict']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('--root without a directory is a usage error', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('line ceiling still works and counts lines', () => {
  const t = { file: 'f.md', lines: 3, bytes: 1000, lineChars: 100 };
  const m = measureText('a\nb\nc\nd', t);
  assert.deepEqual(m.over, ['lines=4/3']);
});

test('buildTargets reads every ceiling from config', () => {
  const targets = buildTargets({
    ...DEFAULTS,
    board: { ...DEFAULTS.board, ceiling: 1, ceilingBytes: 2, maxLineChars: 3 },
    coordination: { ...DEFAULTS.coordination, ceiling: 4, ceilingBytes: 5 },
    memoryBank: { ...DEFAULTS.memoryBank, ceiling: 6, ceilingBytes: 7 },
    repos: [{ name: 'r', path: 'sub' }],
  });
  assert.deepEqual(targets[0], { file: DEFAULTS.board.file, lines: 1, bytes: 2, lineChars: 3 });
  assert.equal(targets[1].bytes, 5);
  assert.equal(targets[2].file, path.join('sub', 'memory-bank', 'activeContext.md'));
  assert.equal(targets[2].bytes, 7);
  assert.equal(targets[3].lines, 6);
});

test('warningLine is empty when nothing is over', () => {
  assert.equal(warningLine([]), '');
});
