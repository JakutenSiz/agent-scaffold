// Test: core/.claude/hooks/codex-guard-adapter.mjs - Codex PreToolUse bridge.
// Uses fixture hooks and a fake settings.json only; it does not depend on any real shield.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard, diagnose, isRisky, compileRisky, bashHooks } from '../core/.claude/hooks/codex-guard-adapter.mjs';

const CORE = fileURLToPath(new URL('../core/', import.meta.url));
const payload = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't' });
const decision = (o) => o?.hookSpecificOutput?.permissionDecision;
const reason = (o) => o?.hookSpecificOutput?.permissionDecisionReason ?? '';
const node = (js) => `node -e "${js}"`;
const emit = (d, r) => node(`process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'${d}',permissionDecisionReason:'${r}'}}))`);
const ROOT = os.tmpdir();

test('isRisky: built-in generic classes and config patterns; harmless commands are not risky', () => {
  for (const c of ['git push origin x', 'git reset --hard', 'rm -rf build', 'ssh host ls', 'mysql -e x', 'curl -X POST http://x', 'sudo ls', 'npm publish']) {
    assert.equal(isRisky(c), true, c);
  }
  for (const c of ['ls -la', 'git status', 'cat a', 'grep a b', 'node --test a.test.mjs']) assert.equal(isRisky(c), false, c);
  const extra = compileRisky(['deployProd', '([invalid']);
  assert.equal(extra.length, 1);
  assert.equal(isRisky('run deployProd now', extra), true);
  assert.equal(isRisky('run deployProd now'), false);
});

test('ask from a hook becomes deny with an explanatory reason', () => {
  const out = guard(payload('echo x'), { hooks: [{ command: emit('ask', 'needs approval'), timeout: 10 }], root: ROOT, extraRisky: [] });
  assert.equal(decision(out), 'deny');
  assert.match(reason(out), /Codex cannot ask/);
  assert.match(reason(out), /needs approval/);
});

test('chaining: first deny wins, exit 2 + stderr counts as deny, allow-all returns {}', () => {
  const two = guard(payload('echo x'), { hooks: [{ command: emit('deny', 'first'), timeout: 10 }, { command: emit('deny', 'second'), timeout: 10 }], root: ROOT, extraRisky: [] });
  assert.equal(reason(two), 'first');
  const ex2 = guard(payload('echo x'), { hooks: [{ command: 'echo blocked >&2; exit 2', timeout: 10 }], root: ROOT, extraRisky: [] });
  assert.equal(decision(ex2), 'deny');
  assert.match(reason(ex2), /blocked/);
  assert.deepEqual(guard(payload('echo x'), { hooks: [{ command: 'true', timeout: 10 }, { command: emit('allow', 'ok'), timeout: 10 }], root: ROOT, extraRisky: [] }), {});
});

test('fail-closed only for risky commands: crash, malformed output, timeout', () => {
  const crash = [{ command: node('process.exit(7)'), timeout: 10 }];
  const bad = [{ command: 'echo not-json', timeout: 10 }];
  const slow = [{ command: node('setTimeout(()=>{},5000)'), timeout: 1 }];
  for (const hooks of [crash, bad, slow]) {
    assert.equal(decision(guard(payload('git push origin x'), { hooks, root: ROOT, extraRisky: [] })), 'deny');
    const warnings = [];
    assert.deepEqual(guard(payload('cat a'), { hooks, root: ROOT, extraRisky: [], warn: (m) => warnings.push(m) }), {});
    assert.equal(warnings.length, 1);
  }
});

test('config risky patterns extend the fail-closed class', () => {
  const crash = [{ command: node('process.exit(7)'), timeout: 10 }];
  const extra = compileRisky(['launchRocket']);
  assert.equal(decision(guard(payload('launchRocket --now'), { hooks: crash, root: ROOT, extraRisky: extra })), 'deny');
  assert.deepEqual(guard(payload('launchRocket --now'), { hooks: crash, root: ROOT, extraRisky: [], warn() {} }), {});
});

test('non-Bash tool, wrong event or missing command return {}', () => {
  const deny = [{ command: emit('deny', 'x'), timeout: 10 }];
  assert.deepEqual(guard({ ...payload('git push'), tool_name: 'apply_patch' }, { hooks: deny, root: ROOT }), {});
  assert.deepEqual(guard({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }, { hooks: deny, root: ROOT }), {});
  assert.deepEqual(guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, { hooks: deny, root: ROOT }), {});
});

test('a missing hook_event_name is evaluated normally; a present non-PreToolUse name still returns {}', () => {
  const deny = [{ command: emit('deny', 'x'), timeout: 10 }];
  const { hook_event_name: _drop, ...noEvent } = payload('git push');
  assert.equal(decision(guard(noEvent, { hooks: deny, root: ROOT })), 'deny');
  assert.deepEqual(guard({ ...noEvent, hook_event_name: 'PostToolUse' }, { hooks: deny, root: ROOT }), {});
});

test('the `if` condition filters hooks by command word', () => {
  const hooks = [{ command: emit('deny', 'git only'), timeout: 10, if: 'Bash(git *)' }];
  assert.deepEqual(guard(payload('ls'), { hooks, root: ROOT, extraRisky: [] }), {});
  assert.equal(decision(guard(payload('git status'), { hooks, root: ROOT, extraRisky: [] })), 'deny');
});

test('diagnose never claims verified enforcement; binding is detected; unknown CLI is unavailable', () => {
  const config = { hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/codex-guard-adapter.mjs --guard' }] }] } };
  const r = diagnose('codex-cli 1.2.3', config);
  assert.equal(r.binding, 'configured');
  assert.equal(r.compatibility, 'documented-schema-only');
  assert.equal(r.trust, 'unknown');
  assert.equal(r.runtime, 'unverified');
  assert.equal(r.enforcementVerified, false);
  assert.match(r.note, /enforcement not verified/);
  assert.equal(diagnose('unknown', config).compatibility, 'unavailable');
  assert.equal(diagnose('codex-cli 1.2.3', {}).binding, 'missing');
});

// --- CLI mode in a scratch project: fake settings.json + fixture hooks ---
function scratchProject(settings, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexguard-'));
  fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(CORE, '.claude/hooks/codex-guard-adapter.mjs'), path.join(root, '.claude/hooks/codex-guard-adapter.mjs'));
  for (const f of ['config.mjs', 'main-module.mjs']) fs.copyFileSync(path.join(CORE, 'scripts/lib', f), path.join(root, 'scripts/lib', f));
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(config ?? {}));
  fs.writeFileSync(path.join(root, 'fixture-deny.mjs'), "process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'fixture says no'}}));\n");
  fs.writeFileSync(path.join(root, 'fixture-crash.mjs'), 'process.exit(9);\n');
  return root;
}
const settingsFor = (...scripts) => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: scripts.map((s) => ({ type: 'command', command: `node ${s}`, timeout: 10 })) }] } });
function cli(root, stdin) {
  const r = spawnSync(process.execPath, [path.join(root, '.claude/hooks/codex-guard-adapter.mjs'), '--guard'], { input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), encoding: 'utf8', cwd: root, timeout: 60000 });
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, status: r.status };
}

test('CLI --guard: reads settings.json hooks, skips read-guard, denies via fixture hook', () => {
  const root = scratchProject(settingsFor('fixture-deny.mjs'));
  try {
    const r = cli(root, payload('echo hi'));
    assert.equal(r.status, 0);
    assert.equal(decision(r.out), 'deny');
    assert.match(reason(r.out), /fixture says no/);
    fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(settingsFor('read-guard.mjs', 'fixture-deny.mjs')));
    assert.equal(bashHooks(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --guard: config.codex.riskyPatterns drives fail-closed; unreadable stdin classified by text', () => {
  const root = scratchProject(settingsFor('fixture-crash.mjs'), { codex: { riskyPatterns: ['launchRocket'] } });
  try {
    assert.equal(decision(cli(root, payload('launchRocket now')).out), 'deny');
    assert.deepEqual(cli(root, payload('ls')).out, {});
    assert.deepEqual(cli(root, '{broken').out, {});
    assert.equal(decision(cli(root, '{broken git reset --hard').out), 'deny');
    assert.equal(decision(cli(root, '{broken launchRocket').out), 'deny');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --guard: missing settings.json is fail-closed for risky, {} for harmless', () => {
  const root = scratchProject({});
  try {
    fs.rmSync(path.join(root, '.claude/settings.json'));
    assert.equal(decision(cli(root, payload('git push')).out), 'deny');
    assert.deepEqual(cli(root, payload('ls')).out, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
