#!/usr/bin/env node
// Delegation guard v2 — turns "could not tell in advance how big the
// exploration would get" into a REPEATED, ENFORCED decision point.
//
// Modes (argv[2]):
//   pre   (PreToolUse Read|Grep|Glob|Agent|Workflow|Task):
//         - Read/Grep/Glob: counter++; once the main session crosses
//           denyAfterReads the tool call is DENIED (the model cannot keep
//           reading; it has to brief and hand off to a subagent).
//         - Agent/Workflow/Task: RESETS the counter — delegating renews the
//           reading allowance.
//   post  (PostToolUse Read|Grep|Glob): soft reminder at warnAfterReads.
//   reset (UserPromptSubmit): reset the counter + prune stale state files.
//
// SUBAGENT DETECTION: a subagent shares the same session_id as the main
// session, so mains.txt alone cannot tell them apart. The real signal is
// `agent_id`/`agent_type` in the hook payload — present ONLY on subagent
// calls, absent on the main session. So this guard: (a) never touches the
// read counter for a subagent, (b) DENIES a subagent's own Agent/Task/
// Workflow call (a subagent must not spawn its own subagent).
//
// Fully config-driven (thresholds, subagent names) — see
// scripts/lib/config.mjs. Fails open (exit 0, no output) when this project
// has not installed the scaffold.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {}

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

const WARN_AT = config.delegation.warnAfterReads;
const DENY_AFTER = config.delegation.denyAfterReads;
const WORKER_NAME = config.delegation.subagents?.worker || 'worker';
const SCOUT_NAME = config.delegation.subagents?.scout || 'scout';

// State dir lives under the resolved config root (which itself falls back to
// cwd when no config is found — moot here since we already exited above).
const stateDir = path.join(root, '.claude', '.read-guard');
try {
  mkdirSync(stateDir, { recursive: true });
} catch {}

const sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '').slice(0, 64);
const cntFile = path.join(stateDir, sid + '.cnt');
const mainsFile = path.join(stateDir, 'mains.txt');
const mode = process.argv[2] || 'post';

function isMainSession() {
  try {
    return readFileSync(mainsFile, 'utf8')
      .split('\n')
      .some((l) => l.split(' ')[0] === sid);
  } catch {
    return false;
  }
}
function readCount() {
  try {
    return parseInt(readFileSync(cntFile, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}
function writeCount(n) {
  try {
    writeFileSync(cntFile, String(n));
  } catch {}
}

if (mode === 'reset') {
  try {
    unlinkSync(cntFile);
  } catch {}
  try {
    for (const e of readdirSync(stateDir)) {
      if (e === 'mains.txt') continue;
      const p = path.join(stateDir, e);
      if (Date.now() - statSync(p).mtimeMs > 86_400_000) unlinkSync(p);
    }
  } catch {}
  process.exit(0);
}

const tool = String(input.tool_name || '');
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
// agent_id/agent_type are present ONLY on subagent calls (see note above).
const isSubagent = Boolean(input.agent_id || input.agent_type);

if (isSubagent) {
  // RECURSION GATE — a subagent must not spawn its own subagent, or the
  // agent tree folds in on itself and loops.
  if (mode === 'pre' && SPAWN_TOOLS.has(tool)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `[read-guard] YOU ARE A SUBAGENT (${WORKER_NAME}). A subagent cannot spawn its own subagent — the agent ` +
            'tree is single-level: only the main agent delegates. Finish the task yourself; if the scope is bigger ' +
            'than what you were given, STOP and report back to the main agent (what you found, what remains, how it ' +
            'should be split). The main agent will open a new subagent if needed.',
        },
      }),
    );
    process.exit(0);
  }
  process.exit(0); // subagent — do not touch the read counter
}

if (!isMainSession()) process.exit(0); // unregistered session — leave it alone

if (mode === 'pre') {
  if (SPAWN_TOOLS.has(tool)) {
    // Delegation happened — renew the reading allowance.
    try {
      unlinkSync(cntFile);
    } catch {}
    process.exit(0);
  }
  const n = readCount() + 1;
  writeCount(n);
  if (n > DENY_AFTER) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `[read-guard] This is read/search #${n} in the main context this turn — that is now a BIG exploration and ` +
            'you cannot keep going in the main context. Hand off what you have learned so far as a BRIEF to a ' +
            `subagent: which files you looked at, what you are looking for, what you are unsure about — '${SCOUT_NAME}' ` +
            `for mechanical scanning, a stronger model for deep flow understanding, '${WORKER_NAME}' for well-specified ` +
            'mechanical work. Nothing is lost; the brief is the subagent\'s starting point and it returns a ' +
            'decision-ready summary to you. (Calling Agent/Task/Workflow renews your reading allowance; a new user ' +
            'prompt also resets the counter.)',
        },
      }),
    );
  }
  process.exit(0);
}

// mode === 'post' — soft reminder (once, exactly at the warn threshold)
if (readCount() === WARN_AT) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[read-guard] ${WARN_AT} reads/searches have happened in the main context this turn. Anything past ` +
          `${DENY_AFTER} is DENIED — if this looks like it will keep growing, hand off to '${SCOUT_NAME}'/a subagent now ` +
          '(write down what you have learned as a brief) so it can return a summary to you.',
      },
    }),
  );
}
process.exit(0);
