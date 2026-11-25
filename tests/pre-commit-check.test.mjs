// Tests for core/scripts/pre-commit-check.mjs (pre-commit gate).
// Each test builds a throwaway project, stages files, and runs the script the way the hook
// does (cwd = work tree root). Built-in lint scripts are replaced by tiny fixtures that
// record that they ran and exit with a chosen code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { matchesAny, planChecks, envKeyFor } from '../core/scripts/pre-commit-check.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/scripts/pre-commit-check.mjs');
const CLEAN = scrubGitEnv();

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-'))); }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args],
    { env: CLEAN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// A fixture lint script: appends its argv to ran.log, exits with `code`.
const fakeLint = (code, message = '') => `import fs from 'node:fs';
fs.appendFileSync('ran.log', process.argv.slice(1).map((a) => a.split('/').pop()).join(' ') + '\\n');
if (${JSON.stringify(message)}) console.error(${JSON.stringify(message)});
process.exit(${code});
`;

function project(config, files = {}) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'agent-scaffold.config.json', JSON.stringify({ version: 2, ...config }));
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  return dir;
}

function stage(dir, ...files) {
  for (const f of files) git(dir, 'add', f);
}

function runHook(cwd, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', env: { ...CLEAN, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const ranLog = (dir) => (fs.existsSync(path.join(dir, 'ran.log')) ? fs.readFileSync(path.join(dir, 'ran.log'), 'utf8') : '');

// ---------------------------------------------------------------- pure helpers

test('matchesAny: slash-less globs match the base name, others the relative path', () => {
  assert.ok(matchesAny('db/migrations/001.sql', ['*.sql']));
  assert.ok(matchesAny('db/migrations/001.sql', ['db/migrations/*.sql']));
  assert.ok(matchesAny('a/b/c.ts', ['**/*.{ts,tsx}']));
  assert.ok(!matchesAny('a/b/c.md', ['**/*.{ts,tsx}', 'src/*.js']));
});

test('envKeyFor builds a safe variable name from the check id', () => {
  assert.equal(envKeyFor('sql-lint'), 'PRE_COMMIT_SKIP_SQL_LINT');
});

test('planChecks is pure and empty when nothing staged matches', () => {
  const plan = planChecks(tmp(), { board: { file: 'board.md' }, preCommit: { checks: [{ id: 'x', command: 'true', whenStaged: ['*.sql'] }] } }, ['README.md']);
  assert.deepEqual(plan, []);
});

// ---------------------------------------------------------------- fail-open and no-op

test('no config: exit 0', () => {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'x');
  stage(dir, 'a.txt');
  assert.equal(runHook(dir).code, 0);
});

test('nothing matches: exit 0 and no process is started', () => {
  const dir = project({ board: { file: 'board.md' }, preCommit: { checks: [{ id: 'sql', command: 'node -e "require(\'fs\').writeFileSync(\'started\',\'1\')"', whenStaged: ['*.sql'] }] } },
    { 'scripts/board-lint.mjs': fakeLint(1), 'a.txt': 'x' });
  stage(dir, 'a.txt');
  const r = runHook(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(ranLog(dir), '');
  assert.ok(!fs.existsSync(path.join(dir, 'started')));
});

// ---------------------------------------------------------------- built-in checks

test('board staged: board-lint --staged runs; exit 1 stops the commit with the escape hatch', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(1, 'item 0101-x has no Remaining'), 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  const r = runHook(dir);
  assert.equal(r.code, 1);
  assert.match(ranLog(dir), /board-lint\.mjs --staged/);
  assert.match(r.out, /\[board\]/);
  assert.match(r.out, /item 0101-x has no Remaining/);
  assert.match(r.out, /BOARD_LINT=skip/);
});

test('board staged: exit 0 lets the commit through', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(0), 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  assert.equal(runHook(dir).code, 0);
  assert.match(ranLog(dir), /board-lint\.mjs --staged/);
});

test('board escape variable: BOARD_LINT=skip skips only the board check', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(1), 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  const r = runHook(dir, { BOARD_LINT: 'skip' });
  assert.equal(r.code, 0);
  assert.equal(ranLog(dir), '');
  assert.match(r.out, /skipped/);
});

test('coordination staged: coordination-archive --check runs; exit 1 stops', () => {
  const dir = project({ coordination: { file: 'coordination.md' } }, { 'scripts/coordination-archive.mjs': fakeLint(1, 'stale claim row'), 'coordination.md': '# c\n' });
  stage(dir, 'coordination.md');
  const r = runHook(dir);
  assert.equal(r.code, 1);
  assert.match(ranLog(dir), /coordination-archive\.mjs --check/);
  assert.match(r.out, /stale claim row/);
  assert.match(r.out, /COORDINATION_CHECK=skip/);
});

test('missing built-in script is skipped silently', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  const r = runHook(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('both built-ins red: one block lists both checks', () => {
  const dir = project({ board: { file: 'b.md' }, coordination: { file: 'c.md' } },
    { 'scripts/board-lint.mjs': fakeLint(1, 'board bad'), 'scripts/coordination-archive.mjs': fakeLint(1, 'coord bad'), 'b.md': '1', 'c.md': '2' });
  stage(dir, 'b.md', 'c.md');
  const r = runHook(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /board bad/);
  assert.match(r.out, /coord bad/);
});

// ---------------------------------------------------------------- project checks

test('project check: runs with matching files substituted for {files}; non-zero blocks', () => {
  const dir = project({ preCommit: { checks: [{ id: 'sql-lint', command: 'node check.mjs {files}', whenStaged: ['migrations/*.sql'] }] } }, {
    'check.mjs': `import fs from 'node:fs';
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
console.error('bad statement');
process.exit(1);
`,
    'migrations/001.sql': 'select 1;', 'migrations/002.sql': 'select 2;', 'other.sql': 'x',
  });
  stage(dir, 'migrations/001.sql', 'migrations/002.sql', 'other.sql');
  const r = runHook(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')), ['migrations/001.sql', 'migrations/002.sql']);
  assert.match(r.out, /\[sql-lint\]/);
  assert.match(r.out, /bad statement/);
  assert.match(r.out, /PRE_COMMIT_SKIP_SQL_LINT=1/);
});

test('project check: exit 0 passes; PRE_COMMIT_SKIP_<ID>=1 skips a failing one', () => {
  const cfg = (code) => ({ preCommit: { checks: [{ id: 'sql-lint', command: `node -e "process.exit(${code})"`, whenStaged: ['*.sql'] }] } });
  const ok = project(cfg(0), { 'a.sql': 'x' });
  stage(ok, 'a.sql');
  assert.equal(runHook(ok).code, 0);
  const red = project(cfg(1), { 'a.sql': 'x' });
  stage(red, 'a.sql');
  assert.equal(runHook(red).code, 1);
  assert.equal(runHook(red, { PRE_COMMIT_SKIP_SQL_LINT: '1' }).code, 0);
});

test('project check: custom skipEnv name is honoured and printed', () => {
  const dir = project({ preCommit: { checks: [{ id: 'x', command: 'node -e "process.exit(1)"', whenStaged: ['*.sql'], skipEnv: 'MY_SKIP' }] } }, { 'a.sql': 'x' });
  stage(dir, 'a.sql');
  const r = runHook(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /MY_SKIP=1/);
  assert.equal(runHook(dir, { MY_SKIP: '1' }).code, 0);
});

test('project checks run without the hook GIT_* variables (scrubbed) but the stage is still read from the real index', () => {
  const dir = project({ preCommit: { checks: [{ id: 'envcheck', command: 'node dump.mjs', whenStaged: ['*.sql'] }] } }, {
    'dump.mjs': `import fs from 'node:fs';
fs.writeFileSync('env.json', JSON.stringify(Object.keys(process.env).filter((k) => /^GIT_(DIR|INDEX_FILE|WORK_TREE)$/.test(k))));
`,
    'a.sql': 'x',
  });
  // Simulate `git commit -- <path>`: the hook sees a temporary index through GIT_INDEX_FILE.
  const tmpIndex = path.join(tmp(), 'index-tmp');
  execFileSync('git', ['-C', dir, 'add', 'a.sql'], { env: { ...CLEAN, GIT_INDEX_FILE: tmpIndex } });
  const r = runHook(dir, { GIT_INDEX_FILE: tmpIndex, GIT_DIR: path.join(dir, '.git') });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')), [], 'project check inherited git env');
  // The real index has nothing staged; only GIT_INDEX_FILE made a.sql visible -> proves the stage read kept the variable.
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
});

test('commit made in a nested repo (not the config root) is not gated', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(1) });
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'main');
  write(sub, 'task-board.md', 'x');
  stage(sub, 'task-board.md');
  assert.equal(runHook(sub).code, 0);
  assert.equal(ranLog(sub), '');
});

// ---------------------------------------------------------------- warn output

test('green check with output (warn mode): output is printed under a header and the commit goes through', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(0, 'WARN item 0101-x looks closed'), 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  const r = runHook(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /\[pre-commit\] board:/);
  assert.match(r.out, /WARN item 0101-x looks closed/);
  assert.doesNotMatch(r.out, /BLOCKED/);
});

test('green check without output stays silent', () => {
  const dir = project({ board: { file: 'task-board.md' } }, { 'scripts/board-lint.mjs': fakeLint(0), 'task-board.md': '# board\n' });
  stage(dir, 'task-board.md');
  assert.equal(runHook(dir).out, '');
});
