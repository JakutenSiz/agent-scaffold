// Tests for core/.claude/hooks/edit-check.mjs: repo matching must come from the file's ABSOLUTE
// path, so a worktree copy of a repo path and a session cwd below the project root both still
// run the configured check. The hook is run as a real child process in a scratch project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../core/.claude/hooks/edit-check.mjs', import.meta.url));

// A check that always fails and prints the directory it ran in.
const FAILING = 'node -e "console.log(\'ran-in:\'+process.cwd());process.exit(3)"';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editcheck-')));
  const config = { repos: [{ name: 'web', path: 'web', stack: 'node', editCheck: [{ glob: 'src/**/*.js', command: FAILING }] }] };
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(config));
  return root;
}
function runHook(cwd, file) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_input: { file_path: file } }), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
  });
  return { status: r.status, stderr: r.stderr };
}
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x\n'); return f; };

test('baseline: a file under the repo runs its check (cwd = project root)', () => {
  const root = project();
  try {
    const r = runHook(root, touch(path.join(root, 'web/src/a.js')));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /edit-check FAILED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session cwd is a sub-directory of the project: the check still runs', () => {
  const root = project();
  try {
    const file = touch(path.join(root, 'web/src/deep/a.js'));
    const r = runHook(path.join(root, 'web', 'src'), file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /edit-check FAILED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('file inside .worktrees/<name>/<same relative path>: the check runs, inside the worktree copy', () => {
  const root = project();
  try {
    const file = touch(path.join(root, '.worktrees/feat-x/web/src/a.js'));
    const r = runHook(root, file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ran-in:.*\.worktrees\/feat-x\/web/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worktree file + cwd = the worktree itself: the check runs', () => {
  const root = project();
  try {
    const wt = path.join(root, '.worktrees/feat-x');
    const file = touch(path.join(wt, 'web/src/a.js'));
    const r = runHook(path.join(wt, 'web'), file);
    assert.equal(r.status, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a file outside every repo glob stays silent', () => {
  const root = project();
  try {
    const r = runHook(root, touch(path.join(root, 'web/README.md')));
    assert.equal(r.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('serialize lock lives under the project root, not the cwd (cwd below root must not break it)', () => {
  const root = project();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'agent-scaffold.config.json'), 'utf8'));
    config.repos[0].editCheck[0].serialize = true;
    fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(config));
    const file = touch(path.join(root, 'web/src/a.js'));
    const sub = path.join(root, 'web', 'src');
    const r = runHook(sub, file);
    assert.equal(r.status, 2);
    assert.equal(fs.existsSync(path.join(sub, '.claude')), false);
    assert.equal(fs.existsSync(path.join(root, 'web', '.claude')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
