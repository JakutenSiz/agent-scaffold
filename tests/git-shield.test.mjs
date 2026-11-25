// Tests for core/.claude/hooks/git-shield.mjs.
// 1) Table tests on the pure functions.
// 2) Process tests: the hook runs as a child process with a real stdin payload inside a
//    temporary project that carries an agent-scaffold.config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDestructive, matchForbidden, isWorktreeAdd } from '../core/.claude/hooks/git-shield.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = path.join(repoRoot, 'core', '.claude', 'hooks', 'git-shield.mjs');

const DENY = [
  'git reset --hard',
  'git reset --hard origin/main',
  'cd sub && git reset --hard HEAD',
  'git -C sub reset --hard',
  'git checkout -- src/a.ts',
  'git checkout .',
  'git checkout main -- a.ts',
  'git checkout -f main',
  'git restore a.ts',
  'git restore --worktree --staged a.ts',
  'git clean -fd',
  'git clean -xdf',
  'git clean --force',
  'git stash',
  'git stash push -m x',
  'git stash -u',
  'git stash drop',
  'git stash clear',
  'git switch --discard-changes main',
  'git pull --rebase --autostash',
  'git status && git stash',
  'git -c core.x=y reset --hard',
];

const ALLOW = [
  'git status',
  'git log --oneline -- a.ts',
  'git diff -- a.ts',
  'git checkout main',
  'git checkout -b topic',
  'git restore --staged a.ts',
  'git clean -n',
  'git stash list',
  'git stash show -p',
  'git stash pop',
  'git reset HEAD a.ts',
  'git reset --soft HEAD~1',
  'git commit -m "do not use reset --hard"',
  "git commit -F- <<'EOF'\nnote: never run git reset --hard\nEOF",
  'echo "git clean -fd"',
  'AGENT_DESTRUCTIVE_OK=1 git reset --hard',
  'git pull --rebase',
  'git add -- a.ts',
  'grep -rn "reset --hard" reports',
];

for (const cmd of DENY) {
  test(`deny: ${cmd}`, () => {
    const r = isDestructive(cmd);
    assert.equal(r.destructive, true, `expected destructive: ${cmd}`);
    assert.ok(r.reason.length > 0);
  });
}

for (const cmd of ALLOW) {
  test(`allow: ${cmd}`, () => {
    assert.equal(isDestructive(cmd).destructive, false, `expected allowed: ${cmd}`);
  });
}

test('escape env name is configurable; PowerShell form accepted', () => {
  assert.equal(isDestructive('MY_OK=1 git reset --hard', { escapeEnv: 'MY_OK' }).destructive, false);
  assert.equal(isDestructive('AGENT_DESTRUCTIVE_OK=1 git reset --hard', { escapeEnv: 'MY_OK' }).destructive, true);
  assert.equal(isDestructive('$env:MY_OK = "1"; git reset --hard', { escapeEnv: 'MY_OK' }).destructive, false);
});

test('known gap: a quoted wrapper such as bash -c "git reset --hard" is not caught', () => {
  assert.equal(isDestructive('bash -c "git reset --hard"').destructive, false);
});

test('matchForbidden: pattern hit, miss, invalid regex skipped, empty list', () => {
  const list = [
    { pattern: '([unclosed', reason: 'broken' },
    { pattern: 'isolation=none', reason: 'no shared state' },
  ];
  assert.equal(matchForbidden('node --test --isolation=none', list).reason, 'no shared state');
  assert.equal(matchForbidden('node --test', list), null);
  assert.equal(matchForbidden('anything', []), null);
  assert.equal(matchForbidden('anything', undefined), null);
  // quoted text is stripped before matching
  assert.equal(matchForbidden('echo "isolation=none"', list), null);
});

test('isWorktreeAdd', () => {
  assert.equal(isWorktreeAdd('git worktree add ../wt -b x'), true);
  assert.equal(isWorktreeAdd('git -C sub worktree add ../wt'), true);
  assert.equal(isWorktreeAdd('git worktree list'), false);
  assert.equal(isWorktreeAdd('echo "git worktree add"'), false);
});

// --- process tests ---------------------------------------------------------

function makeProject(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shield-'));
  if (config) fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function run(dir, command, tool = 'Bash') {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd: dir, tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
  });
}

function withProject(config, files, fn) {
  const dir = makeProject(config, files);
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('process: git reset --hard -> deny, reason names the escape env', () => {
  withProject({}, {}, (dir) => {
    const r = run(dir, 'git reset --hard');
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('AGENT_DESTRUCTIVE_OK'));
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('--detach'));
  });
});

test('process: custom escapeEnv from config appears in the reason and lifts the deny', () => {
  withProject({ git: { shield: { escapeEnv: 'SHIELD_OFF' } } }, {}, (dir) => {
    const denied = JSON.parse(run(dir, 'git stash').stdout);
    assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes('SHIELD_OFF=1'));
    assert.equal(run(dir, 'SHIELD_OFF=1 git stash').stdout, '');
  });
});

test('process: PowerShell tool is covered too', () => {
  withProject({}, {}, (dir) => {
    const out = JSON.parse(run(dir, 'git clean -fd', 'PowerShell').stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('process: allowed command -> empty stdout, exit 0', () => {
  withProject({}, {}, (dir) => {
    const r = run(dir, 'git status');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

test('process: malformed stdin -> exit 0, empty stdout', () => {
  const r = spawnSync(process.execPath, [hookPath], { input: '{not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('process: project without config -> silent (fail-open)', () => {
  withProject(null, {}, (dir) => {
    const r = run(dir, 'git reset --hard');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

test('process: forbiddenCommands deny with the configured reason; bad regex skipped', () => {
  const cfg = {
    git: { shield: { forbiddenCommands: [{ pattern: '([bad', reason: 'x' }, { pattern: 'rm -rf /data', reason: 'never wipe data' }] } },
  };
  withProject(cfg, {}, (dir) => {
    const out = JSON.parse(run(dir, 'rm -rf /data').stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('never wipe data'));
    assert.equal(run(dir, 'ls').stdout, '');
  });
});

const WT = 'git worktree add ../wt-x -b x';
const hygieneScript = (branches, worktrees) =>
  `process.stdout.write(JSON.stringify({ branches: ${JSON.stringify(branches)}, worktrees: ${JSON.stringify(worktrees)} }));`;

test('hygiene debt: above threshold -> ask, mentions the cleanup command', () => {
  const files = { 'scripts/git-hygiene-clean.mjs': hygieneScript(['a', 'b', 'c', 'd'], ['w1', 'w2', 'w3']) };
  withProject({}, files, (dir) => {
    const out = JSON.parse(run(dir, WT).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('7'));
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('git-hygiene-clean.mjs --write'));
  });
});

test('hygiene debt: at or below threshold -> no decision', () => {
  const files = { 'scripts/git-hygiene-clean.mjs': hygieneScript(['a', 'b'], ['w1', 'w2', 'w3']) };
  withProject({}, files, (dir) => {
    assert.equal(run(dir, WT).stdout, '');
  });
});

test('hygiene debt: worktreeDebtAsk from config is honoured', () => {
  const files = { 'scripts/git-hygiene-clean.mjs': hygieneScript(['a', 'b'], []) };
  withProject({ git: { hygiene: { worktreeDebtAsk: 1 } } }, files, (dir) => {
    assert.equal(JSON.parse(run(dir, WT).stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
});

test('hygiene debt: missing script / garbage output -> fail-open', () => {
  withProject({}, {}, (dir) => {
    assert.equal(run(dir, WT).stdout, '');
  });
  withProject({}, { 'scripts/git-hygiene-clean.mjs': 'process.stdout.write("not json");' }, (dir) => {
    assert.equal(run(dir, WT).stdout, '');
  });
});

test('hygiene debt: result is cached under .claude/', () => {
  const files = { 'scripts/git-hygiene-clean.mjs': hygieneScript(['a', 'b', 'c'], ['w1', 'w2', 'w3']) };
  withProject({}, files, (dir) => {
    run(dir, WT);
    const cache = path.join(dir, '.claude', '.hygiene-json-cache.json');
    assert.ok(fs.existsSync(cache), 'cache file should exist');
    // break the script: the cached value must still drive the decision
    fs.writeFileSync(path.join(dir, 'scripts', 'git-hygiene-clean.mjs'), 'process.exit(1);');
    assert.equal(JSON.parse(run(dir, WT).stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
});

test('symlinked temp path: hook still runs its main block (shield is not silently off)', () => {
  // On macOS os.tmpdir() goes through /var -> /private/var; a naive main-module check
  // would skip main() and the shield would be silently disabled.
  const dir = makeProject({});
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(hookPath, path.join(dir, '.claude', 'hooks', 'git-shield.mjs'));
    for (const f of ['config.mjs', 'main-module.mjs']) {
      fs.copyFileSync(path.join(repoRoot, 'core', 'scripts', 'lib', f), path.join(dir, 'scripts', 'lib', f));
    }
    const r = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'git-shield.mjs')], {
      input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git stash' } }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout, 'decision output is empty: main block was skipped');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
