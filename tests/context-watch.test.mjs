// Test: core/.claude/hooks/context-watch.mjs - UserPromptSubmit context/idle note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastUsage, decide, noteText, REPEAT_EVERY } from '../core/.claude/hooks/context-watch.mjs';

const HOOK = fileURLToPath(new URL('../core/.claude/hooks/context-watch.mjs', import.meta.url));
const T0 = Date.parse('2026-11-10T10:00:00Z');
const LIMITS = { warnTokens: 300000, idleMinutes: 60, idleMinTokens: 100000 };

function line({ read = 0, write = 0, input = 5, side = false, time = T0, type = 'assistant' } = {}) {
  return JSON.stringify({
    type,
    isSidechain: side,
    timestamp: new Date(time).toISOString(),
    message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10 } },
  });
}

test('lastUsage: takes the last MAIN-chain call, skips sidechain and broken rows', () => {
  const text = [line({ read: 50000 }), line({ read: 180000, write: 2000 }), line({ read: 900000, side: true }), '{"usage" broken'].join('\n');
  assert.deepEqual(lastUsage(text), { context: 182005, time: T0 });
  assert.equal(lastUsage('{"type":"user"}\n'), null);
  assert.equal(lastUsage(''), null);
});

test('decide: silent below threshold; warns once above, then every REPEAT_EVERY messages', () => {
  assert.equal(decide({ context: 299999, idleMinutes: 1, sinceWarn: null }, LIMITS).kind, 'none');
  assert.equal(decide({ context: 300000, idleMinutes: 1, sinceWarn: null }, LIMITS).kind, 'big');
  assert.equal(decide({ context: 300000, idleMinutes: 1, sinceWarn: 3 }, LIMITS).kind, 'none');
  assert.equal(decide({ context: 300000, idleMinutes: 1, sinceWarn: REPEAT_EVERY }, LIMITS).kind, 'big');
});

test('decide: idle gap with a mid-size context warns regardless of the repeat counter; small sessions stay silent', () => {
  assert.equal(decide({ context: 120000, idleMinutes: 61, sinceWarn: 1 }, LIMITS).kind, 'idle');
  assert.equal(decide({ context: 60000, idleMinutes: 600, sinceWarn: null }, LIMITS).kind, 'none');
  assert.equal(decide({ context: 120000, idleMinutes: null, sinceWarn: null }, LIMITS).kind, 'none');
});

test('noteText: names the handoff skill, push and /clear; custom skill name is used', () => {
  const n = noteText({ kind: 'big' }, { context: 310400, idleMinutes: 2 }, { warnTokens: 300000, handoffSkill: 'wrapup' });
  assert.match(n, /310k/);
  assert.match(n, /\/wrapup/);
  assert.match(n, /push/);
  assert.match(n, /\/clear/);
  assert.match(noteText({ kind: 'idle' }, { context: 120000, idleMinutes: 95 }, { warnTokens: 300000 }), /95 min/);
  assert.equal(noteText({ kind: 'none' }, { context: 1, idleMinutes: 1 }, { warnTokens: 1 }), '');
});

function project(cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxwatch-'));
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(cfg));
  return root;
}
function exec(root, transcript, { now = T0 + 60000, sid = 's1', extra = {}, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcript, prompt: 'hello', cwd: root, ...extra }),
    encoding: 'utf8',
    env: { ...process.env, CONTEXT_WATCH_NOW: String(now), ...env },
  });
  return { code: r.status, out: r.stdout };
}

test('end to end: warns on a big context, then stays quiet, then warns again after an idle gap', () => {
  const root = project();
  try {
    const tr = path.join(root, 't.jsonl');
    fs.writeFileSync(tr, line({ read: 320000 }) + '\n');
    const first = exec(root, tr);
    assert.equal(first.code, 0);
    assert.match(JSON.parse(first.out).hookSpecificOutput.additionalContext, /320k/);
    assert.equal(exec(root, tr).out, '');
    assert.ok(fs.existsSync(path.join(root, '.claude', '.context-watch', 's1.json')));
    const idle = exec(root, tr, { now: T0 + 90 * 60000 });
    assert.match(JSON.parse(idle.out).hookSpecificOutput.additionalContext, /90 min/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: config overrides, small context, subagent, off switch, missing transcript, no config are silent', () => {
  const root = project({ session: { context: { warnTokens: 50000, handoffSkill: 'wrapup', offEnv: 'MY_OFF' } } });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxwatch-bare-'));
  try {
    const tr = path.join(root, 't.jsonl');
    fs.writeFileSync(tr, line({ read: 60000 }) + '\n');
    const hit = exec(root, tr);
    assert.match(JSON.parse(hit.out).hookSpecificOutput.additionalContext, /\/wrapup/);
    assert.deepEqual(exec(root, tr, { sid: 'a', extra: { agent_id: 'x' } }), { code: 0, out: '' });
    assert.deepEqual(exec(root, tr, { sid: 'b', env: { MY_OFF: 'off' } }), { code: 0, out: '' });
    assert.deepEqual(exec(root, path.join(root, 'missing.jsonl'), { sid: 'c' }), { code: 0, out: '' });
    fs.writeFileSync(tr, line({ read: 10000 }) + '\n');
    assert.deepEqual(exec(root, tr, { sid: 'd' }), { code: 0, out: '' });
    fs.writeFileSync(path.join(bare, 't.jsonl'), line({ read: 900000 }) + '\n');
    assert.deepEqual(exec(bare, path.join(bare, 't.jsonl')), { code: 0, out: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
