// Enforces: R-32
// Shared pieces of git-hygiene-watch.mjs (report only) and git-hygiene-clean.mjs (lossless cleanup).
//
// One definition of "merged": a branch tip (or worktree HEAD) is merged when it is an ancestor
// (`git merge-base --is-ancestor`) of origin/<default branch> OR of origin/<b> for any of the
// repo's configured deployBranches. `git cherry` is deliberately NOT used: it counts re-applied
// (rebased / cherry-picked) commits as unique and would call squash-merged work "unmerged".
// Nothing here fetches: only refs already present under refs/remotes/origin are read.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scrubGitEnv } from './worktree-check.mjs';
import { boardFormat, parseItems } from './board-format.mjs';

export function git(cwd, args, timeout = 5000) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: scrubGitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
}

export function hygieneSettings(config) {
  const h = config?.git?.hygiene ?? {};
  return {
    branchMinAgeHours: Number(h.branchMinAgeHours ?? 24),
    worktreeMinAgeHours: Number(h.worktreeMinAgeHours ?? 6),
    staleStashDays: Number(h.staleStashDays ?? 14),
    autoClean: h.autoClean === true,
    ignoreFile: h.ignoreFile ?? 'scripts/git-hygiene-ignore.json',
  };
}

function commonDir(dir) {
  try {
    const out = git(dir, ['rev-parse', '--git-common-dir']).trim();
    return fs.realpathSync(path.resolve(dir, out));
  } catch {
    return null;
  }
}

/**
 * Git repositories to inspect: every configured repo path plus the root itself when it is a
 * repository. Paths that are not git repositories are skipped; paths sharing one git directory
 * (monorepo packages) collapse into one entry whose deployBranches are the union.
 * @returns {{name:string, path:string, deployBranches:string[]}[]}
 */
export function discoverRepos(root, config, { only = null } = {}) {
  const found = new Map();
  const add = (name, dir, deploy) => {
    if (!fs.existsSync(dir)) return;
    const key = commonDir(dir);
    if (!key) return;
    const prev = found.get(key);
    if (prev) {
      for (const b of deploy) if (!prev.deployBranches.includes(b)) prev.deployBranches.push(b);
      return;
    }
    found.set(key, { name, path: dir, deployBranches: [...deploy] });
  };
  for (const r of config?.repos ?? []) add(r.name || path.basename(r.path || '.'), path.resolve(root, r.path || '.'), r.deployBranches ?? []);
  add(config?.projectName || path.basename(root), path.resolve(root), []);
  let list = [...found.values()];
  if (only) {
    const abs = path.resolve(only);
    list = list.filter((r) => r.name === only || path.resolve(r.path) === abs);
  }
  return list;
}

function refExists(dir, ref) {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** Default branch name: origin/HEAD, else the first of main/master that has an origin ref. */
export function defaultBranch(dir) {
  try {
    const sym = git(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).trim();
    if (sym.startsWith('origin/') && refExists(dir, `refs/remotes/${sym}`)) return sym.slice('origin/'.length);
  } catch {}
  for (const b of ['main', 'master']) if (refExists(dir, `refs/remotes/origin/${b}`)) return b;
  return null;
}

/** Remote-tracking refs whose ancestors count as merged: default branch + existing deploy branches. */
export function mergeTargets(repo) {
  const def = defaultBranch(repo.path);
  const names = [...(def ? [def] : []), ...repo.deployBranches];
  const refs = [];
  for (const n of names) {
    const ref = `refs/remotes/origin/${n}`;
    if (!refs.includes(ref) && refExists(repo.path, ref)) refs.push(ref);
  }
  return { defaultBranch: def, refs };
}

export function isAncestor(dir, a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: dir, env: scrubGitEnv(), stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function isMerged(dir, sha, refs) {
  return refs.some((r) => isAncestor(dir, sha, r));
}

/** `git worktree list --porcelain`, main worktree INCLUDED: {path, head, branch, locked, prunable}. */
export function listWorktrees(dir) {
  const out = git(dir, ['worktree', 'list', '--porcelain']);
  return out
    .split(/\r?\n\r?\n/)
    .filter((b) => b.trim())
    .map((b) => {
      const lines = b.split(/\r?\n/);
      const take = (prefix) => (lines.find((x) => x.startsWith(prefix)) || '').slice(prefix.length);
      const branch = take('branch ');
      return {
        path: take('worktree '),
        head: take('HEAD '),
        branch: branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : '',
        locked: lines.some((x) => x === 'locked' || x.startsWith('locked ')),
        prunable: lines.some((x) => x === 'prunable' || x.startsWith('prunable ')),
      };
    });
}

/**
 * Number of dirty files in a worktree (0 = clean); -1 when unreadable. Files under `.claude/`
 * (tool caches) do not count. `--no-optional-locks` keeps status from rewriting the index and
 * refreshing the mtime the age rule looks at.
 */
export function dirtyCount(wt) {
  try {
    const out = git(wt, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
    return out
      .split('\n')
      .filter((s) => s.trim())
      .filter((s) => !/^.. "?\.claude\//.test(s)).length;
  } catch {
    return -1;
  }
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isInside(dir, parent) {
  const d = realOrResolved(dir);
  const p = realOrResolved(parent);
  return d === p || d.startsWith(p + path.sep);
}

/** Newest mtime (epoch seconds) of the worktree's private git dir HEAD / index / logs; null if unknown. */
export function worktreeMtime(wt) {
  try {
    const gd = git(wt, ['rev-parse', '--absolute-git-dir']).trim();
    let newest = 0;
    for (const f of ['HEAD', 'index', path.join('logs', 'HEAD')]) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(gd, f)).mtimeMs / 1000);
      } catch {}
    }
    return newest || null;
  } catch {
    return null;
  }
}

/** Ignore list. `ok:false` (unparseable / not an array) means the caller must delete nothing. */
export function loadIgnore(root, config, overridePath = null) {
  const file = overridePath || path.resolve(root, hygieneSettings(config).ignoreFile);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Accepted shapes: a bare array, or { "$comment": "...", "entries": [...] }.
    const list = Array.isArray(raw) ? raw : raw?.entries;
    if (!Array.isArray(list)) throw new Error('no entries array');
    return { ok: true, entries: list, file };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, entries: [], file };
    return { ok: false, entries: [], file };
  }
}

// --- live-signal references (lazy; only read when a worktree is a deletion candidate) ---
// Only places that describe work in progress can hold a worktree: the whole coordination file and
// the OPEN items of the board. Specs, reports, the memory bank and the archives are never scanned:
// the memory of a closed job in a durable document would otherwise protect its worktree forever.
function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
}

/** Lines of the board that belong to open items (closed items and everything outside items are blanked; line numbers are kept). */
function openBoardLines(lines, config) {
  const fmt = boardFormat(config);
  const out = lines.map(() => '');
  for (const it of parseItems(lines.join('\n'), fmt)) {
    if (it.status === fmt.status.done) continue;
    for (let i = it.start; i < it.end; i++) out[i] = lines[i];
  }
  return out;
}

export function liveSignalFiles(root, config) {
  const docs = [];
  const coordination = config?.coordination?.file ? path.resolve(root, config.coordination.file) : null;
  const board = config?.board?.file ? path.resolve(root, config.board.file) : null;
  const coordLines = coordination && readLines(coordination);
  if (coordLines) docs.push({ file: coordination, lines: coordLines });
  const boardLines = board && readLines(board);
  if (boardLines) docs.push({ file: board, lines: openBoardLines(boardLines, config) });
  return docs;
}

/** First "file:line" in the live-signal set that mentions the worktree path, else null. */
export function findLiveReference(wtPath, root, docs) {
  const needles = new Set([wtPath.replaceAll('\\', '/')]);
  const rel = path.relative(root, wtPath).replaceAll('\\', '/');
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) needles.add(rel);
  for (const { file, lines } of docs) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replaceAll('\\', '/');
      for (const n of needles) {
        let from = 0;
        for (;;) {
          const at = line.indexOf(n, from);
          if (at < 0) break;
          const next = line[at + n.length];
          // "wt" must not match "wt-2": the name has to end at a boundary
          if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return `${path.relative(root, file)}:${i + 1}`;
          from = at + 1;
        }
      }
    }
  }
  return null;
}

/**
 * Evaluate one repo. Pure read: deletes nothing.
 * A branch is a candidate <=> merged + not checked out (except in worktrees that are themselves
 * about to be removed) + not ignored + not protected + last commit older than branchMinAgeHours.
 * A worktree is a candidate <=> clean + HEAD merged + git-dir mtime older than worktreeMinAgeHours
 * + not locked + cwd not inside + no live reference (coordination file, open board items). When unsure, KEEP.
 * @returns {{candidates:{branches:object[], worktrees:object[]}, kept:object[], skipped:string|null, targets:string[], liveReferenced:string[]}}
 */
export function evaluateRepo(repo, ctx) {
  const { root, config, now, ignore, cwds, docsLoader } = ctx;
  const s = hygieneSettings(config);
  const candidates = { branches: [], worktrees: [] };
  const kept = [];
  const keep = (kind, name, reason) => kept.push({ repo: repo.name, kind, name, reason });
  const { defaultBranch: def, refs } = mergeTargets(repo);
  if (!refs.length) return { candidates, kept, skipped: 'no origin/<default> or origin/<deploy> ref', targets: [], liveReferenced: [] };
  const protectedNames = new Set([def, ...repo.deployBranches, ...(config?.git?.protectedBranches ?? [])].filter(Boolean));
  const ignored = (branch) => ignore.entries.some((y) => (y.repo === repo.name || y.repo === undefined) && y.branch === branch);

  const wts = listWorktrees(repo.path);
  const removing = new Set();
  const liveReferenced = [];
  for (const w of wts.slice(1)) {
    if (!fs.existsSync(w.path) || w.prunable) {
      keep('worktree', w.path, 'directory missing (git worktree prune)');
      continue;
    }
    if (!isMerged(repo.path, w.head, refs)) {
      keep('worktree', w.path, 'unmerged (HEAD not in the default/deploy branches)');
      continue;
    }
    if (w.locked) {
      keep('worktree', w.path, 'locked');
      continue;
    }
    const mt = worktreeMtime(w.path); // before status
    const dirty = dirtyCount(w.path);
    if (dirty !== 0) {
      keep('worktree', w.path, dirty < 0 ? 'unreadable status' : `dirty (${dirty} files)`);
      continue;
    }
    if (cwds.some((c) => isInside(c, w.path))) {
      keep('worktree', w.path, 'current directory is inside (in use)');
      continue;
    }
    if (mt === null || now - mt <= s.worktreeMinAgeHours * 3600) {
      keep('worktree', w.path, mt === null ? 'mtime unknown' : `fresh (touched ${Math.round((now - mt) / 60)} min ago)`);
      continue;
    }
    const ref = findLiveReference(w.path, root, docsLoader());
    if (ref) {
      keep('worktree', w.path, `referenced in ${ref}`);
      liveReferenced.push(w.path);
      continue;
    }
    removing.add(w.path);
    candidates.worktrees.push({ repo: repo.name, path: w.path, sha: w.head, branch: w.branch });
  }

  const checkedOut = new Set();
  for (const w of wts) if (w.branch && !removing.has(w.path)) checkedOut.add(w.branch);
  let rows = [];
  try {
    rows = git(repo.path, ['for-each-ref', '--format=%(refname)\t%(committerdate:unix)\t%(objectname)', 'refs/heads'])
      .split('\n')
      .filter((x) => x.trim())
      .map((x) => x.split('\t'));
  } catch {
    keep('branch', '(all)', 'branches unreadable');
  }
  for (const [ref, ts, sha] of rows) {
    const name = ref.slice('refs/heads/'.length);
    if (protectedNames.has(name)) continue; // silent: protected names are never noise
    if (!isMerged(repo.path, sha, refs)) {
      keep('branch', name, 'unmerged (tip not in the default/deploy branches)');
    } else if (checkedOut.has(name)) {
      keep('branch', name, 'checked out in a worktree');
    } else if (ignored(name)) {
      keep('branch', name, 'listed in the ignore file');
    } else if (now - Number(ts) <= s.branchMinAgeHours * 3600) {
      keep('branch', name, `fresh (last commit under ${s.branchMinAgeHours} h)`);
    } else candidates.branches.push({ repo: repo.name, branch: name, sha });
  }
  return { candidates, kept, skipped: null, targets: refs, liveReferenced };
}

/** Number of stashes older than `days` (report only; stashes are never touched). */
export function staleStashCount(dir, now, days) {
  try {
    return git(dir, ['stash', 'list', '--format=%ct'])
      .split('\n')
      .filter((x) => x.trim() && (now - Number(x)) / 86400 > days).length;
  } catch {
    return 0;
  }
}
