// Gate registry: one row per gate, with a label per resolved config.
// Labels: block (denies / fails the command) · ask (needs a human yes) · warn (says it, lets it
// pass) · measure (records or injects context, never stops anything) · off (inactive under this
// config). A label may carry a note after the first word, e.g. `block (> 10 reads)`.
//
// What is NOT written by hand: the event and matcher of a hook (read from
// .claude/settings.json) and which script a git hook runs (read from .githooks/*). What IS
// written here: which config key a gate reads, because that lives inside the hook's code. Keep
// `label()` in step with the key the gate really reads; tests/gate-table.test.mjs runs fixtures
// that catch a label contradicting the behaviour.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadConfig } from './config.mjs';

export const LABELS = ['block', 'ask', 'warn', 'measure', 'off'];
export const PROFILE_NAMES = ['minimal', 'standard', 'strict'];

const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOOK = '.claude/hooks/';
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Fully resolved config (DEFAULTS + profile layer) for each profile, via the real loader. */
export function profileConfigs() {
  const out = {};
  for (const name of PROFILE_NAMES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-table-cfg-'));
    try {
      fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify({ profile: name }));
      out[name] = loadConfig(dir).config;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------- registry

export const GATES = [
  // ---- git-shield
  {
    id: 'git-shield', file: HOOK + 'git-shield.mjs',
    summary: 'destructive git commands (reset --hard, checkout --, restore, clean -f, stash, --autostash)',
    label: () => 'block',
    escape: (c) => `prefix the command with ${c.git?.shield?.escapeEnv ?? 'AGENT_DESTRUCTIVE_OK'}=1`,
  },
  {
    id: 'git-shield-forbidden', file: HOOK + 'git-shield.mjs',
    summary: 'project-defined forbidden commands (git.shield.forbiddenCommands)',
    label: (c) => ((c.git?.shield?.forbiddenCommands ?? []).length ? 'block' : 'off'),
    escape: () => 'edit git.shield.forbiddenCommands',
  },
  {
    id: 'git-shield-worktree-debt', file: HOOK + 'git-shield.mjs',
    summary: '`git worktree add` while removable branches + worktrees pile up',
    label: (c) => `ask (> ${num(c.git?.hygiene?.worktreeDebtAsk, 5)} removable)`,
    escape: () => 'clean up (scripts/git-hygiene-clean.mjs --yaz)',
  },
  // ---- read-guard (delegation)
  {
    id: 'read-guard-reads', file: HOOK + 'read-guard.mjs', arg: 'pre',
    summary: 'main session keeps reading instead of delegating (counted reads, shell reads included)',
    label: (c) => (num(c.delegation?.denyAfterReads, 0) > 0 ? `block (> ${c.delegation.denyAfterReads} reads)` : 'off'),
    escape: () => 'delegate to a subagent (renews the allowance) or send a new prompt',
  },
  {
    id: 'read-guard-recursion', file: HOOK + 'read-guard.mjs', arg: 'pre',
    summary: 'a subagent spawning its own subagent',
    label: () => 'block',
    escape: () => 'none (report back to the main agent)',
  },
  {
    id: 'read-guard-reads-reminder', file: HOOK + 'read-guard.mjs', arg: 'post',
    summary: 'soft reminder after N reads in the main session',
    label: (c) => (num(c.delegation?.warnAfterReads, 0) > 0 ? `warn (at ${c.delegation.warnAfterReads} reads)` : 'off'),
    escape: () => 'none',
  },
  {
    id: 'read-guard-edits', file: HOOK + 'read-guard.mjs', arg: 'edit',
    summary: 'main session keeps editing files instead of handing work to a worker',
    label: (c) => (num(c.delegation?.denyAfterEdits, 0) > 0 ? `block (> ${c.delegation.denyAfterEdits} edits)` : 'off'),
    escape: () => 'delegate to a worker (renews the allowance) or send a new prompt',
  },
  {
    id: 'read-guard-edits-reminder', file: HOOK + 'read-guard.mjs', arg: 'edit',
    summary: 'one-time reminder after N edits in the main session',
    label: (c) => (num(c.delegation?.warnAfterEdits, 0) > 0 ? `warn (at ${c.delegation.warnAfterEdits} edits)` : 'off'),
    escape: () => 'none',
  },
  {
    id: 'read-guard-reset', file: HOOK + 'read-guard.mjs', arg: 'reset',
    summary: 'resets the read/edit counters at every user prompt (bookkeeping, not a gate)',
    label: () => 'measure',
    escape: () => 'none',
  },
  // ---- context and session
  {
    id: 'context-watch', file: HOOK + 'context-watch.mjs',
    summary: 'context too large or session idle: tells the agent to hand off',
    label: (c) => `warn (> ${num(c.session?.context?.warnTokens, 300000)} tokens)`,
    escape: (c) => `${c.session?.context?.offEnv ?? 'CONTEXT_WATCH'}=off`,
  },
  {
    id: 'session-context', file: HOOK + 'session-context.mjs',
    summary: 'SessionStart note: coordination file, status lines, auto-pull',
    label: () => 'measure',
    escape: () => 'none',
  },
  {
    id: 'ensure-agent-compat', file: HOOK + 'ensure-agent-compat.mjs',
    summary: 'links Codex and Claude hook sources; sets core.hooksPath when it is empty',
    label: () => 'measure',
    escape: (c) => `session.ensureHooksPath: ${c.session?.ensureHooksPath === false ? 'false' : 'true'}`,
  },
  // ---- map guardian
  {
    id: 'map-guardian-map', file: HOOK + 'map-guardian.mjs',
    summary: 'injects the relevant repo-map slice on the first edit in a repo',
    label: () => 'measure',
    escape: () => 'none',
  },
  {
    id: 'map-guardian-reuse', file: HOOK + 'map-guardian.mjs',
    summary: 'new code that re-implements a piece registered in reuse-registry.json',
    label: (c) => ((c.memoryBank?.reuseGate ?? 'block') === 'off' ? 'off' : 'block'),
    escape: (c) => `update ${c.memoryBank?.dir ?? 'memory-bank'}/reuse-registry.json first`,
  },
  // ---- push-guard
  {
    id: 'push-guard-delete', file: HOOK + 'push-guard.mjs',
    summary: 'deleting a deploy or main branch on the remote',
    label: () => 'block',
    escape: () => 'none',
  },
  {
    id: 'push-guard-behind', file: HOOK + 'push-guard.mjs',
    summary: 'pushing while the checkout is behind the remote branch',
    label: () => 'block',
    escape: () => 'pull first (a force push skips the check)',
  },
  {
    id: 'push-guard-map', file: HOOK + 'push-guard.mjs',
    summary: 'pushed source files missing from the repo map',
    label: (c) => ((c.pushGate?.mapGate ?? 'block') === 'off' ? 'off' : 'block'),
    escape: () => 'add the files to the map',
  },
  {
    id: 'push-guard-hookspath', file: HOOK + 'push-guard.mjs',
    summary: 'deploy push from a clone without core.hooksPath (pre-push would never run)',
    label: (c) => (c.pushGate?.requireHooksPath ?? true ? 'block' : 'off'),
    escape: () => 'run setup-hooks.sh',
  },
  {
    id: 'push-guard-deploy-lock', file: HOOK + 'push-guard.mjs',
    summary: 'a second deploy push while another one is running',
    label: () => 'block',
    escape: () => 'prefix the command with DEPLOY_LOCK=skip',
  },
  {
    id: 'push-guard-confirm', file: HOOK + 'push-guard.mjs',
    summary: 'push to a deploy branch (automatic deploy)',
    label: (c) => ((c.pushGate?.confirm ?? 'ask') === 'off' ? 'off' : 'ask'),
    escape: () => 'answer yes',
  },
  // ---- secret shield
  {
    id: 'secret-shield', file: HOOK + 'secret-shield.mjs',
    summary: 'reading or overwriting secret files (.env, keys, credential files) by name',
    label: (c) => {
      const mode = c.secrets?.mode ?? 'block';
      return mode === 'off' ? 'off' : `${mode === 'warn' ? 'warn' : 'block'} (accident-level)`;
    },
    escape: () => 'none (a human edits secrets.* in the config)',
  },
  // ---- test runner
  {
    id: 'test-runner-guard', file: HOOK + 'test-runner-guard.mjs',
    summary: 'test runs with too many workers or while orphaned runner processes pile up',
    label: (c) => {
      const t = c.testRunner ?? {};
      return t.processName && t.triggerPattern ? `block (> ${num(t.maxWorkers, 2)} workers)` : 'off';
    },
    escape: () => 'lower the worker count / clean up orphans',
  },
  // ---- edit check
  {
    id: 'edit-check', file: HOOK + 'edit-check.mjs',
    summary: 'post-edit syntax/type check from repos[].editCheck (wakes the agent on failure)',
    label: (c) => ((c.repos ?? []).some((r) => (r.editCheck ?? []).length) ? 'warn' : 'off'),
    escape: () => 'none',
  },
  // ---- codex bridge (not bound in settings.json: Codex reads .codex/hooks.json)
  {
    id: 'codex-guard-adapter', file: HOOK + 'codex-guard-adapter.mjs', external: 'Codex PreToolUse (Bash)',
    summary: 'replays the Bash hooks for Codex; `ask` becomes `deny`; risky commands fail closed',
    label: () => 'block',
    escape: () => 'none (project hooks must be trusted in Codex)',
  },
  // ---- git pre-commit
  {
    id: 'board-lint', file: 'scripts/board-lint.mjs', via: 'scripts/pre-commit-check.mjs',
    summary: 'board edits that break the compact item template',
    label: (c) => {
      const mode = c.board?.lint?.mode ?? 'warn';
      return mode === 'block' ? 'block' : mode === 'off' || mode === 'skip' ? 'off' : 'warn';
    },
    escape: (c) => `${c.board?.lint?.escapeEnv ?? 'BOARD_LINT'}=skip`,
  },
  {
    id: 'coordination-check', file: 'scripts/coordination-archive.mjs', via: 'scripts/pre-commit-check.mjs',
    summary: 'coordination file with closed note sections still in it',
    label: (c) => (c.coordination?.checkMode === 'warn' ? 'warn' : 'block'),
    escape: () => 'COORDINATION_CHECK=skip',
  },
  {
    id: 'done-gate', file: 'scripts/done-gate.mjs', via: 'scripts/pre-commit-check.mjs',
    summary: 'closing a board item without a green gate record (opt-in: needs doneGate.command)',
    label: (c) => {
      const g = c.doneGate ?? {};
      const mode = g.mode ?? 'block';
      if (mode === 'off') return 'off';
      const base = mode === 'warn' ? 'warn' : 'block';
      return g.command ? base : `${base} (opt-in: set doneGate.command)`;
    },
    escape: () => 'PRE_COMMIT_SKIP_DONE_GATE=1',
  },
  {
    id: 'pre-commit-project-checks', file: 'scripts/pre-commit-check.mjs',
    summary: 'project checks from preCommit.checks (run when matching files are staged)',
    label: (c) => ((c.preCommit?.checks ?? []).length ? 'block' : 'off'),
    escape: () => 'PRE_COMMIT_SKIP_<ID>=1',
  },
  // ---- git pre-push
  {
    id: 'big-blob', file: 'scripts/pre-push-check.mjs',
    summary: 'new blobs over pushGate.maxBlobMB in any pushed branch',
    label: (c) => {
      const g = c.pushGate ?? {};
      return `${g.bigBlobMode === 'block' ? 'block' : 'warn'} (> ${num(g.maxBlobMB, 2)} MB)`;
    },
    escape: (c) => `${c.pushGate?.bigBlobEnv ?? 'BIG_FILE_OK'}=1`,
  },
  {
    id: 'secret-scan', file: 'scripts/pre-push-check.mjs',
    summary: 'secret scan over the pushed commits (deploy branches only)',
    label: (c) => ((c.secretScan?.failClosed ?? true) ? 'block' : 'block (only if the scanner is installed)'),
    escape: (c) => `${c.secretScan?.skipEnv ?? 'SKIP_PUSH_GATE'}=1`,
  },
  {
    id: 'push-syntax-check', file: 'scripts/pre-push-check.mjs',
    summary: 'repos[].checks.syntax on the pushed content (deploy branches only)',
    label: (c) => ((c.repos ?? []).some((r) => (r.deployBranches ?? []).length && r.checks?.syntax) ? 'block' : 'off'),
    escape: (c) => `${c.secretScan?.skipEnv ?? 'SKIP_PUSH_GATE'}=1`,
  },
  {
    id: 'push-typecheck', file: 'scripts/pre-push-check.mjs',
    summary: 'repos[].checks.typecheck on the pushed commit (deploy branches only)',
    label: (c) => ((c.repos ?? []).some((r) => (r.deployBranches ?? []).length && r.checks?.typecheck) ? 'block' : 'off'),
    escape: (c) => `${c.secretScan?.skipEnv ?? 'SKIP_PUSH_GATE'}=1`,
  },
];

// ---------------------------------------------------------------- derived from files

/** Hook bindings read from settings.json: [{ file, arg, event, matcher }]. */
export function hookBindings(coreDir = CORE_DIR) {
  const settings = JSON.parse(fs.readFileSync(path.join(coreDir, '.claude', 'settings.json'), 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        const m = String(h.command ?? '').match(/\.claude\/hooks\/([\w.-]+\.mjs)"?(?:\s+(\S+))?\s*$/);
        if (!m) continue;
        out.push({ file: HOOK + m[1], arg: m[2] ?? null, event, matcher: group.matcher ?? null });
      }
    }
  }
  return out;
}

/** Map of git hook name -> the script it runs, read from .githooks/<name>. */
export function gitHookScripts(coreDir = CORE_DIR) {
  const dir = path.join(coreDir, '.githooks');
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    const m = fs.readFileSync(path.join(dir, name), 'utf8').match(/gate_script="\$hook_dir\/\.\.\/(scripts\/[\w.-]+\.mjs)"/);
    if (m) out.set(name, m[1]);
  }
  return out;
}

const escapeCell = (s) => String(s).replaceAll('|', '\\|');

/** Where a gate runs, derived: `Event Matcher` from settings.json or `git <hook>` from .githooks. */
export function whereOf(gate, coreDir = CORE_DIR) {
  if (gate.external) return gate.external;
  const scripts = gitHookScripts(coreDir);
  const script = gate.via ?? gate.file;
  for (const [name, file] of scripts) if (file === script) return `git ${name}`;
  const hits = hookBindings(coreDir).filter((b) => b.file === gate.file && b.arg === (gate.arg ?? null));
  const seen = [...new Set(hits.map((b) => (b.matcher ? `${b.event} ${b.matcher}` : b.event)))];
  return seen.length ? seen.join(', ') : 'unbound';
}

/** Table rows: one object per gate with the label for each profile. */
export function buildRows(coreDir = CORE_DIR) {
  const configs = profileConfigs();
  return GATES.map((g) => ({
    id: g.id,
    summary: g.summary,
    where: whereOf(g, coreDir),
    labels: PROFILE_NAMES.map((p) => g.label(configs[p])),
    escape: g.escape(configs.standard),
  }));
}

/** Markdown for the README block (no markers, no surrounding blank lines). */
export function renderTable(coreDir = CORE_DIR) {
  const lines = [
    '| Gate | Where | minimal | standard | strict | Escape |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of buildRows(coreDir)) {
    const cells = [`\`${r.id}\` ${r.summary}`, r.where, ...r.labels, r.escape].map(escapeCell);
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push(
    '',
    'Labels: `block` denies or fails the command; `ask` needs a human yes; `warn` says it and lets it pass; `measure` records or injects context only; `off` is inactive under that profile. `(opt-in ...)` means the gate does nothing until the named setting is filled in. Generated from the registry in `core/scripts/lib/gates.mjs`; refresh with `node core/scripts/gate-table.mjs --write`.',
  );
  return lines.join('\n');
}
