#!/usr/bin/env node
// Enforces: R-43
// Push guard — PreToolUse(Bash) hook. Gates, in order, evaluated for EVERY `git push` found
// in the command (chains such as `cd x && git push a && git -C y push b` are parsed per
// segment, so another repo's `git -C` can never be attributed to the push):
// 0) DELETE: `push --delete/-d <branch>` or a `:branch` refspec deletes a remote branch. The
//    behind/map gates are meaningless for it and are skipped; deploy branches and the main
//    branches cannot be deleted from here (DENY). A measured false positive: nine stale
//    branches could not be removed because the delete push tripped the behind gate.
// 1) BEHIND-PUSH: fetch the target branch; if local is behind, DENY ("pull first").
// 1b) MAP GATE (config.pushGate.mapGate: block | off): source files added by this push range that cannot be found in that repo's
//     memory-bank/repoMap.md are DENIED (rule: scripts/repomap-check.mjs). The check reads
//     the working tree, so it only counts as proof when HEAD IS the pushed commit and the
//     tree is clean (assertWorktree); otherwise the push is DENIED with the reason.
//     Skipped for a repo without a map.
// 2) DEPLOY gates, only when the push targets one of the repo's configured deploy branches:
//    - HOOKSPATH (config.pushGate.requireHooksPath, default true): the repo must have
//      core.hooksPath pointing at a directory with a pre-push hook, otherwise the pre-push
//      secret scan never runs for pushes from this clone (fresh clones, and sub-repos
//      initialised inside a worktree, come without it).
//    - DEPLOY LOCK: another process is already pushing to a deploy branch of this same repo.
//      Escape: prefix the command with DEPLOY_LOCK=skip.
//    - CONFIRM (one single ask; config.pushGate.confirm: ask | off): pushing here is an automatic deploy, so this gate stands in
//      for CI.
// All gates FAIL OPEN on fetch/parse errors (git's own rejection is the backstop) — including
// when this project has not installed the scaffold.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';
import { assertWorktree, scrubGitEnv } from '../../scripts/lib/worktree-check.mjs';
import { lockCheck } from './lib/deploy-lock.mjs';

// ---------------------------------------------------------------------------
// Command parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Quote-aware split of a shell command line into segments of tokens. */
export function splitCommand(cmd) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = '';
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      endToken();
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      endSegment();
    } else {
      cur += ch;
      has = true;
    }
  }
  endSegment();
  return segments;
}

const VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

function resolveDir(base, p) {
  const expanded = p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return path.resolve(base, expanded);
}

function parseRefspec(raw) {
  let s = raw;
  const force = s.startsWith('+');
  if (force) s = s.slice(1);
  const i = s.indexOf(':');
  const src = i === -1 ? s : s.slice(0, i);
  const dst = (i === -1 ? s : s.slice(i + 1)).replace(/^refs\/heads\//, '');
  return { raw, src, dst, force, deletes: i !== -1 && src === '' };
}

/**
 * Every `git push` in the command: [{ dir, remote, specs, deleting, force }].
 * `dir` = start dir + the `cd`s executed before it in the chain + that push's own `git -C`.
 */
export function parsePushCommands(cmd, startDir) {
  const out = [];
  let dir = startDir;
  const handle = (tokens) => {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // VAR=value prefixes
    while (['env', 'command', 'time', 'exec'].includes(tokens[i])) i++;
    const head = tokens[i];
    if (head === 'cd') {
      if (tokens[i + 1] && tokens[i + 1] !== '-') dir = resolveDir(dir, tokens[i + 1]);
      return;
    }
    if (SHELLS.has(path.basename(head || '')) && tokens.includes('-c')) {
      const inner = tokens[tokens.indexOf('-c') + 1];
      if (inner) for (const seg of splitCommand(inner)) handle(seg);
      return;
    }
    if (path.basename(head || '').replace(/\.exe$/i, '') !== 'git') return;
    let gitDir = dir;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === '-C') gitDir = resolveDir(gitDir, tokens[++j] ?? '.');
      else if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') j++;
      else if (t.startsWith('-')) continue;
      else break;
    }
    if (tokens[j] !== 'push') return;
    let remote = '';
    const positional = [];
    let deleting = false;
    let force = false;
    for (let k = j + 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (t === '--delete') deleting = true;
      else if (t === '--force' || t.startsWith('--force-with-lease')) force = true;
      else if (VALUE_FLAGS.has(t)) k++;
      else if (/^-[A-Za-z]+$/.test(t)) {
        if (t.includes('d')) deleting = true;
        if (t.includes('f')) force = true;
      } else if (t.startsWith('-')) continue;
      else positional.push(t);
    }
    if (positional.length) remote = positional.shift();
    const specs = positional.map(parseRefspec);
    if (deleting) for (const sp of specs) sp.deletes = true;
    out.push({ dir: gitDir, remote: remote || 'origin', specs, deleting: deleting || specs.some((sp) => sp.deletes), force });
  };
  for (const seg of splitCommand(cmd)) handle(seg);
  return out;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    try {
      return realpathSync(p); // /var -> /private/var on macOS: git reports the real path
    } catch {
      return path.resolve(p);
    }
  };
  const na = path.normalize(real(a));
  const nb = path.normalize(real(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const hookDir = path.dirname(fileURLToPath(import.meta.url));

/** Evaluate one push invocation. Returns { deny } | { ask } | {}. */
function evaluate(inv, ctx) {
  const { root, config, cmd } = ctx;
  const run = (args, t = 5000) =>
    execFileSync('git', args, {
      cwd: inv.dir,
      env: scrubGitEnv(),
      encoding: 'utf8',
      timeout: t,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // keep stderr in (fail-open should stay quiet)
    }).trim();

  let branch = '';
  let top = '';
  try {
    branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    top = run(['rev-parse', '--show-toplevel']);
  } catch {
    return {}; // could not resolve the git dir — skip the gates
  }
  const repoName = path.basename(top);
  const { remote } = inv;

  const matchedRepo = (config.repos || []).find((r) => samePath(path.resolve(root, r.path || '.'), top));
  // Repo not in the config table (the umbrella root, a new repo): asking on main/master is
  // cheap, a silent deploy is not. Fail safe = ask.
  const deployBranches = matchedRepo ? matchedRepo.deployBranches || [] : ['main', 'master'];

  // A bare `git push [remote]` pushes the current branch.
  const specs = inv.specs.length
    ? inv.specs.map((sp) => ({ ...sp, dst: sp.dst === 'HEAD' ? branch : sp.dst, src: sp.src || 'HEAD' }))
    : branch && branch !== 'HEAD'
      ? [{ raw: branch, src: 'HEAD', dst: branch, force: false, deletes: false }]
      : [];

  // GATE 0 — DELETE.
  if (inv.deleting) {
    const protectedNames = new Set([...deployBranches, ...(config.git?.protectedBranches || []), 'main', 'master']);
    const hit = inv.specs.filter((sp) => sp.deletes).map((sp) => sp.dst).find((b) => protectedNames.has(b));
    if (hit) {
      return {
        deny:
          `DELETE GATE: '${hit}' is a deploy/main branch of '${repoName}' — a remote branch like this must not be deleted. ` +
          'If it is deliberate, change the default branch / deploy wiring on the server first, then retry.',
      };
    }
    return {};
  }

  const live = specs.filter((sp) => !sp.deletes && sp.dst && sp.dst !== 'HEAD');

  // GATE 1 — BEHIND-PUSH: no push before pulling. --force* is a deliberate overwrite.
  for (const sp of live) {
    if (inv.force || sp.force) continue;
    try {
      run(['fetch', '--quiet', remote, sp.dst], 15000);
      const behind = parseInt(run(['rev-list', '--count', `HEAD..${remote}/${sp.dst}`]), 10) || 0;
      if (behind > 0) {
        return {
          deny:
            `BEHIND-PUSH GATE: '${repoName}' checkout is ${behind} commit(s) BEHIND ${remote}/${sp.dst} — do not push ` +
            'before pulling. Commit your local work first, then `git pull --ff-only` (use `git pull --rebase` if local ' +
            'commits diverged from remote); if there is a conflict or another agent has a claim here, coordinate FIRST, ' +
            'then push again.',
        };
      }
    } catch {
      // could not verify — fall through
    }
  }

  // GATE 1b — MAP: can source files added in this push range be found in repoMap.md?
  const mapFile = path.join(top, config.memoryBank.dir, 'repoMap.md');
  if ((config.pushGate?.mapGate ?? 'block') !== 'off' && live.length && existsSync(mapFile)) {
    for (const sp of live) {
      try {
        const ref = `${remote}/${sp.dst}`;
        try {
          run(['rev-parse', '--verify', '--quiet', ref]);
        } catch {
          continue; // new branch not yet on the remote — no range to check
        }
        const pushSha = run(['rev-parse', '--verify', `${sp.src}^{commit}`]);
        // The map script reads the working tree: it proves something only when the tree IS
        // the pushed commit. A measured mismatch is an explicit deny; unknown git errors
        // stay fail-open.
        try {
          assertWorktree(top, pushSha);
        } catch (error) {
          if (/SHA/.test(error.message)) {
            return {
              deny:
                `MAP SHA GATE: the repo-map check reads the working tree, so it only counts when HEAD is the pushed ` +
                `commit and the tree is clean. ${error.message}`,
            };
          }
          throw error;
        }
        const script = path.join(hookDir, '..', '..', 'scripts', 'repomap-check.mjs');
        const opts = { encoding: 'utf8', env: scrubGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, windowsHide: true };
        let res = null;
        try {
          res = JSON.parse(execFileSync(process.execPath, [script, top, '--range', `${ref}..${pushSha}`, '--json'], opts));
        } catch (e) {
          try {
            res = JSON.parse(String(e.stdout || '')); // exit 1 = missing entries, stdout is still JSON
          } catch {}
        }
        if (res && Array.isArray(res.missing) && res.missing.length) {
          const list =
            res.missing.slice(0, 12).map((f) => '  - ' + f).join('\n') +
            (res.missing.length > 12 ? `\n  ... +${res.missing.length - 12}` : '');
          return {
            deny:
              `MAP GATE: this push adds ${res.missing.length} source file(s) not found in ` +
              `'${repoName}/${config.memoryBank.dir}/repoMap.md':\n${list}\n` +
              `Either record them in repoMap.md (file path + one line on what it does; add shared pieces to ` +
              `${config.memoryBank.dir}/reuse-registry.json too), or add a regex to ` +
              `${config.memoryBank.dir}/repomap-guard.json "ignore" if they are genuinely out of scope for the map; ` +
              `then push again. Audit: node scripts/repomap-check.mjs ${repoName}`,
          };
        }
      } catch {
        // map check could not run — fail open
      }
    }
  }

  // GATE 2 — DEPLOY branches.
  const deployHit = [...new Set(live.map((sp) => sp.dst).filter((b) => deployBranches.includes(b)))];
  if (!deployHit.length) return {};

  // 2a — HOOKSPATH: is the pre-push gate actually wired in this clone? Only enforced when the
  // project ships a pre-push hook; git failures stay fail-open.
  if ((config.pushGate?.requireHooksPath ?? true) && existsSync(path.join(root, '.githooks', 'pre-push'))) {
    try {
      let hp = '';
      try {
        hp = run(['config', '--get', 'core.hooksPath']);
      } catch {
        hp = ''; // key unset -> exit 1
      }
      const hpAbs = hp ? path.resolve(top, hp) : '';
      if (!hp || !existsSync(path.join(hpAbs, 'pre-push'))) {
        const win = process.platform === 'win32';
        return {
          deny:
            `HOOKSPATH GATE: '${repoName}' has ${hp ? `core.hooksPath='${hp}' without a pre-push hook` : 'no core.hooksPath'} — ` +
            'a push from this clone would NOT run the pre-push gate (secret scan, checks); fresh clones and sub-repos ' +
            'initialised inside a worktree come without it. ' +
            `Fix: run \`${win ? 'setup-hooks.bat' : 'sh setup-hooks.sh'}\` in ${root} ` +
            `(${win ? 'POSIX: sh setup-hooks.sh' : 'Windows: setup-hooks.bat'}), then push again.`,
        };
      }
    } catch {
      // could not measure — fail open
    }
  }

  // 2b — DEPLOY LOCK.
  try {
    const lock = lockCheck(inv.dir, { cmd, branches: deployBranches });
    if (lock) return { deny: lock };
  } catch {}

  // 2c — CONFIRM (config.pushGate.confirm = off silences only this ask; the gates above stay).
  if ((config.pushGate?.confirm ?? 'ask') === 'off') return {};
  return {
    ask:
      `DEPLOY CONFIRM GATE: this push targets ${deployHit.map((b) => `'${b}'`).join(', ')} in '${repoName || '?'}' — ` +
      'pushing here triggers an automatic deploy. Make sure smoke tests / typecheck (and a code review if warranted) ' +
      'ran before pushing; confirm the deploy actually succeeded afterwards.',
  };
}

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
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const cmd = String(input?.tool_input?.command ?? '');
  if (!/\bgit\b[\s\S]*\bpush\b/.test(cmd)) return;

  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { root, config, found } = loadConfig(startDir);
  if (!found) return; // scaffold not installed here — stay silent

  let invocations = [];
  try {
    invocations = parsePushCommands(cmd, input.cwd || process.cwd());
  } catch {
    return;
  }
  const asks = [];
  for (const inv of invocations) {
    let res = {};
    try {
      res = evaluate(inv, { root, config, cmd });
    } catch {
      res = {}; // internal error — fail open
    }
    if (res.deny) return decide('deny', res.deny);
    if (res.ask && !asks.includes(res.ask)) asks.push(res.ask);
  }
  if (asks.length) decide('ask', asks.join('\n'));
}

if (isMainModule(import.meta.url)) main();
