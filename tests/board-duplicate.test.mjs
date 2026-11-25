import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, lineMatches, searchFile, codeTaken, slugify, monthDay, recentCommitWarnings, gitSafe,
} from '../core/scripts/board-duplicate.mjs';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/board-duplicate.mjs');

test('parseArgs: keywords, --code, --minutes with fallback', () => {
  assert.deepEqual(parseArgs(['a', 'b c', '--code', '0101-x', '--minutes', '30']), { words: ['a', 'b c'], code: '0101-x', minutes: 30 });
  assert.equal(parseArgs(['a', '--minutes', 'zero']).minutes, 90);
  assert.equal(parseArgs(['a', '--minutes', '-5']).minutes, 90);
});

test('lineMatches: case-insensitive containment', () => {
  assert.ok(lineMatches('Upload Retry Policy', 'retry'));
  assert.ok(!lineMatches('Upload', 'retry'));
});

test('searchFile: nearest heading, limit of 15 hits per file', () => {
  const text = ['# Top', '### 0101-a 🔴 First', 'needle here', '### 0102-b 🔴 Second', 'and a needle again'].join('\n');
  const hits = searchFile('board.md', text, ['needle']);
  assert.deepEqual(hits.map((h) => [h.line, h.heading]), [[3, '0101-a 🔴 First'], [5, '0102-b 🔴 Second']]);
  const many = Array.from({ length: 40 }, () => 'needle').join('\n');
  assert.equal(searchFile('x.md', many, ['needle']).length, 15);
});

test('codeTaken: exact code, a longer code does not collide', () => {
  const text = '### 0101-a 🔴 x\n### 0101-ab 🔴 y\n';
  assert.deepEqual(codeTaken(text, '0101-a'), { taken: true, line: 1 });
  assert.deepEqual(codeTaken(text, '0101-abc'), { taken: false, line: null });
  assert.equal(codeTaken('### 0101-ab 🔴 y\n', '0101-a').taken, false);
});

test('slugify and monthDay', () => {
  assert.equal(slugify('Déjà Vu: retry!'), 'deja-vu-retry');
  assert.equal(slugify('  '), '');
  assert.equal(monthDay(new Date(2026, 8, 5)), '0905');
});

test('recentCommitWarnings: minutes since the commit', () => {
  const w = recentCommitWarnings(['abc1234|1000|fix: one|two', ''], 1000 + 600, 'task-board.md');
  assert.deepEqual(w, ['! task-board.md commit 10 min ago: abc1234 fix: one|two']);
});

test('gitSafe: null outside a repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-dup-nogit-'));
  try { assert.equal(gitSafe(['log', '-1'], dir), null); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: no arguments -> usage and exit 2; matches -> verdict; no match -> free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-dup-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'task-board.md'), '### 0101-a 🔴 Upload retry\n');
    fs.writeFileSync(path.join(dir, 'task-board-archive.md'), '## 0001 old\nretry once\n');
    fs.writeFileSync(path.join(dir, 'task-board-archive-2026.md'), 'another retry line\n');
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...a], { encoding: 'utf8', env: scrubGitEnv() });
    const none = run();
    assert.equal(none.status, 2);
    assert.match(none.stdout, /Usage/);
    const hit = run('retry', '--code', '0101-a');
    assert.equal(hit.status, 0);
    assert.match(hit.stdout, /task-board-archive-2026\.md:1/);
    assert.match(hit.stdout, /CODE TAKEN \(line 1\)/);
    assert.match(hit.stdout, /MAY BE A DUPLICATE/);
    const free = run('zzzz-nothing');
    assert.match(free.stdout, /no match, a new item can be opened/);
    assert.match(free.stdout, /Suggested new item code: \d{4}-zzzz-nothing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
