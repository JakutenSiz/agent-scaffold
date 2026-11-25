// Tests for the gate label table: core/scripts/lib/gates.mjs (registry) and
// core/scripts/gate-table.mjs (README generator).
//  - every hook command bound in core/.claude/settings.json is in the registry;
//  - every hook / git-hook script that declares `Enforces:` is in the registry;
//  - the README block equals the generated one (`--check` exits 0), `--write` only touches
//    the marked block and is idempotent;
//  - a label never contradicts behaviour: gates labelled `block` really deny on a fixture
//    (hook started as a child process with a real stdin payload), and a gate labelled `off`
//    really lets the same input through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(repoRoot, 'core');
const hooksDir = path.join(coreDir, '.claude', 'hooks');
const TABLE_CLI = path.join(coreDir, 'scripts', 'gate-table.mjs');
const README = path.join(repoRoot, 'README.md');
const BASES = ['block', 'ask', 'warn', 'measure', 'off'];
const PROFILES = ['minimal', 'standard', 'strict'];

const gatesMod = () => import('../core/scripts/lib/gates.mjs');
const baseOf = (label) => String(label).split(/[\s(]/)[0];

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function project(config) {
  const dir = tmpDir('gate-table-');
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc\n');
  return dir;
}

function runHook(file, dir, payload, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(hooksDir, file), ...args], {
    input: JSON.stringify({ cwd: dir, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  assert.equal(r.status, 0, `${file}: exit 0 expected, stderr: ${r.stderr}`);
  if (!r.stdout.trim()) return 'allow';
  const out = JSON.parse(r.stdout).hookSpecificOutput ?? {};
  return out.permissionDecision ?? 'allow';
}

// ---------------------------------------------------------------- registry coverage

test('registry: ids are unique, every label is one of block/ask/warn/measure/off in every profile', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const ids = GATES.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate gate id');
  const configs = profileConfigs();
  assert.deepEqual(Object.keys(configs), PROFILES);
  for (const g of GATES) {
    assert.ok(g.summary && g.file, `${g.id}: summary and file are required`);
    assert.ok(fs.existsSync(path.join(coreDir, g.file)), `${g.id}: ${g.file} does not exist`);
    for (const p of PROFILES) {
      const label = g.label(configs[p]);
      assert.ok(BASES.includes(baseOf(label)), `${g.id}/${p}: bad label ${JSON.stringify(label)}`);
    }
  }
});

test('registry: every hook command in core/.claude/settings.json has an entry', async () => {
  const { GATES, hookBindings } = await gatesMod();
  const bindings = hookBindings(coreDir);
  assert.ok(bindings.length >= 10, 'settings.json yielded too few bindings');
  for (const b of bindings) {
    const hit = GATES.some((g) => g.file === b.file && (g.arg ?? null) === (b.arg ?? null));
    assert.ok(hit, `no registry entry for ${b.file} ${b.arg ?? ''} (${b.event} ${b.matcher ?? ''})`);
  }
});

test('registry: every hook and git-hook script with an Enforces header has an entry', async () => {
  const { GATES, gitHookScripts } = await gatesMod();
  const files = new Set(GATES.map((g) => g.file));
  const wanted = [];
  for (const f of fs.readdirSync(hooksDir)) {
    if (!f.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(hooksDir, f), 'utf8');
    if (text.includes('Enforces:')) wanted.push(`.claude/hooks/${f}`);
  }
  for (const script of gitHookScripts(coreDir).values()) wanted.push(script);
  assert.ok(wanted.length >= 8, 'found too few hook files');
  for (const w of wanted) assert.ok(files.has(w), `${w} is not in the gate registry`);
});

test('registry: git-hook steps point at a script that a .githooks file really runs', async () => {
  const { GATES, gitHookScripts } = await gatesMod();
  const scripts = new Set(gitHookScripts(coreDir).values());
  const viaEntries = GATES.filter((g) => g.via);
  assert.ok(viaEntries.length >= 3);
  for (const g of viaEntries) assert.ok(scripts.has(g.via), `${g.id}: via ${g.via} is not run by a git hook`);
});

test('registry: new gates are present (secret-shield, done-gate, codex adapter)', async () => {
  const { GATES } = await gatesMod();
  const ids = GATES.map((g) => g.id);
  for (const id of ['secret-shield', 'done-gate', 'codex-guard-adapter', 'git-shield', 'read-guard-recursion', 'push-guard-confirm']) {
    assert.ok(ids.includes(id), `missing gate ${id}`);
  }
});

// ---------------------------------------------------------------- label derivation

test('labels follow the config keys the code reads', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const c = profileConfigs();
  const L = (id, p) => GATES.find((g) => g.id === id).label(c[p]);
  assert.equal(baseOf(L('secret-shield', 'minimal')), 'block');
  assert.match(L('secret-shield', 'strict'), /accident-level/);
  assert.equal(baseOf(L('read-guard-reads', 'minimal')), 'off');
  assert.equal(baseOf(L('read-guard-reads', 'standard')), 'block');
  assert.equal(baseOf(L('read-guard-edits', 'standard')), 'off');
  assert.equal(baseOf(L('read-guard-edits', 'strict')), 'block');
  assert.equal(baseOf(L('board-lint', 'minimal')), 'off');
  assert.equal(baseOf(L('board-lint', 'standard')), 'warn');
  assert.equal(baseOf(L('board-lint', 'strict')), 'block');
  assert.equal(baseOf(L('coordination-check', 'minimal')), 'warn');
  assert.equal(baseOf(L('coordination-check', 'standard')), 'block');
  assert.equal(baseOf(L('big-blob', 'standard')), 'warn');
  assert.equal(baseOf(L('big-blob', 'strict')), 'block');
  assert.equal(baseOf(L('push-guard-map', 'minimal')), 'off');
  assert.equal(baseOf(L('push-guard-map', 'standard')), 'block');
  assert.equal(baseOf(L('push-guard-confirm', 'minimal')), 'off');
  assert.equal(baseOf(L('push-guard-confirm', 'standard')), 'ask');
  assert.equal(baseOf(L('map-guardian-reuse', 'minimal')), 'off');
  assert.equal(baseOf(L('map-guardian-reuse', 'strict')), 'block');
  assert.equal(baseOf(L('done-gate', 'minimal')), 'off');
  assert.match(L('done-gate', 'standard'), /^block \(opt-in/);
  // an empty command disables the gate even in a blocking profile; with a command it is plain
  const withCommand = { ...c.strict, doneGate: { ...c.strict.doneGate, command: 'npm test' } };
  assert.equal(GATES.find((g) => g.id === 'done-gate').label(withCommand), 'block');
});

test('label() reads the config it is given (user override beats the profile)', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const c = profileConfigs();
  const secret = GATES.find((g) => g.id === 'secret-shield');
  assert.equal(baseOf(secret.label({ ...c.standard, secrets: { ...c.standard.secrets, mode: 'off' } })), 'off');
  assert.equal(baseOf(secret.label({ ...c.standard, secrets: { ...c.standard.secrets, mode: 'warn' } })), 'warn');
});

// ---------------------------------------------------------------- label vs behaviour

test('block labels hold: git-shield, secret-shield, recursion gate, test-runner-guard deny in every profile', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const configs = profileConfigs();
  const gate = (id) => GATES.find((g) => g.id === id);
  const FLAG = '--work' + 'ers=99';
  for (const p of PROFILES) {
    const dir = project({ profile: p });
    try {
      for (const id of ['git-shield', 'secret-shield', 'read-guard-recursion', 'test-runner-guard']) {
        assert.equal(baseOf(gate(id).label(configs[p])), 'block', `${id}/${p} label`);
      }
      assert.equal(runHook('git-shield.mjs', dir, { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }), 'deny', `git-shield/${p}`);
      assert.equal(runHook('secret-shield.mjs', dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, '.env') } }), 'deny', `secret-shield/${p}`);
      assert.equal(
        runHook('read-guard.mjs', dir, { session_id: 's-' + p, tool_name: 'Agent', agent_id: 'w', tool_input: {} }, { args: ['pre'], env: { READ_GUARD_STATE_DIR: dir } }),
        'deny', `read-guard-recursion/${p}`,
      );
      assert.equal(runHook('test-runner-guard.mjs', dir, { tool_name: 'Bash', tool_input: { command: `npx playwright test ${FLAG}` } }), 'deny', `test-runner-guard/${p}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an off label holds: secrets.mode off lets the secret read through, and the label says off', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const dir = project({ profile: 'standard', secrets: { mode: 'off' } });
  try {
    const cfg = { ...profileConfigs().standard, secrets: { ...profileConfigs().standard.secrets, mode: 'off' } };
    assert.equal(baseOf(GATES.find((g) => g.id === 'secret-shield').label(cfg)), 'off');
    assert.equal(runHook('secret-shield.mjs', dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, '.env') } }), 'allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read-guard-reads: strict denies past its threshold, minimal (label off) never denies', async () => {
  const { GATES, profileConfigs } = await gatesMod();
  const configs = profileConfigs();
  const gate = GATES.find((g) => g.id === 'read-guard-reads');
  const readsUntilDeny = (profile, max) => {
    const dir = project({ profile });
    const sid = `sid-${profile}-${process.pid}`;
    fs.writeFileSync(path.join(dir, 'mains.txt'), `${sid} x\n`);
    try {
      for (let i = 1; i <= max; i++) {
        const d = runHook('read-guard.mjs', dir, { session_id: sid, tool_name: 'Read', tool_input: {} }, { args: ['pre'], env: { READ_GUARD_STATE_DIR: dir } });
        if (d === 'deny') return i;
      }
      return 0;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(baseOf(gate.label(configs.strict)), 'block');
  assert.equal(readsUntilDeny('strict', 10), 7, 'strict denies the 7th read (denyAfterReads 6)');
  assert.equal(baseOf(gate.label(configs.minimal)), 'off');
  assert.equal(readsUntilDeny('minimal', 14), 0, 'minimal never denies a read');
});

// ---------------------------------------------------------------- README block

function runCli(args) {
  return spawnSync(process.execPath, [TABLE_CLI, ...args], { encoding: 'utf8', timeout: 30000 });
}

test('README block equals the generated table (--check exits 0)', () => {
  const r = runCli(['--check']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('README carries one begin/end marker pair and every registered gate id', async () => {
  const { GATES } = await gatesMod();
  const text = fs.readFileSync(README, 'utf8');
  assert.equal(text.split('<!-- gates:begin -->').length, 2);
  assert.equal(text.split('<!-- gates:end -->').length, 2);
  const block = text.slice(text.indexOf('<!-- gates:begin -->'), text.indexOf('<!-- gates:end -->'));
  for (const g of GATES) assert.ok(block.includes(`\`${g.id}\``), `${g.id} missing from the README block`);
});

test('--check fails on a stale block, --write repairs it and keeps every other byte', () => {
  const dir = tmpDir('gate-readme-');
  try {
    const before = 'Intro line\r\n\r\n## Other section\n\nkeep me  \n\n';
    const after = '\n## Tail\n\nlast words, no trailing newline';
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, `${before}<!-- gates:begin -->\nstale rows\n<!-- gates:end -->${after}`);

    const stale = runCli(['--check', '--readme', file]);
    assert.equal(stale.status, 1, 'a stale block must fail --check');

    const w = runCli(['--write', '--readme', file]);
    assert.equal(w.status, 0, w.stderr);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.startsWith(before + '<!-- gates:begin -->\n'), 'text before the block changed');
    assert.ok(written.endsWith('\n<!-- gates:end -->' + after), 'text after the block changed');
    assert.ok(!written.includes('stale rows'));
    assert.equal(runCli(['--check', '--readme', file]).status, 0);

    // idempotent
    assert.equal(runCli(['--write', '--readme', file]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), written);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a README without markers: --write and --check both fail and leave the file alone', () => {
  const dir = tmpDir('gate-readme-nomark-');
  try {
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, '# Title\n\nno markers here\n');
    assert.equal(runCli(['--write', '--readme', file]).status, 1);
    assert.equal(runCli(['--check', '--readme', file]).status, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Title\n\nno markers here\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
