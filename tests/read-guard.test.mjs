// Tests for core/.claude/hooks/read-guard.mjs: shell-read counting, edit counter,
// recursion gate, state-dir override. The hook exits via process.exit at top level, so it
// runs as a child process. Each test builds its own temporary project (with a config) and
// points READ_GUARD_STATE_DIR at a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = path.join(repoRoot, 'core', '.claude', 'hooks', 'read-guard.mjs');

function setup(config = {}, { registerSid } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'read-guard-proj-'));
  fs.writeFileSync(path.join(project, 'agent-scaffold.config.json'), JSON.stringify(config));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-guard-state-'));
  if (registerSid) fs.writeFileSync(path.join(stateDir, 'mains.txt'), registerSid + ' x\n');
  return {
    project,
    stateDir,
    cleanup() {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function run(env, { mode, sid, tool, command, agentId }) {
  return spawnSync(process.execPath, [hookPath, mode], {
    input: JSON.stringify({
      cwd: env.project,
      session_id: sid,
      ...(agentId ? { agent_id: agentId } : {}),
      tool_name: tool,
      tool_input: command !== undefined ? { command } : {},
    }),
    encoding: 'utf8',
    env: { ...process.env, READ_GUARD_STATE_DIR: env.stateDir },
  });
}

function out(r) {
  assert.equal(r.status, 0, `exit 0 expected, stderr: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function withEnv(sid, config, fn) {
  const env = setup(config, { registerSid: sid });
  try {
    fn(env);
  } finally {
    env.cleanup();
  }
}

test('shell reads: 10 cat reads allowed, the 11th is denied and mentions Bash/PowerShell', () => {
  const sid = 'sid-shell-read-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 10; i++) {
      assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' }).stdout, '', `read ${i}`);
    }
    const o = out(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' }));
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /Bash\/PowerShell/);
  });
});

test('shell reads: countShell=false leaves shell reads uncounted', () => {
  const sid = 'sid-shell-off-' + process.pid;
  withEnv(sid, { delegation: { countShell: false } }, (env) => {
    for (let i = 1; i <= 12; i++) {
      assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' }).stdout, '');
    }
  });
});

test('non-read shell commands (git status) never count', () => {
  const sid = 'sid-shell-git-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 12; i++) {
      assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'git status' }).stdout, '');
    }
  });
});

test('Read tool: thresholds come from config', () => {
  const sid = 'sid-read-cfg-' + process.pid;
  withEnv(sid, { delegation: { denyAfterReads: 3 } }, (env) => {
    for (let i = 1; i <= 3; i++) assert.equal(run(env, { mode: 'pre', sid, tool: 'Read' }).stdout, '');
    const o = out(run(env, { mode: 'pre', sid, tool: 'Read' }));
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
    // subagent names from config are used in the brief
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /'scout'/);
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /'analyst'/);
  });
});

test('subagent payload (agent_id) is never counted or denied', () => {
  const sid = 'sid-subagent-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 12; i++) {
      assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt', agentId: 'w-1' }).stdout, '');
    }
  });
});

test('delegation (Agent) resets the read counter', () => {
  const sid = 'sid-agent-reset-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 10; i++) run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' });
    assert.equal(run(env, { mode: 'pre', sid, tool: 'Agent' }).stdout, '');
    for (let i = 1; i <= 10; i++) {
      assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' }).stdout, '', `after reset ${i}`);
    }
    const o = out(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' }));
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('post: reminder at the 5th read; non-read shell commands print nothing', () => {
  const sid = 'sid-post-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 5; i++) run(env, { mode: 'pre', sid, tool: 'Bash', command: 'cat foo.txt' });
    const o = out(run(env, { mode: 'post', sid, tool: 'Bash', command: 'cat foo.txt' }));
    assert.ok(o.hookSpecificOutput.additionalContext);
    assert.equal(run(env, { mode: 'post', sid, tool: 'Bash', command: 'git status' }).stdout, '');
  });
});

test('edit mode: silent below the warn threshold, one warning at 6, silent 7-12, deny from 13', () => {
  const sid = 'sid-edit-' + process.pid;
  withEnv(sid, { delegation: { warnAfterEdits: 6, denyAfterEdits: 12 } }, (env) => {
    for (let i = 1; i <= 5; i++) assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit' }).stdout, '', `edit ${i}`);
    const warn = out(run(env, { mode: 'edit', sid, tool: 'Edit' }));
    assert.ok(warn.hookSpecificOutput.additionalContext);
    assert.equal(warn.hookSpecificOutput.permissionDecision, undefined);
    for (let i = 7; i <= 12; i++) assert.equal(run(env, { mode: 'edit', sid, tool: 'Write' }).stdout, '', `edit ${i}`);
    const deny = out(run(env, { mode: 'edit', sid, tool: 'Edit' }));
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /'worker'/);
  });
});

test('edit mode: thresholds come from config; shell in-place edits feed the same counter', () => {
  const sid = 'sid-edit-shell-' + process.pid;
  withEnv(sid, { delegation: { warnAfterEdits: 2, denyAfterEdits: 3 } }, (env) => {
    assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit' }).stdout, '');
    assert.ok(out(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'sed -i s/a/b/ f' })).hookSpecificOutput.additionalContext);
    assert.equal(run(env, { mode: 'pre', sid, tool: 'Bash', command: 'sed -i s/a/b/ f' }).stdout, '');
    const deny = out(run(env, { mode: 'edit', sid, tool: 'Edit' }));
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('edit mode: delegation and reset clear the edit counter; subagents are exempt', () => {
  const sid = 'sid-edit-reset-' + process.pid;
  withEnv(sid, { delegation: { warnAfterEdits: 2, denyAfterEdits: 3 } }, (env) => {
    for (let i = 1; i <= 3; i++) run(env, { mode: 'edit', sid, tool: 'Edit' });
    run(env, { mode: 'pre', sid, tool: 'Agent' });
    assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit' }).stdout, '');
    for (let i = 1; i <= 3; i++) run(env, { mode: 'edit', sid, tool: 'Edit' });
    run(env, { mode: 'reset', sid });
    assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit' }).stdout, '');
    for (let i = 1; i <= 8; i++) {
      assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit', agentId: 'w-1' }).stdout, '');
    }
  });
});

test('recursion gate: a subagent spawning Agent/Task/Workflow is denied', () => {
  const env = setup({});
  try {
    for (const tool of ['Agent', 'Task', 'Workflow']) {
      const o = out(run(env, { mode: 'pre', sid: 'sid-rec', tool, agentId: 'w-1' }));
      assert.equal(o.hookSpecificOutput.permissionDecision, 'deny', tool);
      assert.match(o.hookSpecificOutput.permissionDecisionReason, /single-level/);
    }
    // the main session may delegate
    assert.equal(run(env, { mode: 'pre', sid: 'sid-rec', tool: 'Agent' }).stdout, '');
  } finally {
    env.cleanup();
  }
});

test('reset mode removes stale state files but keeps mains.txt', () => {
  const sid = 'sid-prune-' + process.pid;
  withEnv(sid, {}, (env) => {
    const stale = path.join(env.stateDir, 'old.cnt');
    fs.writeFileSync(stale, '3');
    const past = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(stale, past, past);
    assert.equal(run(env, { mode: 'reset', sid }).status, 0);
    assert.ok(!fs.existsSync(stale), 'stale file should be pruned');
    assert.ok(fs.existsSync(path.join(env.stateDir, 'mains.txt')), 'mains.txt must stay');
  });
});

test('state dir defaults to <root>/.claude/.read-guard when no override is given', () => {
  const sid = 'sid-default-dir-' + process.pid;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'read-guard-default-'));
  try {
    fs.writeFileSync(path.join(project, 'agent-scaffold.config.json'), '{}');
    const envNoOverride = { ...process.env };
    delete envNoOverride.READ_GUARD_STATE_DIR;
    const r = spawnSync(process.execPath, [hookPath, 'reset'], {
      input: JSON.stringify({ cwd: project, session_id: sid }),
      encoding: 'utf8',
      env: envNoOverride,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(project, '.claude', '.read-guard')));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('project without config: silent, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-guard-noconf-'));
  try {
    const r = spawnSync(process.execPath, [hookPath, 'pre'], {
      input: JSON.stringify({ cwd: dir, session_id: 's', tool_name: 'Agent', agent_id: 'w' }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit mode defaults: one warning at 15, never a deny', () => {
  const sid = 'sid-edit-default-' + process.pid;
  withEnv(sid, {}, (env) => {
    for (let i = 1; i <= 14; i++) assert.equal(run(env, { mode: 'edit', sid, tool: 'Edit' }).stdout, '', `edit ${i}`);
    const warn = out(run(env, { mode: 'edit', sid, tool: 'Edit' }));
    assert.ok(warn.hookSpecificOutput.additionalContext);
    assert.doesNotMatch(warn.hookSpecificOutput.additionalContext, /DENIED/);
    for (let i = 16; i <= 40; i++) assert.equal(run(env, { mode: 'edit', sid, tool: 'Write' }).stdout, '', `edit ${i}`);
  });
});
