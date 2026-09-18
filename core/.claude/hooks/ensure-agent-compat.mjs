#!/usr/bin/env node
// Keep Claude Code and Codex on the same physical skill/hook sources.
// Canonical files live under `.claude/`; Codex-facing directories are runtime
// links and are intentionally ignored by Git.
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

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

function ensureDirectoryLink(linkRelative, sourceRelative) {
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

ensureDirectoryLink('.agents/skills', '.claude/skills');
ensureDirectoryLink('.codex/hooks', '.claude/hooks');
