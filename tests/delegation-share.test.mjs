// Test: core/scripts/delegation-share.mjs - pure counting + temp-dir end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, slugFor, shellClass, countTranscript, scanDir, buildReport, shareList, typeDetailList } from '../core/scripts/delegation-share.mjs';

const SCRIPT = fileURLToPath(new URL('../core/scripts/delegation-share.mjs', import.meta.url));

function row({ model = 'model-a', outTok = 10, tools = [] }) {
  return JSON.stringify({
    type: 'assistant',
    message: { model, usage: { output_tokens: outTok }, content: tools.map((t) => ({ type: 'tool_use', name: t.name, input: t.input || {} })) },
  });
}
const emptyCounter = (models = {}) => ({ tools: 0, byName: {}, models, outTok: 0, shell: {} });

test('parseArgs: days, dir and target are read; bad values fall back to defaults', () => {
  assert.deepEqual(parseArgs([]), { days: 14, dir: null, target: [20, 25], help: false });
  assert.equal(parseArgs(['--days', '7']).days, 7);
  assert.equal(parseArgs(['--days', 'nope']).days, 14);
  assert.equal(parseArgs(['--dir', '/x']).dir, '/x');
  assert.deepEqual(parseArgs(['--target', '10-15']).target, [10, 15]);
  assert.deepEqual(parseArgs(['--target', '30-10']).target, [20, 25]);
  assert.deepEqual(parseArgs(['--target', 'abc']).target, [20, 25]);
  assert.equal(parseArgs(['--help']).help, true);
});

test('slugFor: every non-alphanumeric character becomes a dash', () => {
  assert.equal(slugFor('C:\\Users\\dev\\git_repo\\my-proj'), 'C--Users-dev-git-repo-my-proj');
  assert.equal(slugFor('/home/dev/proj'), '-home-dev-proj');
});

test('shellClass: category examples', () => {
  assert.equal(shellClass('git commit -m "x"'), 'git-write');
  assert.equal(shellClass('git status'), 'git-read');
  assert.equal(shellClass('ssh user@host'), 'remote');
  assert.equal(shellClass('grep -rn foo src'), 'read/search');
  assert.equal(shellClass('sed -i s/a/b/ f'), 'file-write');
  assert.equal(shellClass('npm test'), 'test/gate');
  assert.equal(shellClass('node scripts/x.mjs'), 'script');
  assert.equal(shellClass('curl https://example.com'), 'curl');
  assert.equal(shellClass('mysql -u root'), 'db');
  assert.equal(shellClass('echo hello'), 'other');
  assert.equal(shellClass('cd /tmp && git status'), 'git-read');
});

test('countTranscript: tool calls, models, output tokens; skips blanks, junk and non-assistant rows', () => {
  const text = [
    row({ tools: [{ name: 'Read' }, { name: 'Bash', input: { command: 'git status' } }] }),
    row({ outTok: 5, tools: [{ name: 'Edit' }] }),
    '',
    'not-json',
    JSON.stringify({ type: 'user', message: {} }),
  ].join('\n');
  const r = countTranscript(text);
  assert.equal(r.tools, 3);
  assert.equal(r.byName.Bash, 1);
  assert.equal(r.shell['git-read'], 1);
  assert.equal(r.outTok, 15);
  assert.equal(r.models['model-a'], 2);
});

test('scanDir + buildReport: 1 main + 1 subagent session gives the right share and target verdict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegshare-'));
  try {
    fs.writeFileSync(path.join(tmp, 's1.jsonl'), row({ tools: [{ name: 'Read' }, { name: 'Bash', input: { command: 'cat x' } }, { name: 'Grep' }] }));
    const subDir = path.join(tmp, 's1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a.jsonl'), row({ outTok: 100, tools: [{ name: 'Read' }, { name: 'Edit' }] }));
    fs.writeFileSync(path.join(subDir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'worker' }));
    const s = scanDir(tmp, 14);
    assert.equal(s.sessionCount, 1);
    assert.equal(s.subCount, 1);
    assert.equal(s.main.tools, 3);
    assert.equal(s.sub.tools, 2);
    assert.deepEqual(s.types, { worker: 2 });
    assert.deepEqual(s.typeDetail, { worker: { count: 1, tokens: 100 } });
    const lines = buildReport({ days: 14, ...s });
    assert.ok(lines.some((l) => l.startsWith('MAIN SHARE: 60% (ABOVE target')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('TARGET BAND: 20-25%')));
    const wide = buildReport({ days: 14, target: [50, 70], ...s });
    assert.ok(wide.some((l) => l.includes('MAIN SHARE: 60% (within target)')));
    assert.ok(wide.some((l) => l.includes('TARGET BAND: 50-70%')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanDir: --days filter ignores old files; a missing directory yields an empty summary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegshare-days-'));
  try {
    fs.writeFileSync(path.join(tmp, 'old.jsonl'), row({ tools: [{ name: 'Read' }] }));
    fs.writeFileSync(path.join(tmp, 'new.jsonl'), row({ tools: [{ name: 'Read' }, { name: 'Edit' }] }));
    const old = new Date(Date.now() - 30 * 864e5);
    fs.utimesSync(path.join(tmp, 'old.jsonl'), old, old);
    const s = scanDir(tmp, 14);
    assert.equal(s.sessionCount, 1);
    assert.equal(s.main.tools, 2);
    const none = scanDir(path.join(tmp, 'does-not-exist'), 14);
    assert.equal(none.sessionCount, 0);
    assert.deepEqual(none.types, {});
    assert.ok(buildReport({ days: 14, ...none }).some((l) => l.includes('(no data)')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shareList and typeDetailList: ordering, percentages, empty marker', () => {
  assert.equal(shareList({ a: 58, b: 42 }), 'a 58 (58%), b 42 (42%)');
  assert.equal(shareList({}), '-');
  assert.equal(typeDetailList({ w: { count: 20, tokens: 300000 }, an: { count: 4, tokens: 200000 } }), 'an 4 / 200000 / 50000, w 20 / 300000 / 15000');
  assert.equal(typeDetailList({ z: { count: 0, tokens: 0 } }), '-');
  assert.ok(buildReport({ days: 1, sessionCount: 0, subCount: 0, main: emptyCounter({ m: 1 }), sub: emptyCounter(), sessions: [] }).some((l) => l === 'Main-session models: m 1 (100%)'));
});

test('CLI: --help prints usage and mentions Claude Code', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Claude Code only/);
  assert.match(r.stdout, /--target/);
});
