// Tests for `agent-scaffold install`, the file-class table, the settings merge and the example project.
// Every test installs into its own temp dir; nothing here touches a real project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { classify, loadClasses } from '../bin/lib/classes.mjs';
import { mergeHooksConfig, hookTriples } from '../bin/lib/merge.mjs';
import { walkFiles } from '../bin/lib/util.mjs';
import { buildExample } from '../bin/make-example.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core');
const CLI = path.join(ROOT, 'bin', 'agent-scaffold.mjs');

const tmps = [];
function tmp(prefix = 'cli-install-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmps) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const FIXTURE = {
  version: 2,
  projectName: 'fixture-project',
  language: 'en',
  layout: 'single',
  humanGatekeeper: 'the project owner',
  humans: ['OWNER'],
  repos: [{ name: 'app', path: '.', stack: 'node', checks: {}, editCheck: [], deployBranches: ['main'], sourceExtensions: ['mjs'] }],
  secretScan: { failClosed: false },
};
function configFile() {
  const f = path.join(tmp('cfg-'), 'config.json');
  fs.writeFileSync(f, JSON.stringify(FIXTURE, null, 2));
  return f;
}
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: scrubGitEnv(), timeout: 120000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const install = (dir, ...extra) => run(['install', dir, '--config', configFile(), '--no-check', ...extra]);
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

/** Every regular file and directory under dir with its bytes: used to prove a run changed nothing. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs);
      if (e.isDirectory()) { out[`${rel}/`] = ''; walk(abs); }
      else if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
      else out[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test('every core file has a class (table covers the whole package)', () => {
  const rules = loadClasses();
  assert.ok(rules.length > 5);
  const files = walkFiles(CORE);
  assert.ok(files.length > 60);
  const unclassified = files.filter((f) => !classify(f));
  assert.deepEqual(unclassified, [], `core files without a class in bin/file-classes.json: ${unclassified.join(', ')}`);
  for (const f of files) assert.ok(['engine', 'seed', 'hybrid', 'merge'].includes(classify(f)), f);
  assert.equal(classify('scripts/not-in-the-table.xyz-never'), 'engine'); // scripts/** is engine
  assert.equal(classify('totally/unknown/path.bin'), null);
  assert.equal(classify('.claude/settings.json'), 'merge');
  assert.equal(classify('docs/agent-working-rules.md'), 'hybrid');
  assert.equal(classify('agent-scaffold.config.example.json'), 'seed');
});

test('fresh install: files land, templates are filled, manifest is deterministic', () => {
  const dir = tmp();
  const r = install(dir);
  assert.equal(r.code, 0, r.out);
  for (const rel of ['agent-scaffold.config.json', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'task-board.md', 'task-board-archive.md',
    'coordination.md', 'coordination-archive.md', 'memory-bank/repoMap.md', 'reports/README.md', 'specs/README.md',
    '.claude/hooks/git-shield.mjs', 'scripts/lib/config.mjs', '.githooks/pre-push', '.claude/settings.json', '.codex/hooks.json',
    '.gitignore', '.gitattributes', '.agent-scaffold/manifest.json']) assert.ok(exists(dir, rel), `missing ${rel}`);
  assert.doesNotMatch(read(dir, 'CLAUDE.md'), /\{\{[A-Z0-9_]+\}\}/);
  assert.match(read(dir, 'CLAUDE.md'), /fixture-project/);
  assert.equal(JSON.parse(read(dir, 'agent-scaffold.config.json')).projectName, 'fixture-project');
  const manifestText = read(dir, '.agent-scaffold/manifest.json');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.packageVersion, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest).sort(), ['files', 'packageVersion', 'schemaVersion']);
  assert.match(manifest.files['.claude/hooks/git-shield.mjs'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.files['.claude/hooks/git-shield.mjs'].class, 'engine');
  assert.equal(manifest.files['CLAUDE.md'].class, 'seed');
  assert.equal(manifest.files['docs/tool-traps.md'].class, 'hybrid');
  assert.equal(manifest.files['.claude/settings.json'].class, 'merge');
  assert.ok(!manifestText.includes(dir), 'manifest leaks an absolute path');
  assert.doesNotMatch(manifestText, /installedAt|20\d\d-\d\d-\d\dT/);
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(dir, '.githooks/pre-push')).mode & 0o100, 'pre-push must be executable');
    assert.ok(fs.statSync(path.join(dir, 'setup-hooks.sh')).mode & 0o100, 'setup-hooks.sh must be executable');
  }
  assert.ok(!exists(dir, 'agent-scaffold.config.example.json'));
  assert.ok(!exists(dir, 'templates'));
});

test('install refuses when a manifest exists and changes nothing', () => {
  const dir = tmp();
  assert.equal(install(dir).code, 0);
  const before = snapshot(dir);
  const r = install(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /use upgrade/);
  assert.deepEqual(snapshot(dir), before);
});

test('install never overwrites an existing file: it writes <file>.new and reports it', () => {
  const dir = tmp();
  write(dir, 'CLAUDE.md', 'my own guide\n');
  write(dir, 'scripts/md-size-watch.mjs', '// mine\n');
  write(dir, '.claude/hooks/git-shield.mjs', '// my shield\n');
  write(dir, 'docs/tool-traps.md', 'my traps\n');
  const r = install(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir, 'CLAUDE.md'), 'my own guide\n');
  assert.equal(read(dir, 'scripts/md-size-watch.mjs'), '// mine\n');
  assert.equal(read(dir, '.claude/hooks/git-shield.mjs'), '// my shield\n');
  assert.equal(read(dir, 'docs/tool-traps.md'), 'my traps\n');
  for (const rel of ['CLAUDE.md', 'scripts/md-size-watch.mjs', '.claude/hooks/git-shield.mjs', 'docs/tool-traps.md']) {
    assert.ok(exists(dir, `${rel}.new`), `${rel}.new missing`);
    assert.ok(r.out.includes(`${rel}.new`), `report does not list ${rel}.new`);
  }
  // A conflicting file is not claimed in the manifest.
  const manifest = JSON.parse(read(dir, '.agent-scaffold/manifest.json'));
  assert.equal(manifest.files['CLAUDE.md'], undefined);
});

test('settings.json: user hooks and permissions survive, missing scaffold wiring is added', () => {
  const dir = tmp();
  const userSettings = {
    model: 'my-model',
    permissions: { allow: ['Bash(my-tool *)'], deny: ['Bash(rm -rf *)'] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node my-start.mjs' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-bash-guard.mjs' }] }],
    },
  };
  write(dir, '.claude/settings.json', JSON.stringify(userSettings, null, 2));
  const r = install(dir);
  assert.equal(r.code, 0, r.out);
  const merged = JSON.parse(read(dir, '.claude/settings.json'));
  assert.equal(merged.model, 'my-model');
  assert.deepEqual(merged.permissions.deny, ['Bash(rm -rf *)']);
  assert.ok(merged.permissions.allow.includes('Bash(my-tool *)'));
  const pkg = JSON.parse(fs.readFileSync(path.join(CORE, '.claude/settings.json'), 'utf8'));
  for (const a of pkg.permissions.allow) assert.ok(merged.permissions.allow.includes(a), `allow lost: ${a}`);
  const have = new Set(hookTriples(merged).map((t) => t.key));
  for (const t of hookTriples(pkg)) assert.ok(have.has(t.key), `wiring missing: ${t.key}`);
  assert.ok(have.has('SessionStart||my-start.mjs'), 'the user SessionStart hook was lost');
  assert.ok(have.has('PreToolUse|Bash|my-bash-guard.mjs'), 'the user Bash hook was lost');
  assert.equal(r.out.includes('.claude/settings.json.new'), false);
});

test('merge is idempotent and never merges separate groups that share a matcher', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CORE, '.claude/settings.json'), 'utf8'));
  const once = mergeHooksConfig({}, pkg).value;
  const twice = mergeHooksConfig(once, pkg);
  assert.deepEqual(twice.value, once);
  assert.deepEqual(twice.added, []);
  // The package keeps two separate PreToolUse groups with the same matcher; the merge keeps them separate.
  const sameMatcher = (cfg) => (cfg.hooks.PreToolUse ?? []).filter((g) => g.matcher === 'Bash|PowerShell').length;
  assert.equal(sameMatcher(once), sameMatcher(pkg));
  assert.ok(sameMatcher(pkg) >= 2, 'fixture assumption: the package has two groups for one matcher');
  // A user file that already carries one of the two groups gets the other as a NEW group.
  const onlyFirst = structuredClone(pkg);
  onlyFirst.hooks.PreToolUse = onlyFirst.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes('test-runner-guard'));
  const healed = mergeHooksConfig(onlyFirst, pkg).value;
  assert.equal(sameMatcher(healed), sameMatcher(pkg));
  // Same for the Codex hooks file.
  const codex = JSON.parse(fs.readFileSync(path.join(CORE, '.codex/hooks.json'), 'utf8'));
  const c1 = mergeHooksConfig({}, codex).value;
  assert.deepEqual(mergeHooksConfig(c1, codex).value, c1);
});

test('.gitignore gets one marked block (idempotent), .gitattributes gets missing lines only', () => {
  const dir = tmp();
  write(dir, '.gitignore', 'node_modules/\nmine.log\n');
  write(dir, '.gitattributes', '*.png binary\n*.sh text eol=lf\n');
  assert.equal(install(dir).code, 0);
  const gi = read(dir, '.gitignore');
  assert.ok(gi.startsWith('node_modules/\nmine.log\n'));
  assert.equal(gi.split('.claude/.read-guard/').length - 1, 1);
  assert.match(gi, /\.agents\/skills/);
  const ga = read(dir, '.gitattributes');
  assert.ok(ga.startsWith('*.png binary\n*.sh text eol=lf\n'));
  assert.equal(ga.split('*.sh text eol=lf').length - 1, 1);
  assert.match(ga, /\*\.mjs text eol=lf/);
  // upgrade (second pass over the same merge code) leaves both byte-identical
  const before = { gi, ga };
  const up = run(['upgrade', dir, '--no-check']);
  assert.equal(up.code, 0, up.out);
  assert.equal(read(dir, '.gitignore'), before.gi);
  assert.equal(read(dir, '.gitattributes'), before.ga);
});

test('--dry-run writes nothing: an existing tree stays byte-identical, a missing dir stays missing', () => {
  const populated = tmp();
  write(populated, 'CLAUDE.md', 'keep\n');
  write(populated, '.claude/settings.json', '{"permissions":{"allow":["Bash(x)"]}}\n');
  write(populated, '.gitignore', 'a\n');
  const before = snapshot(populated);
  const r = install(populated, '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry-run/i);
  assert.match(r.out, /CLAUDE\.md\.new/);
  assert.deepEqual(snapshot(populated), before);

  const missing = path.join(tmp(), 'does-not-exist-yet');
  const r2 = install(missing, '--dry-run');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(fs.existsSync(missing), false);
});

test('core.hooksPath: set when empty, left alone (with a warning) when it points elsewhere', () => {
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: scrubGitEnv() });
  const empty = tmp();
  git(empty, 'init', '-q');
  assert.equal(install(empty).code, 0);
  assert.equal(git(empty, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), path.join(empty, '.githooks'));

  const other = tmp();
  git(other, 'init', '-q');
  git(other, 'config', '--local', 'core.hooksPath', '/somewhere/else');
  const r = install(other);
  assert.equal(r.code, 0, r.out);
  assert.equal(git(other, 'config', '--local', '--get', 'core.hooksPath').stdout.trim(), '/somewhere/else');
  assert.match(r.out, /core\.hooksPath/);
});

test('directory links are created like ensure-agent-compat does', () => {
  const dir = tmp();
  assert.equal(install(dir).code, 0);
  assert.equal(fs.realpathSync(path.join(dir, '.agents/skills')), fs.realpathSync(path.join(dir, '.claude/skills')));
  assert.equal(fs.realpathSync(path.join(dir, '.codex/hooks')), fs.realpathSync(path.join(dir, '.claude/hooks')));
});

test('syntax check loop runs by default and passes on a clean package', () => {
  const dir = tmp();
  const r = run(['install', dir, '--config', configFile()]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /syntax check/i);
});

test('usage errors exit 2', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['frobnicate']).code, 2);
  assert.equal(run(['install']).code, 2);
});

test('repomap-guard template ignores every scripts/lib file by pattern, not by name list', () => {
  const guard = JSON.parse(fs.readFileSync(path.join(CORE, 'templates/memory-bank/repomap-guard.json'), 'utf8'));
  assert.ok(guard.ignore.includes('^scripts/lib/'), JSON.stringify(guard.ignore));
  assert.ok(!guard.ignore.some((p) => /config\|main-module/.test(p)), 'the name list must be gone');
});

test('example project: regenerating reproduces examples/minimal (non-engine files + TREE.txt) exactly', () => {
  const out = tmp('example-');
  buildExample(out);
  const expected = snapshot(path.join(ROOT, 'examples', 'minimal'));
  const actual = snapshot(out);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'example tree drifted: run `npm run example`');
  for (const k of Object.keys(actual)) assert.equal(actual[k], expected[k], `example file drifted: ${k} (run \`npm run example\`)`);
  const tree = fs.readFileSync(path.join(out, 'TREE.txt'), 'utf8').split('\n').filter(Boolean);
  assert.ok(tree.includes('.claude/hooks/git-shield.mjs'), 'TREE.txt lists engine files too');
  assert.ok(tree.includes('CLAUDE.md'));
  assert.ok(!exists(out, '.claude/hooks/git-shield.mjs'), 'engine files are not copied into the example');
  const all = Object.keys(actual).filter((k) => !k.endsWith('/')).map((k) => fs.readFileSync(path.join(out, k), 'utf8')).join('\n');
  assert.ok(!all.includes(os.tmpdir()), 'absolute path leaked into the example');
  assert.ok(!all.includes(out), 'temp path leaked into the example');
  assert.doesNotMatch(all, /installedAt/);
});
