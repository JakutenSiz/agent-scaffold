// Tests for core/.claude/hooks/test-runner-guard.mjs: the "is this a guarded test run" decision
// uses the command text AND the session cwd (a bare `npm test` inside the guarded project).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../core/.claude/hooks/test-runner-guard.mjs', import.meta.url));

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trguard-')));
  const config = { testRunner: { processName: 'zz-no-such-process', maxWorkers: 1, maxProcesses: 1000, triggerPattern: 'playwright|e2e' } };
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'e2e-suite'));
  fs.mkdirSync(path.join(root, 'other'));
  return root;
}
function run(root, cwd, command) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: path.join(root, cwd), tool_input: { command } }), encoding: 'utf8', timeout: 30000 });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
}
const FLAG = '--work' + 'ers=';
const MANY = `npm test -- ${FLAG}8`;

test('command text alone still triggers (no cwd involvement)', () => {
  const root = project();
  try {
    assert.equal(run(root, 'other', `npx playwright test ${FLAG}8`), 'deny');
    assert.equal(run(root, 'other', `npx playwright test ${FLAG}1`), 'allow');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bare npm test with many workers is caught when the session cwd is the guarded dir', () => {
  const root = project();
  try {
    assert.equal(run(root, 'e2e-suite', MANY), 'deny');
    assert.equal(run(root, 'e2e-suite', `npm run test -- ${FLAG}8`), 'deny');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the same bare npm test passes when the cwd is unrelated', () => {
  const root = project();
  try {
    assert.equal(run(root, 'other', MANY), 'allow');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unrelated command in the guarded cwd is left alone', () => {
  const root = project();
  try {
    assert.equal(run(root, 'e2e-suite', `ls ${FLAG}8`), 'allow');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
