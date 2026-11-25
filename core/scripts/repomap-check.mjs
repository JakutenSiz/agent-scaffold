#!/usr/bin/env node
// Enforces: R-21
// repoMap freshness check — are newly added source files in a repo
// "findable" in <memoryBank.dir>/repoMap.md?
//
//   node scripts/repomap-check.mjs <repoDir> [--range A..B | --all] [--json]
//
// Without --range, looks at everything added since repoMap.md's last commit;
// --all audits every tracked source file (also the automatic fallback when
// repoMap.md has never been committed, so a fresh bootstrap cannot false-green).
//
// COVERAGE RULE (ported from a calibration run, unchanged):
//   - the file's basename (without extension) appears in the map -> covered;
//   - the path passes through an INVENTORY directory (default list below covers
//     frontend AND backend layouts: components/hooks/shared/infra/screens/common/
//     utils/helpers/services/core, or a file directly under lib/) -> NAME REQUIRED
//     (it must be findable by its own shared-piece name — this is the lesson from
//     a repo where the same shared component got rewritten three times because
//     nothing enforced this);
//   - otherwise, if ANY ancestor directory with >= 2 path segments appears in the
//     map (with trailing slash, with or without the leading segment) -> covered.
//     This is deliberately lenient: listing `src/app/` covers everything beneath
//     it. Files directly under a one-segment top-level dir (scripts/x.py, bin/y)
//     are covered by listing that dir (`scripts/`); deeper files under a
//     one-segment dir still need a two-segment ancestor or their own name, so a
//     bare `src/` never covers a whole tree.
//
// MATCHING IS CASE-INSENSITIVE and uses the locale of config.language
// (`toLocaleLowerCase(language)`), so a map written in a language with special case
// pairs (Turkish dotted/dotless I, for example) still matches file names: plain
// `toLowerCase()` turns "İ" into "i" + a combining dot and the match silently fails.
//
// Customizable per repo with <repoDir>/<memoryBank.dir>/repomap-guard.json:
//   { "inventorySegments": [...], "ignore": ["<regex>", ...] }
//
// Source file extensions: if repoDir resolves to a repo listed in
// agent-scaffold.config.json, that repo's `sourceExtensions` is used;
// otherwise falls back to the built-in default list. The memory-bank
// directory name also comes from config.memoryBank.dir when available.
//
// The argument is a directory, or else the `name` of a config.repos entry; neither -> exit 2.
// Agent tool directories (.claude/, .codex/, .agents/, .githooks/) are never product source.
//
// Exit code: 0 = clean, 1 = there are files missing from the map, 2 = bad argument,
// 0 = no repoMap.md exists at all (fail-open) or a git error (fail-open).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, repoFor } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const DEFAULT_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'];
export const DEFAULT_MEMORY_BANK_DIR = 'memory-bank';
export const DEFAULT_INVENTORY = ['components', 'hooks', 'shared', 'infra', 'screens', 'common', 'utils', 'helpers', 'services', 'core'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locale-aware lower-casing; falls back to plain toLowerCase() on an invalid locale tag. */
export function lower(s, locale) {
  try {
    return locale ? String(s).toLocaleLowerCase(locale) : String(s).toLowerCase();
  } catch {
    return String(s).toLowerCase();
  }
}

/** Parse argv (without node/script). The range value is never mistaken for the repo dir. */
export function parseArgs(args) {
  let range = '';
  let repoArg = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--range=')) range = a.slice(8);
    else if (a === '--range') range = args[++i] || '';
    else if (!a.startsWith('--') && !repoArg) repoArg = a;
  }
  return { repoArg: repoArg || '.', repoDir: path.resolve(repoArg || '.'), range, json: args.includes('--json'), all: args.includes('--all') };
}

/** Regexes for files that never need a map mention (built-ins + the repo's guard.ignore). */
export function buildIgnore(guardIgnore, memoryBankDir) {
  return (guardIgnore || []).map((r) => new RegExp(r)).concat([
    /(^|\/)(tests?|__tests__|e2e|fixtures?)\//, /\.(test|spec|stories)\./, /(^|\/)locales?\//,
    /\.md$/, /\.d\.ts$/, /(^|\/)migrations\//, new RegExp(`(^|/)${escapeRe(memoryBankDir)}/`), /(^|\/)node_modules\//,
    /(^|\/)(public|assets|static)\//, /\.(json|ya?ml|css|scss|svg|png|jpe?g|lock)$/,
    // Agent tool directories at the repo root are the scaffold's own tooling, not product source.
    /^\.claude\//, /^\.codex\//, /^\.agents\//, /^\.githooks\//,
  ]);
}

/** Keep only source files that are not ignored; de-duplicated. */
export function filterSource(files, extensions, ignore) {
  const sourceRe = new RegExp(`\\.(${extensions.map(escapeRe).join('|')})$`);
  return [...new Set(files.filter((f) => f && sourceRe.test(f) && !ignore.some((r) => r.test(f))))];
}

/**
 * Is file `f` (repo-relative, '/' separated) findable in `map`?
 * opts: { inventory: Set<string>, locale: string }
 */
export function isCovered(f, map, { inventory = new Set(DEFAULT_INVENTORY), locale = '' } = {}) {
  const m = lower(map, locale);
  const file = lower(f, locale);
  const segs = file.split('/');
  const dirSegs = segs.slice(0, -1);
  const baseName = segs[segs.length - 1];
  const base = baseName.replace(/\.[^.]+$/, '');
  // Name match: basename (>= 4 chars to avoid noise), or for short names the full
  // filename ("db.js") or "parentDir/basename" ("lib/db") — so a 2-letter helper
  // under lib/ is still coverable.
  if (base.length >= 4 && m.includes(base)) return true;
  if (m.includes(baseName)) return true;
  if (dirSegs.length && m.includes(`${dirSegs[dirSegs.length - 1]}/${base}`)) return true;
  const inInventory =
    dirSegs.some((s) => inventory.has(s)) ||
    dirSegs[dirSegs.length - 1] === 'lib'; // file directly under lib/
  if (inInventory) return false; // name required
  for (let i = dirSegs.length; i >= 2; i--) {
    const d = dirSegs.slice(0, i).join('/') + '/';
    if (m.includes(d) || m.includes(d.replace(/^[^/]+\//, ''))) return true;
  }
  // depth-1 file under a one-segment dir (scripts/x.py): the dir itself may cover it
  if (dirSegs.length === 1 && m.includes(dirSegs[0] + '/')) return true;
  return false;
}

/**
 * Run the check. Returns { skipped } when there is no map, { failOpen } on a git error,
 * else { repo, mode, added, missing }.
 */
export function check({ repoDir, range = '', all = false }) {
  const { root, config, found } = loadConfig(repoDir);
  const matchedRepo = found
    ? (config.repos ?? []).find((r) => path.resolve(root, r.path || '.') === repoDir) || repoFor(root, config, repoDir)
    : null;
  const memoryBankDir = (found && config.memoryBank && config.memoryBank.dir) || DEFAULT_MEMORY_BANK_DIR;
  const locale = (found && config.language) || '';
  const extensions = matchedRepo && matchedRepo.sourceExtensions && matchedRepo.sourceExtensions.length
    ? matchedRepo.sourceExtensions
    : DEFAULT_EXTENSIONS;

  const git = (a) => execFileSync('git', a, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  const mapRel = `${memoryBankDir}/repoMap.md`;
  const mapAbs = path.join(repoDir, mapRel);
  if (!existsSync(mapAbs)) return { skipped: 'no repoMap.md' };
  const map = readFileSync(mapAbs, 'utf8');
  let guard = {};
  try {
    guard = JSON.parse(readFileSync(path.join(repoDir, memoryBankDir, 'repomap-guard.json'), 'utf8'));
  } catch {
    // no override -- use defaults
  }
  const inventory = new Set(guard.inventorySegments || DEFAULT_INVENTORY);
  const ignore = buildIgnore(guard.ignore, memoryBankDir);

  let added = [];
  let mode = 'since-map-commit';
  try {
    if (all) {
      mode = 'all-tracked';
      added = git(['ls-files', '--', '.']).split('\n');
    } else if (range) {
      mode = 'range';
      added = git(['log', '--diff-filter=A', '--name-only', '--format=', range, '--', '.']).split('\n');
    } else {
      const since = git(['log', '-1', '--format=%aI', '--', mapRel]);
      if (!since) {
        // repoMap.md was never committed (fresh bootstrap): a --since window would be
        // empty and report a FALSE GREEN. Audit every tracked file instead.
        mode = 'all-tracked (repoMap.md not committed yet)';
        added = git(['ls-files', '--', '.']).split('\n');
      } else {
        added = git(['log', '--diff-filter=A', '--name-only', '--format=', `--since=${since}`, '--', '.']).split('\n');
      }
    }
  } catch {
    return { failOpen: true }; // git error -- fail-open
  }
  added = filterSource(added, extensions, ignore);
  const missing = added.filter((f) => !isCovered(f, map, { inventory, locale }));
  return { repo: path.basename(repoDir), mode, added: added.length, missing };
}

/**
 * Resolves the CLI argument: an existing directory first, else a config.repos[].name (resolved
 * against the config root). Returns the absolute directory or null.
 */
export function resolveRepoDir(arg, cwd = process.cwd()) {
  const asDir = path.resolve(cwd, arg);
  try { if (statSync(asDir).isDirectory()) return asDir; } catch { /* not a directory */ }
  const { root, config, found } = loadConfig(cwd);
  const hit = found ? (config.repos ?? []).find((r) => r.name === arg) : null;
  if (!hit) return null;
  const dir = path.resolve(root, hit.path || '.');
  try { if (statSync(dir).isDirectory()) return dir; } catch { /* configured path missing */ }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const resolved = resolveRepoDir(opts.repoArg);
  if (!resolved) {
    console.error(`repomap-check: "${opts.repoArg}" is not a directory or a configured repo name.`);
    process.exit(2);
  }
  opts.repoDir = resolved;
  const res = check(opts);
  if (res.skipped) {
    if (opts.json) console.log(JSON.stringify({ skipped: res.skipped }));
    process.exit(0);
  }
  if (res.failOpen) process.exit(0);
  if (opts.json) {
    console.log(JSON.stringify({ repo: res.repo, mode: res.mode, added: res.added, missing: res.missing }));
  } else {
    console.log(`${res.repo} [${res.mode}]: ${res.added} source file(s) checked, ${res.missing.length} NOT FOUND in the map`);
    for (const f of res.missing.slice(0, 25)) console.log('  - ' + f);
    if (res.missing.length > 25) console.log(`  ... +${res.missing.length - 25}`);
  }
  process.exit(res.missing.length ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
