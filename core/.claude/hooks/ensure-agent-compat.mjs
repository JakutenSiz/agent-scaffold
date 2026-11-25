#!/usr/bin/env node
// Enforces: R-43
// Keep Claude Code and Codex on the same physical skill/hook sources.
// Canonical files live under `.claude/`; Codex-facing directories are runtime
// links and are intentionally ignored by Git.
//
// Also (config.session.ensureHooksPath, default true): the push gate (.githooks/pre-push)
// ships with the repository, but git does not activate a hook directory on clone, so every
// machine needs core.hooksPath in the root and in each configured sub-repo (setup-hooks.sh
// does the same by hand). A repo whose core.hooksPath is EMPTY is set to <root>/.githooks and
// one line is printed; a repo already pointing somewhere else is left alone (warning only).
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';
import { scrubGitEnv } from '../../scripts/lib/worktree-check.mjs';

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function comparable(target) {
  const resolved = realpathSync.native(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function ensureDirectoryLink(repoRoot, linkRelative, sourceRelative) {
  const link = path.join(repoRoot, linkRelative);
  const source = path.join(repoRoot, sourceRelative);
  const existing = lstatOrNull(link);

  if (existing) {
    if (comparable(link) === comparable(source)) return;
    throw new Error(
      `[agent-compat] ${linkRelative} exists but does not point to ${sourceRelative}; ` +
        'refusing to overwrite it.',
    );
  }

  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
}

const sameDir = (a, b) => {
  const na = path.normalize(path.resolve(a));
  const nb = path.normalize(path.resolve(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

/**
 * Wire core.hooksPath for the root and every configured sub-repo. Returns the info/warning
 * lines it produced (also printed when `log` is console.log).
 */
export function ensureHooksPath(repoRoot, config, log = () => {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    log(line);
  };
  if (!(config.session?.ensureHooksPath ?? true)) return lines;
  const hooksDir = path.join(repoRoot, '.githooks');
  if (!lstatOrNull(path.join(hooksDir, 'pre-push'))) return lines;
  const git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { env: scrubGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const rels = ['.'];
  for (const r of config.repos ?? []) if (r.path && r.path !== '.' && !rels.includes(r.path)) rels.push(r.path);
  for (const rel of rels) {
    const dir = path.join(repoRoot, rel);
    if (!lstatOrNull(path.join(dir, '.git'))) continue; // not a git repo / submodule not initialised
    let current = '';
    try {
      current = git(dir, ['config', '--local', '--get', 'core.hooksPath']);
    } catch {
      // key unset
    }
    if (!current) {
      git(dir, ['config', '--local', 'core.hooksPath', hooksDir]);
      say(`[agent-compat] push gate enabled: ${rel} -> .githooks`);
    } else if (!sameDir(path.resolve(dir, current), hooksDir)) {
      say(`[agent-compat] ${rel}: core.hooksPath is '${current}', not ${hooksDir} — left unchanged (the scaffold pre-push gate may not run here)`);
    }
  }
  return lines;
}

function main() {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  ensureDirectoryLink(repoRoot, '.agents/skills', '.claude/skills');
  ensureDirectoryLink(repoRoot, '.codex/hooks', '.claude/hooks');
  try {
    const { config, found } = loadConfig(repoRoot);
    if (found) ensureHooksPath(repoRoot, config, console.log);
  } catch (error) {
    console.log(`[agent-compat] could not set up the push gate: ${error?.message ?? error}`);
  }
}

if (isMainModule(import.meta.url)) main();
