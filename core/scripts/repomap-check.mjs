#!/usr/bin/env node
// repoMap freshness check — are newly added source files in a repo
// "findable" in <memoryBank.dir>/repoMap.md?
//
//   node scripts/repomap-check.mjs <repoDir> [--range A..B | --all] [--json]
//
// Without --range, looks at everything added since repoMap.md's last commit;
// --all audits every tracked source file (also the automatic fallback when
// repoMap.md has never been committed, so a fresh bootstrap cannot false-green).
//
// COVERAGE RULE (ported from the 2026-09-08 calibration, unchanged):
//   - the file's basename (without extension) appears in the map -> covered;
//   - the path passes through an INVENTORY directory (components/hooks/shared/
//     infra/screens, or a file directly under lib/) -> NAME REQUIRED (it must
//     be findable by its own shared-piece name — this is the lesson from a
//     repo where the same shared component got rewritten three times because
//     nothing enforced this);
//   - otherwise, if any parent directory (>=2 path segments) appears in the
//     map -> covered.
//
// Customizable per repo with <repoDir>/<memoryBank.dir>/repomap-guard.json:
//   { "inventorySegments": [...], "ignore": ["<regex>", ...] }
//
// Source file extensions: if repoDir resolves to a repo listed in
// agent-scaffold.config.json, that repo's `sourceExtensions` is used;
// otherwise falls back to the built-in default list. The memory-bank
// directory name also comes from config.memoryBank.dir when available.
//
// Exit code: 0 = clean, 1 = there are files missing from the map,
// 0 = no repoMap.md exists at all (fail-open).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, repoFor } from './lib/config.mjs';

const DEFAULT_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'];
const DEFAULT_MEMORY_BANK_DIR = 'memory-bank';

const args = process.argv.slice(2);
const repoDir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const range = (args.find((a) => a.startsWith('--range=')) || '').slice(8) || (args.includes('--range') ? args[args.indexOf('--range') + 1] : '');
const json = args.includes('--json');
const all = args.includes('--all');

const { root, config, found } = loadConfig(repoDir);
const matchedRepo = found
  ? (config.repos ?? []).find((r) => path.resolve(root, r.path || '.') === repoDir) || repoFor(root, config, repoDir)
  : null;
const memoryBankDir = (found && config.memoryBank && config.memoryBank.dir) || DEFAULT_MEMORY_BANK_DIR;
const extensions = matchedRepo && matchedRepo.sourceExtensions && matchedRepo.sourceExtensions.length
  ? matchedRepo.sourceExtensions
  : DEFAULT_EXTENSIONS;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SOURCE_RE = new RegExp(`\\.(${extensions.map(escapeRe).join('|')})$`);

const git = (a) => execFileSync('git', a, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const mapRel = `${memoryBankDir}/repoMap.md`;
const mapAbs = path.join(repoDir, mapRel);
if (!existsSync(mapAbs)) {
  if (json) console.log(JSON.stringify({ skipped: 'no repoMap.md' }));
  process.exit(0);
}
const map = readFileSync(mapAbs, 'utf8');
let guard = {};
try {
  guard = JSON.parse(readFileSync(path.join(repoDir, memoryBankDir, 'repomap-guard.json'), 'utf8'));
} catch {
  // no override -- use defaults
}
const INVENTORY = new Set(guard.inventorySegments || ['components', 'hooks', 'shared', 'infra', 'screens']);
const IGNORE = (guard.ignore || []).map((r) => new RegExp(r)).concat([
  /(^|\/)(tests?|__tests__|e2e|fixtures?)\//, /\.(test|spec|stories)\./, /(^|\/)locales?\//,
  /\.md$/, /\.d\.ts$/, /(^|\/)migrations\//, new RegExp(`(^|/)${escapeRe(memoryBankDir)}/`), /(^|\/)node_modules\//,
  /(^|\/)(public|assets|static)\//, /\.(json|ya?ml|css|scss|svg|png|jpe?g|lock)$/,
]);

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
  process.exit(0); // git error -- fail-open
}
added = [...new Set(added.filter((f) => f && SOURCE_RE.test(f) && !IGNORE.some((r) => r.test(f))))];

function isCovered(f) {
  const base = path.basename(f).replace(/\.[^.]+$/, '');
  const dirSegs0 = f.split('/').slice(0, -1);
  // Name match: basename (>= 4 chars to avoid noise), or for short names the full
  // filename ("db.js") or "parentDir/basename" ("lib/db") — so a 2-letter helper
  // under lib/ is still coverable.
  if (base.length >= 4 && map.includes(base)) return true;
  if (map.includes(path.basename(f))) return true;
  if (dirSegs0.length && map.includes(`${dirSegs0[dirSegs0.length - 1]}/${base}`)) return true;
  const segs = f.split('/');
  const dirSegs = segs.slice(0, -1);
  const inInventory =
    dirSegs.some((s) => INVENTORY.has(s)) ||
    dirSegs[dirSegs.length - 1] === 'lib'; // file directly under lib/
  if (inInventory) return false; // name required
  for (let i = dirSegs.length; i >= 2; i--) {
    const d = dirSegs.slice(0, i).join('/') + '/';
    if (map.includes(d) || map.includes(d.replace(/^[^/]+\//, ''))) return true;
  }
  return false;
}
const missing = added.filter((f) => !isCovered(f));
if (json) {
  console.log(JSON.stringify({ repo: path.basename(repoDir), mode, added: added.length, missing }));
} else {
  console.log(`${path.basename(repoDir)} [${mode}]: ${added.length} source file(s) checked, ${missing.length} NOT FOUND in the map`);
  for (const f of missing.slice(0, 25)) console.log('  - ' + f);
  if (missing.length > 25) console.log(`  ... +${missing.length - 25}`);
}
process.exit(missing.length ? 1 : 0);
