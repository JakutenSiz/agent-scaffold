// coordination-archive tests -- temp directory copies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { analyze, buildArchive, parseIso, writeArchive } from '../core/scripts/coordination-archive.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scripts', 'coordination-archive.mjs');
const TODAY = '2026-10-31';

const SOURCE = `# Agent Coordination

## Protocol
text

## Active claims

| Session | Item code | Since | State |
|---|---|---|---|
| a-1 | 1029-one-item | 2026-10-29 | ✅ DONE 2026-10-30 evidence \\| escaped |
continuation outside the cell
second continuation
| a-2 | 1030-open-item | 2026-10-30 | working |
| a-3 | 1010-forgotten | 2026-10-10 | working |
| a-4 | 1010-refreshed | 2026-10-10 | working refreshed 2026-10-28 |
| a-5 | 1028-other | 2026-10-28 | ✅ DONE 2026-10-31 |

## Open messages

- 2026-10-20 expired message [expires: 2026-10-25]
  second line of the bullet
- 2026-10-30 future message [expires: 2026-11-05]
- 2026-10-30 no expiry message

## Handed-over work

## Closed
`;
const ARCHIVE = `# Agent Coordination -- Archive

## ✅ Closed -- old section
content
`;

function setup({ source = SOURCE, archive = ARCHIVE, env = {}, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const file = path.join(dir, 'coordination.md');
  const arch = path.join(dir, 'coordination-archive.md');
  fs.writeFileSync(file, source);
  if (archive !== null) fs.writeFileSync(arch, archive);
  const gitEnv = scrubGitEnv();
  if (git) {
    const g = (...x) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', dir, ...x], { encoding: 'utf8', env: gitEnv });
    g('init', '-q'); g('add', '.'); g('commit', '-qm', 'x');
  }
  const run = (...args) => spawnSync('node', [SCRIPT, '--file', file, '--archive', arch, '--today', TODAY, ...args],
    { encoding: 'utf8', cwd: dir, env: { ...gitEnv, COORDINATION_CHECK: '', ...env } });
  return { dir, file, arch, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('dry run lists two closed rows and changes nothing', () => {
  const t = setup();
  try {
    const r = t.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /2 closed claim row/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), SOURCE);
    assert.equal(fs.readFileSync(t.arch, 'utf8'), ARCHIVE);
  } finally { t.cleanup(); }
});

test('--write moves closed rows with continuation lines above older archive content', () => {
  const t = setup();
  try {
    const r = t.run('--write');
    assert.equal(r.status, 0, r.stderr);
    const src = fs.readFileSync(t.file, 'utf8');
    assert.ok(!src.includes('a-1 |') && !src.includes('a-5 |') && !src.includes('continuation outside'));
    assert.ok(src.includes('a-2 |') && src.includes('a-3 |') && src.includes('a-4 |'));
    const arch = fs.readFileSync(t.arch, 'utf8');
    assert.match(arch, /^# Agent Coordination -- Archive\n\n## ✅ Closed -- coordination-archive 2026-10-31 -- 2 claim row\(s\)\n\| Session \| Item code \| Since \| State \|\n/);
    assert.ok(arch.includes('continuation outside the cell\nsecond continuation'));
    assert.ok(arch.indexOf('coordination-archive 2026-10-31') < arch.indexOf('old section'));
  } finally { t.cleanup(); }
});

test('second run after --write finds nothing to move', () => {
  const t = setup();
  try {
    t.run('--write');
    assert.match(t.run().stdout, /0 closed claim row/);
    assert.match(t.run('--write').stdout, /nothing to move/);
  } finally { t.cleanup(); }
});

test('--check exits 1 with the fix command while closed rows remain, 0 after --write', () => {
  const t = setup();
  try {
    const r = t.run('--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /2 closed claim row\(s\) still in the table\. Run first: node scripts\/coordination-archive\.mjs --write/);
    t.run('--write');
    assert.equal(t.run('--check').status, 0);
  } finally { t.cleanup(); }
});

test('--check: COORDINATION_CHECK=warn bypasses', () => {
  const t = setup({ env: { COORDINATION_CHECK: 'warn' } });
  try {
    assert.equal(t.run('--check').status, 0);
  } finally { t.cleanup(); }
});

test('--check ignores expired messages on their own', () => {
  const src = SOURCE.replace(/\| a-1 [^\n]*\ncontinuation outside the cell\nsecond continuation\n/, '').replace(/\| a-5 [^\n]*\n/, '');
  const t = setup({ source: src });
  try {
    assert.equal(t.run('--check').status, 0);
  } finally { t.cleanup(); }
});

test('--json: stale claim detected, refreshed claim and fresh claim are not', () => {
  const t = setup();
  try {
    const j = JSON.parse(t.run('--json').stdout);
    assert.equal(j.closedRows.length, 2);
    assert.deepEqual(j.staleClaims.map((s) => s.session), ['a-3']);
    assert.equal(j.expired.length, 1);
    assert.equal(j.expired[0].kind, 'bullet');
  } finally { t.cleanup(); }
});

test('--line: one line with counts, nothing when all zero', () => {
  const t = setup();
  try {
    const out = t.run('--line').stdout.trim();
    assert.equal(out.split('\n').length, 1);
    assert.equal(out, 'coordination: 2 closed claim row(s), 1 claim(s) older than 7 days, 1 expired note(s) -> node scripts/coordination-archive.mjs --write');
    t.run('--write');
    const after = t.run('--line').stdout.trim();
    assert.match(after, /^coordination: 1 claim\(s\) older than 7 days -> /);
  } finally { t.cleanup(); }
  const clean = setup({ source: '# x\n\n## Active claims\n\n| a | b | c | d |\n|---|---|---|---|\n' });
  try {
    assert.equal(clean.run('--line').stdout, '');
  } finally { clean.cleanup(); }
});

test('--write archives an expired bullet but keeps the future and the undated one', () => {
  const t = setup();
  try {
    assert.equal(t.run('--write').status, 0);
    const src = fs.readFileSync(t.file, 'utf8');
    assert.ok(!src.includes('expired message') && !src.includes('second line of the bullet'));
    assert.ok(src.includes('future message') && src.includes('no expiry message'));
    const arch = fs.readFileSync(t.arch, 'utf8');
    assert.match(arch, /## Archived notes -- 2026-10-31[^\n]*\n\n- 2026-10-20 expired message \[expires: 2026-10-25\]\n  second line of the bullet\n$/);
  } finally { t.cleanup(); }
});

const NOTES = `# Agent Coordination

## Protocol
protocol text
\`\`\`
## fenced heading inside protocol [expires: 2020-01-01]
\`\`\`

## Active claims

| Session | Item code | Since | State |
|---|---|---|---|

## Open messages

## NIGHT MODE -- yesterday [expires: 2026-10-30]
night body
line 2

## NOTE -- tomorrow [expires: 2026-11-01]
tomorrow body

## ✅ CLOSED -- x
closed body

## undated note
body
\`\`\`
## fenced heading inside a note [expires: 2020-01-01]
\`\`\`
`;

test('note sections: expired and closed headings move, future/undated/fenced stay', () => {
  const t = setup({ source: NOTES });
  try {
    const j = JSON.parse(t.run('--json').stdout);
    assert.deepEqual(j.expired.map((e) => e.heading), ['## NIGHT MODE -- yesterday [expires: 2026-10-30]']);
    assert.deepEqual(j.closedNotes, ['## ✅ CLOSED -- x']);
    assert.equal(t.run('--write').status, 0);
    const src = fs.readFileSync(t.file, 'utf8');
    assert.ok(!src.includes('NIGHT MODE') && !src.includes('closed body'));
    assert.ok(src.includes('## NOTE -- tomorrow') && src.includes('## undated note'));
    assert.ok(src.includes('## fenced heading inside protocol') && src.includes('## fenced heading inside a note'));
    const arch = fs.readFileSync(t.arch, 'utf8');
    assert.ok(arch.includes('### NIGHT MODE -- yesterday [expires: 2026-10-30]\nnight body\nline 2\n'));
    assert.ok(arch.endsWith('### ✅ CLOSED -- x\nclosed body\n\n') || arch.endsWith('### ✅ CLOSED -- x\nclosed body\n'));
  } finally { t.cleanup(); }
});

test('--check fails on a closed note section', () => {
  const t = setup({ source: NOTES });
  try {
    const r = t.run('--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /1 closed note section\(s\)/);
  } finally { t.cleanup(); }
});

test('a second --write on the same day appends under the same archive heading', () => {
  const t = setup({ source: NOTES });
  try {
    t.run('--write');
    fs.appendFileSync(t.file, '\n## another [expires: 2026-10-01]\nmore\n');
    assert.equal(t.run('--write').status, 0);
    const arch = fs.readFileSync(t.arch, 'utf8');
    assert.equal(arch.split('## Archived notes -- 2026-10-31').length, 2);
    assert.ok(arch.indexOf('### another') > arch.indexOf('### ✅ CLOSED -- x'));
  } finally { t.cleanup(); }
});

test('missing archive file is created by --write', () => {
  const t = setup({ archive: null });
  try {
    assert.equal(t.run('--write').status, 0);
    assert.match(fs.readFileSync(t.arch, 'utf8'), /^# Agent Coordination -- Archive\n\n## ✅ Closed -- coordination-archive 2026-10-31/);
  } finally { t.cleanup(); }
});

test('--write works on a dirty file (the freshly written DONE row is uncommitted); --force is accepted and ignored', () => {
  const t = setup({ git: true });
  try {
    fs.appendFileSync(t.file, '\nuncommitted\n');
    const r = t.run('--write');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.readFileSync(t.file, 'utf8').includes('a-1 |'));
  } finally { t.cleanup(); }
  const forced = setup({ git: true });
  try {
    fs.appendFileSync(forced.file, '\nuncommitted\n');
    assert.equal(forced.run('--write', '--force').status, 0);
  } finally { forced.cleanup(); }
  const clean = setup({ git: true });
  try {
    assert.equal(clean.run('--write').status, 0);
  } finally { clean.cleanup(); }
});

test('writeArchive writes nothing when the file changed between the first read and the write', () => {
  const t = setup();
  try {
    const first = fs.readFileSync(t.file, 'utf8');
    // The injected reader models a peer editing the file right after the first read.
    let reads = 0;
    const reader = (f) => (f === t.file && ++reads > 1 ? `${first}\n- peer note\n` : fs.readFileSync(f, 'utf8'));
    const r = writeArchive({ file: t.file, archiveFile: t.arch, today: parseIso(TODAY), staleDays: 7, read: reader });
    assert.equal(r.code, 1);
    assert.match(r.message, /changed while archiving; run again/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), first);
    assert.equal(fs.readFileSync(t.arch, 'utf8'), ARCHIVE);
    // Same reader without interference writes.
    const ok = writeArchive({ file: t.file, archiveFile: t.arch, today: parseIso(TODAY), staleDays: 7 });
    assert.equal(ok.code, 0);
    assert.ok(!fs.readFileSync(t.file, 'utf8').includes('a-1 |'));
  } finally { t.cleanup(); }
});

test('buildArchive keeps line conservation (source shrink equals moved lines)', () => {
  const today = parseIso(TODAY);
  const a = analyze(SOURCE, today);
  const built = buildArchive(SOURCE, ARCHIVE, a, today);
  assert.equal(SOURCE.split('\n').length - built.source.split('\n').length, built.movedLines);
  assert.equal(built.movedLines, 3 + 1 + 2);
});

test('missing coordination file: --line and --check are silent and exit 0', () => {
  const t = setup();
  try {
    fs.rmSync(t.file);
    for (const m of ['--line', '--check']) {
      const r = t.run(m);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
  } finally { t.cleanup(); }
});
