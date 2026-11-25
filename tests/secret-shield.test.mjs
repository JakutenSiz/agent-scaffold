// Tests for core/.claude/hooks/secret-shield.mjs.
// Every case runs the hook as a child process with a real stdin payload inside a temporary
// project that carries an agent-scaffold.config.json and a few secret-looking files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(repoRoot, 'core');
const hookPath = path.join(coreDir, '.claude', 'hooks', 'secret-shield.mjs');

const FILES = {
  '.env': 'TOKEN=abc\n',
  '.env.local': 'TOKEN=def\n',
  '.env.example': 'TOKEN=\n',
  'server.pem': 'x',
  'deploy.key': 'x',
  'deploy.pub': 'x',
  'id_rsa': 'x',
  'id_rsa.pub': 'x',
  '.npmrc': 'x',
  '.ssh/config': 'x',
  'sub/.env': 'x',
  'sub/service-account-prod.json': '{}',
  'sub/credentials.json': '{}',
  'README.md': 'hello\n',
  'src/app.js': 'x\n',
};

function makeProject(config = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-shield-')));
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function withProject(config, fn) {
  const dir = makeProject(config);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runRaw(dir, tool, toolInput, cwd = dir) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd, tool_name: tool, tool_input: toolInput }),
    encoding: 'utf8',
  });
}

function decisionOf(r) {
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  return out;
}

function isDeny(out) {
  return out?.hookSpecificOutput?.permissionDecision === 'deny';
}

function bash(dir, command, cwd) {
  return decisionOf(runRaw(dir, 'Bash', { command }, cwd));
}

const BASH_DENY = [
  // direct arguments
  'cat .env',
  'head -n 3 .env',
  'tail -f .env.local',
  'less .env',
  'grep TOKEN .env',
  'cp .env /tmp/leak',
  'mv .env .env.bak2',
  'sed -i s/a/b/ .env',
  'cat server.pem',
  'cat deploy.key',
  'cat id_rsa',
  'cat .ssh/config',
  'cat .npmrc',
  'cat sub/.env',
  'cat sub/service-account-prod.json',
  'cat sub/credentials.json',
  'cat ./.env',
  'cat sub/../.env',
  'cat ./sub/../sub/../.env',
  // redirections
  'cat < .env',
  'cat <.env',
  'echo x > .env',
  'echo x >> .env',
  'echo x >.env',
  'tr a b < .env | head',
  // wrappers
  'bash -c "cat .env"',
  "sh -c 'cat .env'",
  'bash -lc "echo hi && cat .env"',
  'bash -c "bash -c \'cat .env\'"',
  // source
  'source .env',
  '. .env',
  'set -a; . ./.env; set +a',
  // command substitution
  'echo $(cat .env)',
  'X=$(cat .env) && echo "$X"',
  'echo `cat .env`',
  // git show ref:path
  'git show HEAD:.env',
  'git show main:sub/.env',
  'git cat-file -p HEAD:.env',
  // wildcards
  'cat .e*',
  'cat .env*',
  'cat .en?',
  'cat .e[n]v',
  'cat *.pem',
  'cat sub/.e*',
  // quote fragmentation
  'cat .e"n"v',
  "cat .e'n'v",
  'cat ".env"',
  'cat .en""v',
  // chained
  'ls && cat .env',
  'ls; cat .env',
  'true || cat .env',
];

const BASH_ALLOW = [
  'cat .env.example',
  'cat deploy.pub',
  'cat id_rsa.pub',
  'cat README.md',
  'ls -la',
  'git status',
  'git show HEAD:README.md',
  'git commit -m "document the .env loading"',
  'echo hello',
  'node --test tests/a.test.mjs',
  'grep -rn TOKEN src',
  'cat src/app.js',
  'cat .env.example sub/../README.md',
  'cat *.md',
  'bash -c "cat README.md"',
  'cat .zzz*',
  'echo .env',
];

for (const cmd of BASH_DENY) {
  test(`bash deny: ${cmd}`, () => {
    withProject({}, (dir) => {
      const out = bash(dir, cmd);
      assert.ok(isDeny(out), `expected deny: ${cmd}\n got: ${JSON.stringify(out)}`);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /secret-shield/);
    });
  });
}

for (const cmd of BASH_ALLOW) {
  test(`bash allow: ${cmd}`, () => {
    withProject({}, (dir) => {
      assert.deepEqual(bash(dir, cmd), {}, `expected {} for: ${cmd}`);
    });
  });
}

test('bash deny: relative path resolved against the payload cwd (subdirectory)', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(bash(dir, 'cat .env', path.join(dir, 'sub'))));
    assert.ok(isDeny(bash(dir, 'cat ../.env', path.join(dir, 'sub'))));
    assert.deepEqual(bash(dir, 'cat ../README.md', path.join(dir, 'sub')), {});
  });
});

test('bash deny: absolute path and symlink to a protected file', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(bash(dir, `cat ${path.join(dir, '.env')}`)));
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
    assert.ok(isDeny(bash(dir, 'cat innocent.txt')));
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Read', { file_path: path.join(dir, 'innocent.txt') }))));
  });
});

test('bash deny: a file that does not exist yet is still blocked by name (write)', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(bash(dir, 'echo X=1 > sub/new/.env')));
    assert.ok(isDeny(bash(dir, 'cp README.md prod.pem')));
  });
});

test('PowerShell tool is covered like Bash', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(decisionOf(runRaw(dir, 'PowerShell', { command: 'Get-Content .env' }))));
    assert.deepEqual(decisionOf(runRaw(dir, 'PowerShell', { command: 'Get-Content README.md' })), {});
  });
});

// --- file tools ------------------------------------------------------------

test('Read/Edit/Write/MultiEdit/NotebookEdit payloads on a protected file are denied', () => {
  withProject({}, (dir) => {
    for (const [tool, input] of [
      ['Read', { file_path: path.join(dir, '.env') }],
      ['Edit', { file_path: path.join(dir, '.env.local'), old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: path.join(dir, 'sub', 'credentials.json'), content: 'x' }],
      ['MultiEdit', { file_path: path.join(dir, 'server.pem'), edits: [] }],
      ['NotebookEdit', { notebook_path: path.join(dir, 'id_rsa'), new_source: 'x' }],
      ['Read', { file_path: '.env' }],
    ]) {
      const out = decisionOf(runRaw(dir, tool, input));
      assert.ok(isDeny(out), `${tool} should be denied: ${JSON.stringify(input)}`);
    }
  });
});

test('Read/Edit/Write on allowed or ordinary files pass', () => {
  withProject({}, (dir) => {
    for (const [tool, input] of [
      ['Read', { file_path: path.join(dir, '.env.example') }],
      ['Read', { file_path: path.join(dir, 'deploy.pub') }],
      ['Edit', { file_path: path.join(dir, 'README.md'), old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: path.join(dir, 'src', 'new.js'), content: 'x' }],
    ]) {
      assert.deepEqual(decisionOf(runRaw(dir, tool, input)), {}, `${tool} ${JSON.stringify(input)}`);
    }
  });
});

test('Grep: path on a protected file, a glob that names one, or a literal protected path', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Grep', { pattern: 'TOKEN', path: path.join(dir, '.env') }))));
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Grep', { pattern: 'TOKEN', path: dir, glob: '.env' }))));
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Grep', { pattern: 'TOKEN', path: dir, glob: '**/*.pem' }))));
    assert.deepEqual(decisionOf(runRaw(dir, 'Grep', { pattern: 'TOKEN', path: path.join(dir, 'src') })), {});
    assert.deepEqual(decisionOf(runRaw(dir, 'Grep', { pattern: 'TOKEN', path: dir })), {});
  });
});

test('Glob: a pattern or path that targets a protected file', () => {
  withProject({}, (dir) => {
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Glob', { pattern: '.env*', path: dir }))));
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Glob', { pattern: '**/*.pem' }))));
    assert.ok(isDeny(decisionOf(runRaw(dir, 'Glob', { pattern: '.env' }))));
    assert.deepEqual(decisionOf(runRaw(dir, 'Glob', { pattern: 'src/**/*.js', path: dir })), {});
  });
});

// --- modes, config, robustness --------------------------------------------

test('mode: warn does not deny but injects a warning', () => {
  withProject({ secrets: { mode: 'warn' } }, (dir) => {
    const out = bash(dir, 'cat .env');
    assert.ok(!isDeny(out));
    assert.notEqual(out?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(String(out?.hookSpecificOutput?.additionalContext ?? ''), /secret-shield/);
    const out2 = decisionOf(runRaw(dir, 'Read', { file_path: path.join(dir, '.env') }));
    assert.match(String(out2?.hookSpecificOutput?.additionalContext ?? ''), /secret-shield/);
  });
});

test('mode: off is silent', () => {
  withProject({ secrets: { mode: 'off' } }, (dir) => {
    const r = runRaw(dir, 'Bash', { command: 'cat .env' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(r.stderr.trim(), '');
  });
});

test('config: custom protectedPaths and allow are honored', () => {
  withProject({ secrets: { protectedPaths: ['secret-*.txt', '**/vault/**'], allow: ['secret-ok.txt'] } }, (dir) => {
    fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret-1.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'secret-ok.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'vault', 'a'), 'x');
    assert.ok(isDeny(bash(dir, 'cat secret-1.txt')));
    assert.ok(isDeny(bash(dir, 'cat vault/a')));
    assert.deepEqual(bash(dir, 'cat secret-ok.txt'), {});
    // the default list was replaced, so .env is no longer protected here
    assert.deepEqual(bash(dir, 'cat .env'), {});
  });
});

test('there is no escape prefix an agent can type into the command', () => {
  withProject({}, (dir) => {
    for (const cmd of ['AGENT_DESTRUCTIVE_OK=1 cat .env', 'SECRET_SHIELD_OFF=1 cat .env', 'ALLOW_SECRETS=1 cat .env']) {
      assert.ok(isDeny(bash(dir, cmd)), cmd);
    }
  });
});

test('no config (scaffold not installed) -> silent', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-shield-bare-')));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'x');
    const r = runRaw(dir, 'Bash', { command: 'cat .env' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed stdin or empty payload -> silent exit 0 (fail-open)', () => {
  const r = spawnSync(process.execPath, [hookPath], { input: '{not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  withProject({}, (dir) => {
    const r2 = spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: {} }), encoding: 'utf8' });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.trim(), '');
  });
});

test('performance: a denied wildcard and a harmless command stay well under budget', () => {
  withProject({}, (dir) => {
    // warm-up (module load, file cache), then take the FASTEST of several runs per command:
    // the suite runs its files in parallel, so a median measures the machine's load, not the hook.
    bash(dir, 'ls');
    for (const command of ['cat .e*', 'ls -la src']) {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        runRaw(dir, 'Bash', { command });
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      // process spawn + node start is included; the budget for the hook itself is 100 ms
      console.log(`secret-shield fastest wall time incl. node start (${command}): ${best.toFixed(0)} ms`);
      assert.ok(best < 400, `${command}: fastest ${best} ms`);
    }
  });
});

// --- wiring ----------------------------------------------------------------

test('settings.json: a PreToolUse group covers all tool names and points at secret-shield.mjs', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(coreDir, '.claude', 'settings.json'), 'utf8'));
  const group = settings.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes('secret-shield.mjs')));
  assert.ok(group, 'secret-shield group missing');
  const names = group.matcher.split('|');
  for (const t of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'Bash', 'PowerShell']) {
    assert.ok(names.includes(t), `matcher lacks ${t}`);
  }
  assert.equal(group.hooks.some((h) => h.if), false, 'no if-condition: every command must be checked');
});

test('gitignore snippet ignores .env files but keeps .env.example', () => {
  const snippet = fs.readFileSync(path.join(coreDir, 'templates', 'gitignore.snippet'), 'utf8');
  const lines = snippet.split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('.env'));
  assert.ok(lines.includes('.env.*'));
  assert.ok(lines.includes('!.env.example'));
  assert.ok(lines.indexOf('!.env.example') > lines.indexOf('.env.*'), 'negation must come after the ignore');
});

test('codex adapter: the Bash group from settings.json runs secret-shield and denies', () => {
  const dir = makeProject({});
  try {
    fs.cpSync(path.join(coreDir, '.claude'), path.join(dir, '.claude'), { recursive: true });
    fs.cpSync(path.join(coreDir, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    const adapter = path.join(dir, '.claude', 'hooks', 'codex-guard-adapter.mjs');
    const call = (command) => {
      const r = spawnSync(process.execPath, [adapter, '--guard'], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir }),
        encoding: 'utf8',
        cwd: dir,
        timeout: 60000,
      });
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    };
    const denied = call('cat .env');
    assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /secret-shield/);
    assert.deepEqual(call('cat README.md'), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
