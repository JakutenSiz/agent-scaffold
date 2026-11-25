#!/usr/bin/env node
// Enforces: R-32
// Git hygiene watchman: shows the debt that merged branches, stale stashes and dead worktrees
// accumulate, so it is visible instead of silently growing (one project measured 156 branches,
// several stashes and months-old worktrees holding uncommitted changes before anyone looked).
//
// REPORT ONLY: never deletes anything, never blocks anything, never fetches (only refs already
// under refs/remotes/origin are read). The one exception is opt-in: with
// git.hygiene.autoClean === true, `--line` first runs the cleanup (git-hygiene-clean.mjs logic,
// write mode, every safety condition unchanged) and then reports what remains.
//
// Debt per repo: merged-and-old local branches, clean+merged worktrees (both are exactly what the
// cleaner would delete), stashes older than git.hygiene.staleStashDays, worktrees whose directory
// is gone, and dirty worktrees. Thresholds come from git.hygiene in agent-scaffold.config.json.
//
// USAGE:
//   node scripts/git-hygiene-watch.mjs            # table for humans
//   node scripts/git-hygiene-watch.mjs --line     # ONE line for SessionStart; no output when debt is 0
//   node scripts/git-hygiene-watch.mjs --json     # machine-readable
//   node scripts/git-hygiene-watch.mjs --strict   # exit 1 when there is debt
//   Test flags: --now <epoch> --root <dir> --repo <name|path>
import fs from 'node:fs';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { runClean } from './git-hygiene-clean.mjs';
import { discoverRepos, evaluateRepo, loadIgnore, liveSignalFiles, hygieneSettings, listWorktrees, dirtyCount, staleStashCount } from './lib/git-hygiene-common.mjs';

/**
 * Scan all repos (read only).
 * @returns {{repos: object[], notes: Record<string,string[]>, debt: number}}
 */
export function scan({ root, config, now = Math.floor(Date.now() / 1000), only = null, cwds = [] }) {
  const s = hygieneSettings(config);
  const ignore = loadIgnore(root, config);
  const repos = discoverRepos(root, config, { only });
  let docs = null;
  const docsLoader = () => (docs ||= liveSignalFiles(root, config));
  const out = [];
  const notes = {};
  for (const repo of repos) {
    const note = (t) => (notes[repo.name] ||= []).push(t);
    const entry = { repo: repo.name, branches: [], cleanWorktrees: [], liveReferenced: [], staleStashes: staleStashCount(repo.path, now, s.staleStashDays), deadWorktrees: [], dirtyWorktrees: [] };
    try {
      const ev = evaluateRepo(repo, { root, config, now, ignore, cwds, docsLoader });
      if (ev.skipped) note(`branch checks skipped: ${ev.skipped}`);
      entry.branches = ev.candidates.branches.map((b) => b.branch);
      entry.cleanWorktrees = ev.candidates.worktrees.map((w) => w.path);
      entry.liveReferenced = ev.liveReferenced;
    } catch (e) {
      note(`unreadable: ${String(e?.message || '').split('\n')[0]}`);
    }
    try {
      for (const w of listWorktrees(repo.path).slice(1)) {
        if (!fs.existsSync(w.path) || w.prunable) entry.deadWorktrees.push(w.path);
        else {
          const n = dirtyCount(w.path);
          if (n > 0) entry.dirtyWorktrees.push({ path: w.path, files: n });
        }
      }
    } catch {
      note('worktrees unreadable');
    }
    out.push(entry);
  }
  const total = (e) => e.branches.length + e.cleanWorktrees.length + e.staleStashes + e.deadWorktrees.length + e.dirtyWorktrees.length;
  return { repos: out, notes, debt: out.reduce((a, e) => a + total(e), 0), total };
}

export function formatLine(repos) {
  const parts = [];
  for (const e of repos) {
    const p = [];
    if (e.branches.length) p.push(`${e.branches.length} merged branches`);
    const held = e.liveReferenced?.length ?? 0;
    if (e.cleanWorktrees.length + held) p.push(`${e.cleanWorktrees.length + held} clean merged worktrees${held ? ` (${held} held by live references)` : ''}`);
    if (e.staleStashes) p.push(`${e.staleStashes} stale stashes`);
    if (e.deadWorktrees.length) p.push(`${e.deadWorktrees.length} dead worktrees`);
    if (e.dirtyWorktrees.length) p.push(`${e.dirtyWorktrees.length} dirty worktrees`);
    if (p.length) parts.push(`${e.repo} ${p.join(', ')}`);
  }
  return parts.join(' · ');
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  const loaded = loadConfig(value('--root', process.cwd()));
  if (!loaded.found && !value('--root', null)) return;
  const root = value('--root', null) ? value('--root') : loaded.root;
  const config = loaded.config;
  const now = value('--now', null) ? Number(value('--now')) : Math.floor(Date.now() / 1000);
  const only = value('--repo', null);
  const cwds = [process.cwd(), ...(process.env.PWD ? [process.env.PWD] : [])];
  const T0 = Date.now();

  let removedLine = '';
  if (flag('--line') && hygieneSettings(config).autoClean) {
    const r = runClean({ root, config, write: true, now, only, cwds });
    for (const e of r.errors) process.stderr.write(`git-hygiene-watch: ${e}\n`);
    const nb = r.removed.branches.length;
    const nw = r.removed.worktrees.length;
    if (nb || nw) removedLine = { nb, nw };
  }

  const res = scan({ root, config, now, only, cwds });
  const strictExit = flag('--strict') && res.debt > 0 ? 1 : 0;

  if (flag('--json')) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date(now * 1000).toISOString(), debt: res.debt, repos: res.repos, notes: res.notes }, null, 2) + '\n');
  } else if (flag('--line')) {
    const detail = formatLine(res.repos);
    if (removedLine) {
      process.stdout.write(`git hygiene: removed: ${removedLine.nb} branches + ${removedLine.nw} worktrees; remaining ${res.debt}${detail ? ` (${detail})` : ''} - details: node scripts/git-hygiene-watch.mjs\n`);
    } else if (res.debt > 0) {
      process.stdout.write(`git hygiene: ${detail} - details: node scripts/git-hygiene-watch.mjs - clean: node scripts/git-hygiene-clean.mjs --write\n`);
    }
  } else {
    if (!res.debt) console.log('git hygiene: no debt.');
    for (const e of res.repos) {
      if (!res.total(e)) continue;
      console.log(`\n${e.repo}`);
      for (const b of e.branches) console.log(`  merged-branch          ${b}`);
      for (const w of e.cleanWorktrees) console.log(`  clean-merged-worktree  ${w}`);
      for (const w of e.liveReferenced) console.log(`  held-worktree          ${w} (live reference)`);
      if (e.staleStashes) console.log(`  stale-stash            ${e.staleStashes} stash(es) older than ${hygieneSettings(config).staleStashDays} days (never touched by the cleaner)`);
      for (const w of e.deadWorktrees) console.log(`  dead-worktree          ${w}`);
      for (const w of e.dirtyWorktrees) console.log(`  dirty-worktree         ${w.path} (${w.files} files)`);
    }
    for (const [repo, list] of Object.entries(res.notes)) for (const n of list) console.log(`note [${repo}]: ${n}`);
    console.log(`\ntotal: ${res.debt} items - ${((Date.now() - T0) / 1000).toFixed(1)} s`);
  }
  if (strictExit) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`git-hygiene-watch: ${String(e?.message || e).split('\n')[0]}\n`);
  }
}
