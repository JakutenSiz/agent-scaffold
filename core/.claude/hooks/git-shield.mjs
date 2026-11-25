#!/usr/bin/env node
// Enforces: R-30
// Git shield — PreToolUse(Bash|PowerShell) hook. No distinction between the main session
// and subagents. A checkout is often shared by several sessions and workers at once;
// this hook denies git commands that irreversibly destroy UNCOMMITTED work:
//   reset --hard/--merge, checkout -- / . / -f, restore (worktree), clean -f,
//   stash push/save/drop/clear/..., switch --discard-changes/-f, pull/rebase/merge --autostash.
// Evidence for the rule: a `reset --hard` once dropped a commit, and a `pull --rebase` +
// `reset --hard` deleted seven uncommitted files of a worker running in the same checkout.
//
// Extra gates (all config-driven, see scripts/lib/config.mjs):
//   - git.shield.forbiddenCommands: [{ "pattern": "<regex>", "reason": "<text>" }] — a
//     generic deny list matched against the cleaned command text (heredoc bodies and
//     quoted strings removed). Invalid regex entries are skipped (fail-open).
//   - `git worktree add` debt gate: runs `node scripts/git-hygiene-clean.mjs --json`
//     (contract: stdout is one JSON object { "branches": [...], "worktrees": [...] } of
//     removable, lossless candidates). When branches + worktrees exceeds
//     git.hygiene.worktreeDebtAsk the call becomes an "ask". Result is cached for five
//     minutes under .claude/. Missing script / error / timeout -> no decision.
//
// Escape hatch: the command text carries `<escapeEnv>=1` as a prefix (Bash) or mentions
// `$env:<escapeEnv>` (PowerShell); escapeEnv = git.shield.escapeEnv (default
// AGENT_DESTRUCTIVE_OK). The escape only lifts the destructive-git check.
//
// Fail-open: any parse/internal error -> silent exit 0. So does a project without config.
//
// KNOWN GAP (deliberate): a shell command that is itself QUOTED, e.g.
// `bash -c "git reset --hard"`, is NOT caught — quoted strings are stripped before
// matching (so that a commit message mentioning "reset --hard" is not rejected), which
// also removes the body of such a wrapper. Out of scope for this heuristic shield.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

export const DEFAULT_ESCAPE_ENV = 'AGENT_DESTRUCTIVE_OK';
const DEFAULT_DEBT_ASK = 5;
const CACHE_MS = 5 * 60 * 1000;
const CACHE_FILE = '.hygiene-json-cache.json';

const REASONS = {
  resetHard: 'git reset --hard/--merge',
  checkout: 'git checkout (-- / . / -f/--force) irreversibly discards working-tree changes',
  restore: 'git restore irreversibly discards worktree changes (no --staged, or --worktree given)',
  clean: 'git clean -f irreversibly deletes untracked files',
  stash: 'git stash hides/removes working-tree changes',
  switch: 'git switch --discard-changes/-f/--force',
  autostash: 'git pull/rebase/merge --autostash',
};

// Drops heredoc bodies: from a `<<'EOF'` / `<<EOF` / `<<-EOF` line to the terminator line.
// The part of the marker line BEFORE `<<` (e.g. "git commit -F-") is kept; body and
// terminator are removed (a commit message mentioning "reset --hard" must not be denied).
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g,
    '',
  );
}

// Heredoc bodies and quoted strings removed.
export function cleanCommand(cmd) {
  return stripHeredocs(String(cmd ?? '')).replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
}

function splitSegments(clean) {
  return clean.split(/&&|\|\||;|\||\r?\n/);
}

function checkSegment(seg) {
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  // skip leading VAR=value prefixes (e.g. FOO=bar git status)
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return { destructive: false, reason: '' };
  if (tokens[0] !== 'git' && tokens[0] !== 'git.exe') return { destructive: false, reason: '' };
  tokens.shift();

  // skip git global options: -C <x>, -c <x>, --git-dir=.., --work-tree=.., --no-pager
  for (;;) {
    const t = tokens[0];
    if (t === undefined) break;
    if (t === '-C' || t === '-c') {
      tokens.shift();
      tokens.shift();
      continue;
    }
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) {
      tokens.shift();
      continue;
    }
    if (t === '--no-pager') {
      tokens.shift();
      continue;
    }
    break;
  }

  const sub = tokens.shift();
  const args = tokens;

  if (sub === 'reset') {
    if (args.includes('--hard') || args.includes('--merge')) {
      return { destructive: true, reason: REASONS.resetHard };
    }
  } else if (sub === 'checkout') {
    if (args.includes('--') || args.includes('.') || args.includes('-f') || args.includes('--force')) {
      return { destructive: true, reason: REASONS.checkout };
    }
  } else if (sub === 'restore') {
    const hasStaged = args.includes('--staged') || args.includes('-S');
    const hasWorktree = args.includes('--worktree') || args.includes('-W');
    if (!hasStaged || hasWorktree) {
      return { destructive: true, reason: REASONS.restore };
    }
  } else if (sub === 'clean') {
    for (const a of args) {
      if (a === '--force') return { destructive: true, reason: REASONS.clean };
      if (a.startsWith('-') && !a.startsWith('--') && a.includes('f')) {
        return { destructive: true, reason: REASONS.clean };
      }
    }
  } else if (sub === 'stash') {
    if (!args.length) return { destructive: true, reason: REASONS.stash };
    const risky = ['push', 'save', 'drop', 'clear', '-u', '--include-untracked', '-k', '--keep-index', '-a', '--all'];
    if (risky.includes(args[0])) return { destructive: true, reason: REASONS.stash };
  } else if (sub === 'switch') {
    if (args.includes('--discard-changes') || args.includes('-f') || args.includes('--force')) {
      return { destructive: true, reason: REASONS.switch };
    }
  } else if (sub === 'pull' || sub === 'rebase' || sub === 'merge') {
    if (args.includes('--autostash')) {
      return { destructive: true, reason: REASONS.autostash };
    }
  }
  return { destructive: false, reason: '' };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure: does the command contain a destructive git invocation?
 * @param {string} cmd
 * @param {{ escapeEnv?: string }} [opts]
 * @returns {{ destructive: boolean, reason: string }}
 */
export function isDestructive(cmd, opts = {}) {
  const raw = String(cmd ?? '');
  const name = escapeRegex(String(opts.escapeEnv || DEFAULT_ESCAPE_ENV));
  if (new RegExp(`\\b${name}=1\\b`).test(raw) || new RegExp(`\\$env:${name}\\b`, 'i').test(raw)) {
    return { destructive: false, reason: '' };
  }
  for (const seg of splitSegments(cleanCommand(raw))) {
    const result = checkSegment(seg);
    if (result.destructive) return result;
  }
  return { destructive: false, reason: '' };
}

/**
 * Pure: first matching entry of the generic deny list, or null. Entries with a missing or
 * invalid pattern are skipped (fail-open).
 * @param {string} cmd
 * @param {Array<{ pattern: string, reason?: string }>} list
 * @returns {{ pattern: string, reason: string } | null}
 */
export function matchForbidden(cmd, list) {
  if (!Array.isArray(list) || !list.length) return null;
  const clean = cleanCommand(cmd);
  for (const entry of list) {
    try {
      if (!entry || typeof entry.pattern !== 'string') continue;
      if (new RegExp(entry.pattern).test(clean)) {
        return { pattern: entry.pattern, reason: String(entry.reason || 'forbidden by project config') };
      }
    } catch {
      // invalid regex — skip this entry
    }
  }
  return null;
}

/** Pure: does any segment of the command run `git worktree add`? */
export function isWorktreeAdd(cmd) {
  return splitSegments(cleanCommand(cmd)).some((seg) =>
    /^\s*(?:[A-Za-z_]\w*=\S*\s+)*git(?:\.exe)?\s+(?:-C\s+\S+\s+)?worktree\s+add\b/.test(seg),
  );
}

/** Removable branch + worktree count from the hygiene script, or null (fail-open). */
export function hygieneDebt(root) {
  try {
    const cache = path.join(root, '.claude', CACHE_FILE);
    let data = null;
    try {
      if (Date.now() - statSync(cache).mtimeMs < CACHE_MS) data = JSON.parse(readFileSync(cache, 'utf8'));
    } catch {
      data = null;
    }
    if (!data) {
      const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'git-hygiene-clean.mjs'), '--json'], {
        encoding: 'utf8',
        cwd: root,
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      data = JSON.parse(out);
      try {
        writeFileSync(cache, JSON.stringify(data));
      } catch {
        // cache is best-effort
      }
    }
    const branches = Array.isArray(data?.branches) ? data.branches.length : 0;
    const worktrees = Array.isArray(data?.worktrees) ? data.worktrees.length : 0;
    return branches + worktrees;
  } catch {
    return null;
  }
}

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  try {
    const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { root, config, found } = loadConfig(startDir);
    if (!found) process.exit(0); // scaffold not installed here — stay silent

    const shield = config.git?.shield ?? {};
    const escapeEnv = shield.escapeEnv || DEFAULT_ESCAPE_ENV;
    const cmd = String(input?.tool_input?.command ?? '');

    const result = isDestructive(cmd, { escapeEnv });
    if (result.destructive) {
      emit(
        'deny',
        `[git-shield] ${result.reason}: this command irreversibly destroys uncommitted work, and this checkout ` +
          'may be shared with other sessions/workers (a worker once lost seven uncommitted files this way).\n' +
          'Safe path: (1) `git status --short` to see whose the dirty files are; (2) wait for or ask any running ' +
          'worker/session; (3) for a baseline run use `git worktree add --detach <dir> <sha>`; to undo your OWN ' +
          'change, fix the file with Edit (save `git diff -- <file>` as a patch first); un-staging with ' +
          '`git restore --staged <file>` is allowed.\n' +
          `If it is truly necessary, a human runs it with \`${escapeEnv}=1 \` as a command prefix.`,
      );
      process.exit(0);
    }

    const forbidden = matchForbidden(cmd, shield.forbiddenCommands);
    if (forbidden) {
      emit('deny', `[git-shield] ${forbidden.reason}`);
      process.exit(0);
    }

    if (isWorktreeAdd(cmd)) {
      const limit = Number(config.git?.hygiene?.worktreeDebtAsk ?? DEFAULT_DEBT_ASK);
      const debt = hygieneDebt(root);
      if (Number.isFinite(debt) && Number.isFinite(limit) && debt > limit) {
        emit(
          'ask',
          `[git-shield] hygiene debt: ${debt} removable branches/worktrees — first clean up with ` +
            '`node scripts/git-hygiene-clean.mjs --write` (or continue anyway).',
        );
      }
    }
  } catch {
    // fail-open
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
