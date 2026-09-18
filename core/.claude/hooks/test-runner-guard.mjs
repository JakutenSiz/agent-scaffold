#!/usr/bin/env node
// Test-runner guard (PreToolUse Bash|PowerShell) — caps how many heavy test
// worker processes (e.g. a browser-automation runner) can pile up on the
// machine, and how many parallel workers a single run may use.
//
// Problem this solves: a test runner's default worker count can equal the
// CPU count, and each worker can spawn several child processes; back-to-back
// runs across sessions accumulate orphans until the machine chokes. Rule:
//   1) Only run the suite with a bounded worker count (config maxWorkers;
//      more is REJECTED).
//   2) If the machine already has more than maxProcesses of the configured
//      process running, REJECT a new run (clean up orphans first).
//
// Scope: a command line matching config.testRunner.triggerPattern. All other
// Bash/PowerShell commands are left alone (fast exit). Fully config-driven —
// see scripts/lib/config.mjs. Fails open (exit 0, no output) when this
// project has not installed the scaffold, or has not configured a
// testRunner.processName/triggerPattern.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../scripts/lib/config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const cmd = String(input?.tool_input?.command ?? '');

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

const tr = config.testRunner || {};
const PROCESS_NAME = tr.processName;
const MAX_WORKERS = tr.maxWorkers;
const MAX_PROCESSES = tr.maxProcesses;
const TRIGGER = tr.triggerPattern ? new RegExp(tr.triggerPattern) : null;
if (!PROCESS_NAME || !TRIGGER) process.exit(0); // not configured for this project

if (!TRIGGER.test(cmd)) process.exit(0);

const decide = (decision, reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
};

// 1) worker cap
const w = cmd.match(/--workers[= ]\s*(\d+)/) || cmd.match(/\bWORKERS\s*=\s*"?(\d+)/);
if (w && Number(w[1]) > MAX_WORKERS) {
  decide(
    'deny',
    `[test-runner-guard] --workers=${w[1]} is NOT ALLOWED: ${MAX_WORKERS} max. Each worker can spawn several ` +
      `${PROCESS_NAME} processes and overload the machine. Re-run with --workers=${MAX_WORKERS} or fewer (1 is the ` +
      'safest default).',
  );
}

// 2) orphaned/accumulated runner-process count
let count = 0;
try {
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${PROCESS_NAME}.exe`, '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const escaped = PROCESS_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    count = (out.match(new RegExp(escaped + '\\.exe', 'gi')) || []).length;
  } else {
    const out = execFileSync('sh', ['-c', `pgrep -fc ${PROCESS_NAME} || true`], { encoding: 'utf8', timeout: 5000 });
    count = Number(String(out).trim()) || 0;
  }
} catch {
  count = 0;
}
if (count > MAX_PROCESSES) {
  decide(
    'deny',
    `[test-runner-guard] ${count} '${PROCESS_NAME}' process(es) are already running (threshold ${MAX_PROCESSES}) — ` +
      'new test run REJECTED. Clean up orphans first (Windows: `Get-Process ' +
      `${PROCESS_NAME} -ErrorAction SilentlyContinue | Stop-Process -Force\`; POSIX: \`pkill -f ${PROCESS_NAME}\`) — ` +
      'if another run is genuinely still going, wait for it to finish instead — then retry with a bounded worker count.',
  );
}

process.exit(0);
