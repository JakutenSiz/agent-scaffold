#!/usr/bin/env node
// Enforces: R-27
// Context watch - UserPromptSubmit hook.
//
// WHY: in one measurement, 62% of a weekly quota went to re-reading a ~390k-token main
// context on every single call. Auto-compaction puts a ceiling on that; this hook catches
// the moment the work is DONE: when the context passes a threshold, or when the session was
// idle long enough for the prompt cache to expire, it injects a short note telling the agent
// to run the handoff skill (save notes + board -> commit -> push) and to ask the user to
// type /clear. The hook cannot run /clear itself.
//
// Triggers (config.session.context, see scripts/lib/config.mjs):
//   warnTokens      context size that triggers the "big" note (default 300000)
//   idleMinutes     idle gap after which the cache is considered cold (default 60)
//   idleMinTokens   below this size an idle restart is cheap, stay silent (default 100000)
//   handoffSkill    skill name to run (default "handoff")
//   offEnv          env var name; set it to "off" to disable the hook (default CONTEXT_WATCH)
//
// Per-session state lives in .claude/.context-watch/<session>.json so the "big" note is not
// repeated on every message (it repeats every REPEAT_EVERY messages).
//
// CAVEAT: the transcript file format is NOT a documented, stable API. This hook reads the
// last main-chain assistant `usage` block from the transcript tail; if the fields are
// missing or renamed it exits silently - it never blocks a prompt. Fails open on any error.
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

export const REPEAT_EVERY = 8; // messages between repeats of the "big" note in one session
const TAIL_BYTES = 4 * 1024 * 1024;

/** Last MAIN-chain assistant call in a transcript tail: { context, time } or null. */
export function lastUsage(tailText) {
  const lines = String(tailText || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"usage"')) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    const u = j?.message?.usage;
    if (j.type !== 'assistant' || j.isSidechain || !u) continue;
    const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!context) continue; // synthetic rows carry no usage
    const time = Date.parse(j.timestamp);
    return { context, time: Number.isFinite(time) ? time : null };
  }
  return null;
}

/**
 * @param {{ context: number, idleMinutes: number|null, sinceWarn: number|null }} s
 * @param {{ warnTokens: number, idleMinutes: number, idleMinTokens: number }} limits
 * sinceWarn: messages since the last "big" warning (null if never warned)
 */
export function decide({ context, idleMinutes, sinceWarn }, limits) {
  if (idleMinutes != null && idleMinutes >= limits.idleMinutes && context >= limits.idleMinTokens) return { kind: 'idle' };
  if (context >= limits.warnTokens && (sinceWarn == null || sinceWarn >= REPEAT_EVERY)) return { kind: 'big' };
  return { kind: 'none' };
}

export function noteText(decision, { context, idleMinutes }, { warnTokens, handoffSkill = 'handoff' }) {
  const ritual = `run the /${handoffSkill} skill (measured packet via node scripts/handoff-packet.mjs <item-code> --write, then board -> commit -> push), then tell the user in one line to type /clear and continue in a fresh session. You cannot run /clear yourself.`;
  const k = Math.round(context / 1000);
  if (decision.kind === 'idle')
    return `CONTEXT WATCH: the session sat idle for ${Math.round(idleMinutes)} min and the context is ${k}k tokens - the prompt cache expired, so this message makes the whole context be re-written. If this message starts a NEW job, BEFORE starting it ${ritual} If it continues the same job, carry on and do not repeat this note to the user.`;
  if (decision.kind === 'big')
    return `CONTEXT WATCH: context is ${k}k tokens (threshold ${Math.round(warnTokens / 1000)}k). Every call re-reads it. When the current piece of work is done, or if this message is a NEW job: ${ritual} If you are mid-task, finish it first, then hand off.`;
  return '';
}

function readTail(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Whole hook: returns the note string ('' = stay silent). `now` and `stateDir` are injectable. */
export function run(input, { now = Date.now(), stateDir } = {}) {
  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { root, config, found } = loadConfig(startDir);
  if (!found) return '';
  const ctx = config.session?.context ?? {};
  const limits = {
    warnTokens: ctx.warnTokens ?? 300000,
    idleMinutes: ctx.idleMinutes ?? 60,
    idleMinTokens: ctx.idleMinTokens ?? 100000,
  };
  const handoffSkill = ctx.handoffSkill ?? 'handoff';
  const offEnv = ctx.offEnv ?? 'CONTEXT_WATCH';
  if (/^off$/i.test(process.env[offEnv] || '')) return '';
  if (input.agent_id || !input.transcript_path) return ''; // subagents: main session only

  const last = lastUsage(readTail(input.transcript_path));
  if (!last) return '';

  const sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '').slice(0, 64);
  const dir = stateDir || path.join(root, '.claude', '.context-watch');
  const stateFile = path.join(dir, `${sid}.json`);
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {}
  const sinceWarn = Number.isFinite(state.counter) ? state.counter + 1 : null;

  const idleMinutes = last.time ? (now - last.time) / 60000 : null;
  const decision = decide({ context: last.context, idleMinutes, sinceWarn }, limits);

  try {
    mkdirSync(dir, { recursive: true });
    if (decision.kind === 'big') writeFileSync(stateFile, JSON.stringify({ counter: 0 }));
    else if (sinceWarn != null) writeFileSync(stateFile, JSON.stringify({ counter: sinceWarn }));
  } catch {}

  return noteText(decision, { context: last.context, idleMinutes }, { warnTokens: limits.warnTokens, handoffSkill });
}

if (isMainModule(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const now = Number(process.env.CONTEXT_WATCH_NOW) || Date.now();
    const note = run(input, { now });
    if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }));
  } catch {}
  process.exit(0);
}
