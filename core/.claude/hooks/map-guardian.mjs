#!/usr/bin/env node
// Enforces: R-21, R-22
// Map guardian — PreToolUse(Edit|Write). Two jobs:
// (1) JIT SELECTIVE MAP: on the FIRST edit in a repo per (session, agent), inject the part of
//     that repo's memory-bank/repoMap.md that matters for the file being edited — NOT the whole
//     map — plus a reuse-registry summary. We do not assume the agent already read the map; we
//     show the relevant slice at the decision moment. The injection is capped at
//     config.memoryBank.mapBudgetBytes (default 8000 bytes) per repo. Measured in the source
//     project: a 43 KB map injected whole on every first edit; the selective form is <= 8 KB.
//       - a map that fits the budget is injected as is;
//       - otherwise: table of contents (always) + the map lines that mention the edited file or
//         its ancestor directories (grouped under their heading) + the "task -> entry point"
//         section (the first section holding a table of paths). Trim order when over budget:
//         registry entries (from the end), then the task section, then matched lines (the
//         first few matched lines are always kept), and finally a hard byte cut.
//       - a trimmed injection says "map trimmed, full: <path>".
//     Section matching is structural (headings, paths, tables), so it works for maps written in
//     any language.
// (2) REUSE-REGISTRY GATE: if the content being written matches a trigger in
//     memory-bank/reuse-registry.json, does not reference the canonical piece, and the file
//     itself is neither the canonical nor an exempt file — DENY, use the existing piece
//     instead. An unparsable registry never blocks (fail-open) but prints a one-line warning
//     on stderr, because a silently broken registry means the gate is silently off.
//
// Measured: PreToolUse additionalContext reaches the agent as a separate system message,
// including for subagents.
//
// Config-driven: the memory-bank directory name comes from config.memoryBank.dir
// (repoMap.md / reuse-registry.json filenames are fixed), the budget from
// config.memoryBank.mapBudgetBytes, "source file" from the matching repo's sourceExtensions.
// Fails open (exit 0, no output) when this project has not installed the scaffold.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, repoFor } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

const DEFAULT_BUDGET_BYTES = 8000;
const MATCH_CAP = 40; // max matched map lines
const CORE_CAP = 70; // max lines of the task -> entry-point section
const MATCH_MIN = 12; // matched-block lines that are never trimmed (heading lines included)
const USE_CAP = 140; // registry `use` text is shortened to this many characters in the summary
const DEFAULT_SOURCE_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'php', 'rb', 'swift'];

// A registry field must be an array; a bare string is tolerated so one sloppy entry cannot crash
// the hook on every edit.
export const asArray = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []);

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

function cutToBytes(s, max) {
  if (byteLen(s) <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

// Parse a map into headings (levels 2-3, outside code fences) with their line index.
function parseHeadings(lines) {
  const headings = [];
  let fence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) headings.push({ level: m[1].length, title: line.trim(), lineNum: idx + 1, lineIdx: idx });
  });
  return headings;
}

const PATHISH = /[\w.-]+\/[\w.-]+|\.\w{1,5}\b/;

/**
 * Pure selector. Input: map text + the repo-relative edited path ('/' separated).
 * Returns the pieces the hook assembles under a byte budget:
 *   { totalLines, toc, matchLines[], matchCount, coreTitle, coreLines[] }
 * matchLines holds heading lines interleaved with matched lines, in document order.
 */
export function selectMapSlice(mapText, rel) {
  const lines = String(mapText || '').split(/\r?\n/);
  const headings = parseHeadings(lines);
  const toc = headings.map((h) => `- line ${h.lineNum}: ${h.title}`).join('\n');

  const headingForLine = new Array(lines.length).fill(-1);
  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    while (hi + 1 < headings.length && headings[hi + 1].lineIdx <= i) hi++;
    headingForLine[i] = hi;
  }

  // Needles, most specific first: ancestors with >= 3 segments, then 2 segments, then the file
  // name, then the single top-level directory ("src/") as a last resort (alone it matches too
  // much, so it only runs after the specific tiers).
  const parts = String(rel || '').split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const stem = fileName.replace(/\.[^.]+$/, '');
  const dirParts = parts.slice(0, -1);
  const tier3 = [];
  const tier2 = [];
  for (let i = dirParts.length; i >= 2; i--) {
    const seg = dirParts.slice(0, i);
    (seg.length >= 3 ? tier3 : tier2).push(seg.join('/'));
  }
  // Maps often omit a leading wrapper directory (e.g. "app/src/x" written as "src/x").
  for (let i = dirParts.length; i >= 3; i--) {
    const seg = dirParts.slice(1, i);
    (seg.length >= 3 ? tier3 : tier2).push(seg.join('/'));
  }
  const fileNeedles = [fileName];
  if (stem.length >= 4 && stem !== fileName) fileNeedles.push(stem);
  const tier1 = dirParts.length ? [dirParts[0] + '/'] : [];

  const matchedIdx = [];
  const seen = new Set();
  const scan = (needles) => {
    const ns = needles.filter(Boolean);
    if (!ns.length) return;
    for (let i = 0; i < lines.length && matchedIdx.length < MATCH_CAP; i++) {
      if (seen.has(i) || headings.some((h) => h.lineIdx === i)) continue;
      if (ns.some((n) => lines[i].includes(n))) {
        matchedIdx.push(i);
        seen.add(i);
      }
    }
  };
  scan(tier3);
  scan(tier2);
  scan(fileNeedles);
  scan(tier1);
  matchedIdx.sort((a, b) => a - b);

  const matchLines = [];
  let lastHeading = -2;
  for (const idx of matchedIdx) {
    const h = headingForLine[idx];
    if (h !== lastHeading) {
      if (h >= 0) matchLines.push(`${headings[h].title} (line ${headings[h].lineNum})`);
      lastHeading = h;
    }
    matchLines.push(lines[idx]);
  }

  // Core: the first section holding a table with >= 2 rows that mention a path or file name —
  // the "task -> entry point" table every map template carries, whatever its heading says.
  let coreTitle = null;
  let coreLines = [];
  for (let k = 0; k < headings.length; k++) {
    const h = headings[k];
    let end = lines.length;
    for (let j = k + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        end = headings[j].lineIdx;
        break;
      }
    }
    const body = lines.slice(h.lineIdx + 1, end);
    const rows = body.filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l) && PATHISH.test(l));
    if (rows.length >= 2) {
      coreTitle = h.title;
      coreLines = lines.slice(h.lineIdx, end).slice(0, CORE_CAP);
      break;
    }
  }

  return { totalLines: lines.length, toc, matchLines, matchCount: matchedIdx.length, coreTitle, coreLines };
}

function registryLines(registry) {
  const shorten = (s) => (s.length > USE_CAP ? s.slice(0, USE_CAP - 1).trimEnd() + '…' : s);
  return registry && Array.isArray(registry.entries)
    ? registry.entries.map((e) => `- ${e.name}: ${asArray(e.canonical).join(', ')}${e.use ? ' — ' + shorten(String(e.use)) : ''}`)
    : [];
}

/**
 * Pure builder of the injected context. Never exceeds `budget` bytes.
 * opts: { mapText, rel, repoName, mapPath, registry, mbDir, budget }
 */
export function buildContext({ mapText, rel, repoName, mapPath, registry, mbDir = 'memory-bank', budget = DEFAULT_BUDGET_BYTES }) {
  const total = registryLines(registry);
  const regTitle = `\n\nREUSABLE PIECES (${mbDir}/reuse-registry.json) — use these before writing a new one:\n`;
  const regText = (kept) => {
    if (!total.length) return '';
    const dropped = total.length - kept.length;
    return regTitle + kept.join('\n') + (dropped ? `\n- (+${dropped} more entries — full list: ${mbDir}/reuse-registry.json)` : '');
  };
  const rules =
    'Rules: record any new source file in repoMap.md (the push gate rejects a push whose new files cannot be found ' +
    'there); before writing a shared piece (component/helper), check the reuse registry.';

  // 1) The whole map fits: inject it as is.
  const wholeHead =
    `[map-guardian] This is your FIRST edit in '${repoName}' this session. Below is that repo's ${mbDir}/repoMap.md — ` +
    `check here first for "does a file/piece for this already exist". ${rules}`;
  const whole = wholeHead + regText(total) + '\n\n--- repoMap.md ---\n' + mapText;
  if (byteLen(whole) <= budget) return whole;

  // 2) Selective slice under the budget.
  const sel = selectMapSlice(mapText, rel);
  const head =
    `[map-guardian] This is your FIRST edit in '${repoName}' this session. Below is NOT the whole repoMap.md but the ` +
    `part selected for \`${rel}\` — map trimmed, full: ${mapPath} (${sel.totalLines} lines). ${rules}`;
  const tocBlock = '\n\n--- Table of contents (repoMap.md headings) ---\n' + sel.toc;
  let matchLines = sel.matchLines.slice();
  const matchBlock = () =>
    matchLines.length
      ? `\n\n--- Lines of repoMap.md matching '${rel}' ---\n` + matchLines.join('\n')
      : `\n\n--- No line of repoMap.md matches '${rel}' directly ---`;
  let coreLines = sel.coreLines.slice();
  const coreBlock = () => (coreLines.length ? `\n\n--- ${sel.coreTitle} ---\n` + coreLines.join('\n') : '');
  let regKept = total.slice();

  const size = () => byteLen(head + tocBlock + matchBlock() + coreBlock() + regText(regKept));
  while (size() > budget && regKept.length) regKept = regKept.slice(0, -1);
  while (size() > budget && coreLines.length > 1) coreLines = coreLines.slice(0, -1);
  if (size() > budget) coreLines = [];
  while (size() > budget && matchLines.length > MATCH_MIN) matchLines = matchLines.slice(0, -1);

  // Last resort (a huge table of contents): hard byte cut, so the cap is a guarantee.
  return cutToBytes(head + tocBlock + matchBlock() + coreBlock() + regText(regKept), budget);
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const ti = input.tool_input || {};
  const file = String(ti.file_path || '');
  if (!file) process.exit(0);
  const content = String(ti.content ?? ti.new_string ?? '');

  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { root, config, found } = loadConfig(startDir);
  if (!found) process.exit(0); // scaffold not installed here — stay silent

  const MB_DIR = config.memoryBank.dir;
  const budget = Number(config.memoryBank?.mapBudgetBytes) > 0 ? Number(config.memoryBank.mapBudgetBytes) : DEFAULT_BUDGET_BYTES;

  // Repo root = nearest ancestor dir containing <memoryBankDir>/repoMap.md.
  let repoRoot = '';
  let d = path.dirname(path.resolve(file));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(d, MB_DIR, 'repoMap.md'))) {
      repoRoot = d;
      break;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!repoRoot) process.exit(0); // repo without a map (e.g. the umbrella root) — stay out of the way
  const rel = path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');

  const stateDir = path.join(root, '.claude', '.read-guard');
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {}
  const sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '').slice(0, 64);
  const agent = String(input.agent_id || 'main').replace(/[^\w-]/g, '').slice(0, 32);
  const key = createHash('sha1').update(`${sid}|${agent}|${repoRoot}`).digest('hex').slice(0, 16);
  const jitFile = path.join(stateDir, `jit-${key}`);

  const output = (o) => {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
    process.exit(0);
  };

  let registry = null;
  const registryPath = path.join(repoRoot, MB_DIR, 'reuse-registry.json');
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (e) {
    // Fail-open (never deny) but not silent: a broken registry switches the deny gate off unnoticed.
    if (existsSync(registryPath)) {
      process.stderr.write(
        `[map-guardian] WARNING: ${path.basename(repoRoot)}/${MB_DIR}/reuse-registry.json could not be parsed — ` +
          `the reuse deny gate is OFF in this repo: ${String((e && e.message) || e).replace(/\s+/g, ' ')}\n`,
      );
    }
  }

  // (2) Reuse-registry gate — source files only. "Source" is defined by the matching repo's
  // `sourceExtensions` in agent-scaffold.config.json (language-agnostic: py, go, rs, ... work the
  // same as ts/js); falls back to a broad default list.
  const repoEntry = repoFor(root, config, file);
  const SOURCE_EXT = repoEntry && repoEntry.sourceExtensions && repoEntry.sourceExtensions.length ? repoEntry.sourceExtensions : DEFAULT_SOURCE_EXT;
  const escapeExt = (e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isSource = new RegExp('\\.(' + SOURCE_EXT.map(escapeExt).join('|') + ')$').test(rel);
  if (registry && isSource && content) {
    let existing = '';
    try {
      existing = readFileSync(path.resolve(file), 'utf8');
    } catch {}
    const allContent = content + '\n' + existing;
    for (const e of registry.entries || []) {
      const canonical = asArray(e.canonical);
      if (canonical.some((c) => rel === c || rel.endsWith('/' + c))) continue; // the canonical file itself
      if (asArray(e.exempt).some((g) => g && rel.includes(g))) continue;
      const trigger = asArray(e.triggers).find((t) => t && content.includes(t));
      if (!trigger) continue;
      const names = canonical.map((c) => path.basename(c).replace(/\.[^.]+$/, ''));
      if (names.some((n) => allContent.includes(n))) continue; // already references the canonical piece
      output({
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[map-guardian] A CANONICAL piece for "${e.name}" already exists in this repo: ${canonical.join(', ')}` +
          (e.use ? ` (${e.use})` : '') +
          `. The content you are writing matches trigger "${trigger}" but does not reference the canonical piece — ` +
          'do NOT write a new one, import/adapt the existing one. If a genuinely new piece is needed, FIRST update ' +
          `${MB_DIR}/reuse-registry.json (new canonical or exempt entry), then write.`,
      });
    }
  }

  // (1) JIT map — once per (session, agent, repo).
  if (!existsSync(jitFile)) {
    try {
      writeFileSync(jitFile, String(Date.now()));
    } catch {}
    let mapText = '';
    try {
      mapText = readFileSync(path.join(repoRoot, MB_DIR, 'repoMap.md'), 'utf8');
    } catch {}
    output({
      additionalContext: buildContext({
        mapText,
        rel,
        repoName: path.basename(repoRoot),
        mapPath: path.join(repoRoot, MB_DIR, 'repoMap.md'),
        registry,
        mbDir: MB_DIR,
        budget,
      }),
    });
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
