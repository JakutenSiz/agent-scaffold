#!/usr/bin/env node
// Enforces: R-46
// Codex PreToolUse bridge.
//
// `--guard`: takes Codex's Bash PreToolUse stdin JSON, replays it unchanged to every hook that
// .claude/settings.json binds to Bash under PreToolUse, and merges the decisions. Codex does not
// support the `ask` permission decision, so `ask` is turned into `deny`.
//
// FAIL-CLOSED only for risky commands: if a hook crashes, times out or prints malformed output
// AND the command is in the risky class, the command is denied; for a harmless command the
// adapter prints `{}` and a stderr warning instead. Risky class = the built-in generic patterns
// below (git writes / destructive git family, recursive rm, remote shells, database clients,
// mutating HTTP calls, publish, sudo) + config.codex.riskyPatterns (array of regex strings).
//
// Skipped hooks: ones that only make sense for a Claude session (e.g. the read-counter in
// read-guard.mjs - delegation counting is meaningless in Codex and is not a safety shield).
//
// Diagnose mode (no flag): `node codex-guard-adapter.mjs "<codex --version output>" [.codex/hooks.json]`
// prints what is configured. It is HONEST about what it cannot know: enforcement is never
// reported as verified, because Codex only runs project hooks after the project is trusted
// (re-trust after every hook change).
//
// Always exits 0 in --guard mode (the decision is in the JSON); fails open on internal errors
// for harmless commands.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

// Project root from the adapter's own location (<root>/.claude/hooks/): when Codex runs inside
// a nested repo, `git rev-parse --show-toplevel` would give the nested root and the hooks
// would not be found.
const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIPPED = ['read-guard.mjs'];
// Total time budget (ms) - keep it below the timeout in .codex/hooks.json.
const TOTAL_BUDGET_MS = 32_000;
// Built-in fail-closed class.
export const BUILTIN_RISKY = [
  /\bgit\b[^\n]*\b(push|reset|stash|checkout|restore|clean|rebase|merge|pull|switch|worktree|branch)\b/,
  /\brm\s+-[a-zA-Z]*[rRf]/, /\b(ssh|scp|sftp|rsync)\b/, /\bmysql(dump)?\b/,
  /\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--request|\s-d\b|--data|\s-F\b|--form|\s-T\b)/i,
  /\bwget\b[^\n]*--(post|method)/i, /\bnpm\s+publish\b/, /\b(sudo|systemctl)\b/,
];

/** Compile config.codex.riskyPatterns (regex strings); invalid entries are skipped. */
export function compileRisky(patterns) {
  const out = [];
  for (const p of Array.isArray(patterns) ? patterns : []) {
    try { out.push(new RegExp(String(p))); } catch { /* skip invalid pattern */ }
  }
  return out;
}

export const isRisky = (command, extra = []) => [...BUILTIN_RISKY, ...extra].some((r) => r.test(String(command ?? '')));

const output = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });

// settings.json -> PreToolUse handlers bound to Bash: [{command, timeout, if}]
export function bashHooks(root) {
  let settings = {};
  try { settings = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')); } catch { return null; }
  const list = [];
  for (const g of settings?.hooks?.PreToolUse ?? []) {
    if (!String(g.matcher ?? '').split('|').includes('Bash')) continue;
    for (const h of g.hooks ?? []) {
      if (h.type !== 'command' || SKIPPED.some((a) => h.command.includes(a))) continue;
      list.push({ command: h.command, timeout: h.timeout ?? 10, if: h.if });
    }
  }
  return list;
}

// Supports the `Bash(<word> *)` condition form used in settings.json.
const ifPasses = (cond, command) => {
  const m = /^Bash\((\S+) \*\)$/.exec(cond ?? '');
  return !m || new RegExp(`\\b${m[1].replace(/[^\w-]/g, '')}\\b`).test(command);
};

export function guard(input, { hooks, root, extraRisky, warn = (m) => console.error(m), budgetMs = TOTAL_BUDGET_MS } = {}) {
  const command = input?.tool_input?.command;
  // An absent event name is evaluated normally; only an explicit other event is ignored.
  const event = input?.hook_event_name;
  if ((event !== undefined && event !== 'PreToolUse') || input?.tool_name !== 'Bash' || typeof command !== 'string') return {};
  const base = root ?? ADAPTER_ROOT;
  const risky = extraRisky ?? compileRisky(loadConfig(base).config.codex?.riskyPatterns);
  return runHooks(JSON.stringify(input), command, { hooks, root: base, risky, warn, budgetMs });
}

function runHooks(stdin, command, { hooks, root, risky, warn, budgetMs }) {
  const isRiskyCmd = isRisky(command, risky);
  const failed = (why) => {
    if (isRiskyCmd) return output('deny', `[codex-guard] A safety hook could not run (${why}); the risky command was rejected fail-closed. Run it in a Claude session or by hand.`);
    warn(`[codex-guard] warning: a hook could not run (${why}); harmless command, no decision made.`);
    return null;
  };
  const list = hooks ?? bashHooks(root);
  if (!list) return failed('settings.json unreadable') ?? {};
  const deadline = Date.now() + budgetMs;
  let firstDeny = null;
  let problem = null;
  for (const h of list) {
    if (!ifPasses(h.if, command)) continue;
    const left = deadline - Date.now();
    if (left <= 0) { problem = 'time budget exceeded'; break; }
    const r = spawnSync('sh', ['-c', h.command], {
      input: stdin, encoding: 'utf8', timeout: Math.min((h.timeout ?? 10) * 1000, left),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root }, cwd: root || undefined,
    });
    const name = h.command.split('/').pop();
    if (r.error || r.signal) { problem = problem ?? `timeout/signal: ${name}`; continue; }
    if (r.status === 2) { firstDeny = firstDeny ?? (r.stderr.trim() || 'hook exit 2'); continue; }
    if (r.status !== 0) { problem = problem ?? `exit code ${r.status}: ${name}`; continue; }
    const raw = r.stdout.trim();
    if (!raw) continue;
    let o;
    try { o = JSON.parse(raw); } catch { problem = problem ?? `malformed JSON: ${name}`; continue; }
    const decision = o?.hookSpecificOutput?.permissionDecision;
    const reason = o?.hookSpecificOutput?.permissionDecisionReason || 'no reason given';
    if (decision === 'deny') firstDeny = firstDeny ?? reason;
    else if (decision === 'ask') firstDeny = firstDeny ?? `This action needs an approval prompt in Claude; Codex cannot ask, so it was denied. Run it in a Claude session or by hand: ${reason}`;
  }
  if (firstDeny) return output('deny', firstDeny);
  if (problem) return failed(problem) ?? {};
  return {};
}

// Malformed Codex stdin: classify the command from the raw text.
function guardRaw(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { input = null; }
  if (input) return guard(input);
  const extra = compileRisky(loadConfig(ADAPTER_ROOT).config.codex?.riskyPatterns);
  if (isRisky(raw, extra)) return output('deny', '[codex-guard] Hook input was unreadable and the text looks like a risky command; rejected fail-closed.');
  console.error('[codex-guard] warning: stdin is not JSON; no decision made.');
  return {};
}

export function diagnose(version, config) {
  const handlers = (config?.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks ?? []);
  return {
    cli: version,
    compatibility: /^codex-cli\s+\d/.test(String(version).trim()) ? 'documented-schema-only' : 'unavailable',
    binding: handlers.some((h) => [h.command, h.commandWindows].some((cmd) => cmd?.includes('codex-guard-adapter.mjs'))) ? 'configured' : 'missing',
    trust: 'unknown', runtime: 'unverified', enforcementVerified: false,
    unsupportedOutput: ['permissionDecision:ask'],
    note: 'enforcement not verified: Codex must trust the project hooks; re-trust after a hook change. A schema/payload test is not proof of a real event or of trust. The active config is never modified.',
  };
}

if (isMainModule(import.meta.url)) {
  const guardMode = process.argv.includes('--guard');
  try {
    if (guardMode) {
      let raw = '';
      try { raw = readFileSync(0, 'utf8'); } catch {}
      console.log(JSON.stringify(guardRaw(raw)));
    } else {
      const [version = 'unknown', configPath = '.codex/hooks.json'] = process.argv.slice(2);
      let config = {};
      try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      console.log(JSON.stringify(diagnose(version, config), null, 2));
    }
  } catch (error) {
    console.error(`Codex hook diagnostic unavailable: ${error.message}`);
    process.exitCode = guardMode ? 0 : 1;
  }
}
