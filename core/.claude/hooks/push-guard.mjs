#!/usr/bin/env node
// Push guard — PreToolUse(Bash) hook. Three gates, in order:
// 1) BEHIND-PUSH: fetch the target branch; if local is behind, DENY ("pull
//    first").
// 1b) MAP GATE: source files added by this push range that cannot be found
//     in that repo's memory-bank/repoMap.md are DENIED (the map audits
//     itself; rule: scripts/repomap-check.mjs). Skipped for a repo without
//     a map.
// 2) DEPLOY CONFIRM: if the push targets one of the repo's configured
//    deploy branches, ask for confirmation (push == auto-deploy, so this
//    gate stands in for CI).
// All gates FAIL OPEN on fetch/parse errors (git's own rejection is the
// backstop) — including when this project has not installed the scaffold.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path, { resolve } from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const cmd = String(input?.tool_input?.command ?? '');
if (!/\bgit\b[\s\S]*\bpush\b/.test(cmd)) process.exit(0);

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
const ask = (reason) => decide('ask', reason);
const deny = (reason) => decide('deny', reason);

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.normalize(path.resolve(a));
  const nb = path.normalize(path.resolve(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// Resolve the git working dir: cwd + last `cd` in the command chain + `git -C`.
let dir = input.cwd || process.cwd();
const cdMatches = [...cmd.matchAll(/(?:^|&&|;)\s*cd\s+("[^"]+"|\S+)/g)];
if (cdMatches.length > 0) {
  dir = resolve(dir, cdMatches[cdMatches.length - 1][1].replace(/^"|"$/g, ''));
}
const cFlag = cmd.match(/\bgit\s+-C\s+("[^"]+"|\S+)/);
if (cFlag) dir = resolve(dir, cFlag[1].replace(/^"|"$/g, ''));

const run = (args, t = 5000) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: t,
    stdio: ['ignore', 'pipe', 'pipe'], // keep stderr in (fail-open should stay quiet)
  }).trim();

// Shared context: branch, repo top-level, target (rough parse of
// `git push [flags] [remote [refspec]]`).
let branch = '';
let top = '';
let repoName = '';
let remote = 'origin';
let target = '';
try {
  branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  top = run(['rev-parse', '--show-toplevel']);
  repoName = path.basename(top);
  target = branch;
  const pm = cmd.match(/\bpush\b([^&|;]*)/);
  if (pm) {
    const toks = pm[1].trim().split(/\s+/).filter((tk) => tk && !tk.startsWith('-'));
    if (toks[0]) remote = toks[0];
    if (toks[1]) target = toks[1].includes(':') ? toks[1].split(':').pop() : toks[1];
  }
  if (target === 'HEAD') target = branch;
} catch {
  // could not resolve the git dir — skip the gates
}
const force = /\s(?:--force(?:-with-lease(?:=\S+)?)?|-f)\b/.test(cmd);
const hasTarget = Boolean(target) && target !== 'HEAD';

// GATE 1 — BEHIND-PUSH: no push before pulling. --force* is a deliberate
// overwrite; leave it alone.
if (!force && hasTarget) {
  try {
    run(['fetch', '--quiet', remote, target], 15000);
    const behind = parseInt(run(['rev-list', '--count', `HEAD..${remote}/${target}`]), 10) || 0;
    if (behind > 0) {
      deny(
        `BEHIND-PUSH GATE: '${repoName}' checkout is ${behind} commit(s) BEHIND ${remote}/${target} — do not push ` +
          'before pulling. Commit your local work first, then `git pull --ff-only` (use `git pull --rebase` if local ' +
          'commits diverged from remote); if there is a conflict or another agent has a claim here, coordinate FIRST, ' +
          'then push again.',
      );
    }
  } catch {
    // could not verify — fall through to normal flow
  }
}

// GATE 1b — MAP: can source files added in this push range be found in repoMap.md?
if (hasTarget && top && existsSync(path.join(top, config.memoryBank.dir, 'repoMap.md'))) {
  try {
    let ref = `${remote}/${target}`;
    try {
      run(['rev-parse', '--verify', '--quiet', ref]);
    } catch {
      ref = ''; // new branch not yet on the remote — no range to check
    }
    if (ref) {
      const script = path.join(root, 'scripts', 'repomap-check.mjs');
      let res = null;
      const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 };
      try {
        res = JSON.parse(execFileSync(process.execPath, [script, top, '--range', `${ref}..HEAD`, '--json'], opts));
      } catch (e) {
        try {
          res = JSON.parse(String(e.stdout || '')); // exit 1 = missing entries, stdout is still JSON
        } catch {}
      }
      if (res && Array.isArray(res.missing) && res.missing.length) {
        const list =
          res.missing.slice(0, 12).map((f) => '  - ' + f).join('\n') +
          (res.missing.length > 12 ? `\n  ... +${res.missing.length - 12}` : '');
        deny(
          `MAP GATE: this push adds ${res.missing.length} source file(s) not found in ` +
            `'${repoName}/${config.memoryBank.dir}/repoMap.md':\n${list}\n` +
            `Either record them in repoMap.md (file path + one line on what it does; add shared pieces to ` +
            `${config.memoryBank.dir}/reuse-registry.json too), or add a regex to ` +
            `${config.memoryBank.dir}/repomap-guard.json "ignore" if they are genuinely out of scope for the map; ` +
            `then push again. Audit: node scripts/repomap-check.mjs ${repoName}`,
        );
      }
    }
  } catch {
    // map check could not run — fail open
  }
}

// GATE 2 — DEPLOY CONFIRM.
const matchedRepo = (config.repos || []).find((r) => samePath(path.resolve(root, r.path || '.'), top));
let deployBranches = [];
if (matchedRepo) {
  deployBranches = matchedRepo.deployBranches || [];
} else {
  // Repo not in the config table (e.g. the umbrella root itself, or a new repo):
  // asking on main/master is cheap, a silent deploy is not. Fail safe = ask.
  deployBranches = ['main', 'master'];
}
const deployTarget = deployBranches.includes(target) || deployBranches.find((b) => cmd.includes(b));
if (deployTarget) {
  const b = deployBranches.includes(target) ? target : deployTarget;
  ask(
    `DEPLOY CONFIRM GATE: this push targets branch '${b}' in '${repoName || '?'}' — pushing here triggers an ` +
      'automatic deploy. Make sure smoke tests / typecheck (and a code review if warranted) ran before pushing; ' +
      'confirm the deploy actually succeeded afterwards.',
  );
}

process.exit(0);
