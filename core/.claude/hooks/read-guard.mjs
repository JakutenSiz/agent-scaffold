#!/usr/bin/env node
// Enforces: R-01, R-02
// Delegation guard v3 — turns "could not tell in advance how big the
// exploration would get" into a REPEATED, ENFORCED decision point.
//
// Modes (argv[2]):
//   pre   (PreToolUse Read|Grep|Glob|Agent|Workflow|Task|Bash|PowerShell):
//         - Read/Grep/Glob: counter++; once the main session crosses
//           denyAfterReads the tool call is DENIED (the model cannot keep
//           reading; it has to brief and hand off to a subagent).
//         - Bash/PowerShell (only when delegation.countShell is true): a command that
//           lib/command-class.mjs classifies as a read (cat/grep/sed -n ...) goes to the
//           SAME counter and threshold, which closes the "read through the shell" hole
//           (one measurement: a main session made 2,292 reads that way and bypassed the
//           counter). An in-place edit command (sed -i, perl -pi, node -e writeFileSync)
//           feeds the edit counter instead (see `edit`). Anything else is not counted.
//         - Agent/Workflow/Task: RESETS both counters — delegating renews the allowance.
//   post  (PostToolUse Read|Grep|Glob|Bash|PowerShell): soft reminder at warnAfterReads
//         (for Bash/PowerShell only after commands classified as reads).
//   edit  (PreToolUse Edit|Write): separate edit counter for the main session.
//         At exactly warnAfterEdits: one-time additionalContext reminder. Past
//         denyAfterEdits (0 = off, the default): the call is DENIED with a "hand this
//         to a worker" message.
//   reset (UserPromptSubmit): reset both counters + prune stale state files.
//
// SUBAGENT DETECTION: a subagent shares the same session_id as the main
// session, so mains.txt alone cannot tell them apart. The real signal is
// `agent_id`/`agent_type` in the hook payload — present ONLY on subagent
// calls, absent on the main session. So this guard: (a) never touches the
// counters for a subagent, (b) DENIES a subagent's own Agent/Task/Workflow
// call (recursion gate: a subagent must not spawn its own subagent).
//
// State dir: <root>/.claude/.read-guard, overridable with READ_GUARD_STATE_DIR
// (test isolation). Fully config-driven (thresholds, subagent names) — see
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
import { isReadCommand, isEditCommand } from './lib/command-class.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {}

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

const WARN_AT = config.delegation.warnAfterReads;
const DENY_AFTER = config.delegation.denyAfterReads;
const EDIT_WARN_AT = config.delegation.warnAfterEdits ?? 15;
// 0 = never deny (default). The source project only ever warned; a project that wants the hard stop sets a number.
const EDIT_DENY_AFTER = config.delegation.denyAfterEdits ?? 0;
const COUNT_SHELL = config.delegation.countShell !== false;
const WORKER_NAME = config.delegation.subagents?.worker || 'worker';
const SCOUT_NAME = config.delegation.subagents?.scout || 'scout';
const ANALYST_NAME = config.delegation.subagents?.analyst || 'analyst';

const stateDir = process.env.READ_GUARD_STATE_DIR || path.join(root, '.claude', '.read-guard');
try {
  mkdirSync(stateDir, { recursive: true });
} catch {}

const sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '').slice(0, 64);
const cntFile = path.join(stateDir, sid + '.cnt');
const editFile = path.join(stateDir, sid + '.edit');
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
function readNumber(file) {
  try {
    return parseInt(readFileSync(file, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}
function writeNumber(file, n) {
  try {
    writeFileSync(file, String(n));
  } catch {}
}
function removeFile(file) {
  try {
    unlinkSync(file);
  } catch {}
}
function emit(event, fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }));
}

function readDenyReason(n, extra) {
  return (
    `[read-guard] This is read/search #${n} in the main context this turn — that is now a BIG exploration and ` +
    'you cannot keep going in the main context. Hand off what you have learned so far as a BRIEF to a ' +
    `subagent: which files you looked at, what you are looking for, what you are unsure about — '${SCOUT_NAME}' ` +
    `for mechanical scanning, '${ANALYST_NAME}' for deep flow understanding, '${WORKER_NAME}' for well-specified ` +
    "mechanical work. Nothing is lost; the brief is the subagent's starting point and it returns a " +
    'decision-ready summary to you. (Calling Agent/Task/Workflow renews your reading allowance; a new user ' +
    'prompt also resets the counter.)' +
    (extra ? ' ' + extra : '')
  );
}

// Bumps the edit counter; returns { deny } / { warn } / {} for this call.
function bumpEdit() {
  const n = readNumber(editFile) + 1;
  writeNumber(editFile, n);
  if (EDIT_DENY_AFTER > 0 && n > EDIT_DENY_AFTER) {
    return {
      deny:
        `[read-guard] This is file edit #${n} in the main context this turn — mechanical or multi-file work ` +
        `belongs to a '${WORKER_NAME}' subagent. Write a spec (which files, what change, how to check it) and ` +
        `hand it off; you decide and verify. (Calling Agent/Task/Workflow renews your editing allowance; a new ` +
        'user prompt also resets the counter.)',
    };
  }
  if (n === EDIT_WARN_AT) {
    return {
      warn:
        `[read-guard] ${EDIT_WARN_AT} file edits in the main context this turn` +
        (EDIT_DENY_AFTER > 0 ? `. Past ${EDIT_DENY_AFTER} they are DENIED` : '') +
        ` — mechanical or multi-file work goes to '${WORKER_NAME}' (write a spec, it applies, you verify). ` +
        'If this is a small single-file fix, carry on.',
    };
  }
  return {};
}
function emitEdit(res) {
  if (res.deny) emit('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: res.deny });
  else if (res.warn) emit('PreToolUse', { additionalContext: res.warn });
}

if (mode === 'reset') {
  removeFile(cntFile);
  removeFile(editFile);
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
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// agent_id/agent_type are present ONLY on subagent calls (see note above).
const isSubagent = Boolean(input.agent_id || input.agent_type);

if (isSubagent) {
  // RECURSION GATE — a subagent must not spawn its own subagent, or the
  // agent tree folds in on itself and loops.
  if (mode === 'pre' && SPAWN_TOOLS.has(tool)) {
    emit('PreToolUse', {
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[read-guard] YOU ARE A SUBAGENT (${WORKER_NAME}). A subagent cannot spawn its own subagent — the agent ` +
        'tree is single-level: only the main agent delegates. Finish the task yourself; if the scope is bigger ' +
        'than what you were given, STOP and report back to the main agent (what you found, what remains, how it ' +
        'should be split). The main agent will open a new subagent if needed.',
    });
    process.exit(0);
  }
  process.exit(0); // subagent — do not touch the counters
}

if (!isMainSession()) process.exit(0); // unregistered session — leave it alone

if (mode === 'edit') {
  emitEdit(bumpEdit());
  process.exit(0);
}

if (mode === 'pre') {
  if (SPAWN_TOOLS.has(tool)) {
    // Delegation happened — both allowances are renewed.
    removeFile(cntFile);
    removeFile(editFile);
    process.exit(0);
  }

  if (SHELL_TOOLS.has(tool)) {
    if (!COUNT_SHELL) process.exit(0);
    const cmd = String(input.tool_input?.command || '');
    if (isReadCommand(cmd)) {
      const n = readNumber(cntFile) + 1;
      writeNumber(cntFile, n);
      if (n > DENY_AFTER) {
        emit('PreToolUse', {
          permissionDecision: 'deny',
          permissionDecisionReason: readDenyReason(n, '(Reading through Bash/PowerShell with cat/grep/sed -n counts too.)'),
        });
      }
      process.exit(0);
    }
    if (isEditCommand(cmd)) emitEdit(bumpEdit());
    // neither a read nor an edit (git status, ls, node --check, npm test ...) — do not count.
    process.exit(0);
  }

  const n = readNumber(cntFile) + 1;
  writeNumber(cntFile, n);
  if (n > DENY_AFTER) {
    emit('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: readDenyReason(n) });
  }
  process.exit(0);
}

// mode === 'post' — soft reminder (once, exactly at the warn threshold)
if (SHELL_TOOLS.has(tool)) {
  if (!COUNT_SHELL) process.exit(0);
  if (!isReadCommand(String(input.tool_input?.command || ''))) process.exit(0);
}
if (readNumber(cntFile) === WARN_AT) {
  emit('PostToolUse', {
    additionalContext:
      `[read-guard] ${WARN_AT} reads/searches have happened in the main context this turn. Anything past ` +
      `${DENY_AFTER} is DENIED — if this looks like it will keep growing, hand off to '${SCOUT_NAME}'/'${ANALYST_NAME}' now ` +
      '(write down what you have learned as a brief) so it can return a summary to you.',
  });
}
process.exit(0);
