#!/usr/bin/env node
// Enforces: R-28
/**
 * handoff-packet -- a handoff note built from observed facts, with a byte budget and secrets masked.
 *
 * WHY: a handoff written from memory drifts from the repository: it forgets the unpushed commit,
 * the dirty file, the claim still open. This script reads the facts instead and writes a short
 * packet the next session (on any machine -- the file is tracked in git) can trust.
 *
 * CONTENT, in order: the board item (title, Remaining, Human step, Last evidence) · the claim
 * row(s) · for every configured repo: branch, ahead/behind, dirty files (`.claude/` excluded),
 * last 5 commit subjects, a `PUSH PENDING` line when commits are not pushed · open worktrees ·
 * the optional `--note` text.
 *
 * BUDGET: `config.handoff.budgetBytes`. When the packet is larger, sections are cut from the END
 * and every cut is announced by a `truncated: <section> (<bytes>)` line; the result never exceeds
 * the budget.
 *
 * MASKING: token prefixes (AWS, GitHub, Slack, Stripe, Google), PEM blocks, `Bearer ...`,
 * `password|secret|token|api key = value`, JWTs and 32+ character hex / base64 runs become
 * `[REDACTED]` before anything is measured or written.
 *
 * DETERMINISM: the same repository state gives the same bytes. A timestamp is written only by
 * `--write` (header line `generated:`); `buildPacket` takes it as a parameter, so tests inject it.
 *
 * USAGE:
 *   node scripts/handoff-packet.mjs <item-code> [--note "<text>"]           # print the packet
 *   node scripts/handoff-packet.mjs <item-code> --write [--note "<text>"]   # write <handoff.dir>/<code>.md,
 *                                                                           # print ONE pointer line
 *   node scripts/handoff-packet.mjs --prune                                 # list packets nobody owns
 *   node scripts/handoff-packet.mjs --prune --write                         # ... and delete them
 * A packet is owned while an open claim row or an open coordination note still names its code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { boardFormat, parseItems, fieldText, escapeRegExp } from './lib/board-format.mjs';
import { readTable, parseClaim } from './lib/coordination-table.mjs';
import { discoverRepos, git, listWorktrees } from './lib/git-hygiene-common.mjs';

const REDACTED = '[REDACTED]';
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_COUNT = 5;
const DIRTY_CAP = 25;

// Order matters: whole blocks and structured tokens first, generic runs last.
const MASKS = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`],
  [/(?<![A-Za-z0-9_])((?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi, `$1$2${REDACTED}`],
  [/(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g, REDACTED],
];
// Base64-looking runs: 32+ characters AND a digit, a lowercase and an uppercase letter, so long
// plain words and path segments survive.
const B64_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;

/** Replaces every secret-looking token in `text` with `[REDACTED]`. */
export function maskSecrets(text) {
  let out = String(text);
  for (const [re, to] of MASKS) out = out.replace(re, to);
  return out.replace(B64_RE, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? REDACTED : m));
}

const bytes = (s) => Buffer.byteLength(s);

/**
 * Joins `head` and the sections ({ name, text }) and cuts from the END until the result fits
 * `budget` bytes. A cut section keeps its leading lines and ends with `truncated: <name> (<bytes>)`
 * (bytes = what was removed); a section cut entirely is replaced by that line alone.
 */
export function fitBudget(head, sections, budget) {
  const secs = sections.map((s) => ({ name: s.name, lines: s.text.split('\n'), size: bytes(s.text), cut: 0, dropped: false }));
  const render = () => {
    const parts = secs.map((s) => {
      if (s.dropped) return `truncated: ${s.name} (${s.size})`;
      if (!s.cut) return s.lines.join('\n');
      const kept = s.lines.slice(0, s.lines.length - s.cut);
      return `${kept.join('\n')}\ntruncated: ${s.name} (${s.size - bytes(kept.join('\n'))})`;
    });
    return [head, ...parts].join('\n\n') + '\n';
  };
  let out = render();
  while (bytes(out) > budget) {
    const s = [...secs].reverse().find((x) => !x.dropped);
    if (!s) break;
    if (s.lines.length - s.cut > 1) s.cut++; else s.dropped = true;
    out = render();
  }
  while (bytes(out) > budget && out.length) out = out.slice(0, -1); // budget smaller than the markers
  return out;
}

const tryGit = (cwd, args) => { try { return git(cwd, args, 10000); } catch { return null; } };

function boardSection(root, config, code) {
  const file = path.resolve(root, config.board?.file || 'task-board.md');
  const lines = ['## Board item'];
  if (!fs.existsSync(file)) return [...lines, `(board file ${path.basename(file)} not found)`].join('\n');
  const fmt = boardFormat(config);
  const item = parseItems(fs.readFileSync(file, 'utf8'), fmt).find((it) => it.key === code);
  if (!item) return [...lines, `(item ${code} not found in ${path.basename(file)})`].join('\n');
  const remaining = item.remaining.replace(fmt.re.remaining, '').trim();
  lines.push(item.heading.replace(/^###\s+/, ''));
  lines.push(`Remaining: ${remaining || '-'}`);
  lines.push(`Human step: ${fieldText(item, fmt, 'humanStep') || '-'}`);
  lines.push(`Last evidence: ${fieldText(item, fmt, 'lastEvidence') || '-'}`);
  return lines.join('\n');
}

function claimSection(root, config, code) {
  const file = path.resolve(root, config.coordination?.file || 'coordination.md');
  const lines = ['## Claim'];
  if (!fs.existsSync(file)) return [...lines, '(no coordination file)'].join('\n');
  const rows = readTable(fs.readFileSync(file, 'utf8').split('\n')).rows
    .map(parseClaim).filter((c) => c.itemCode === code && !c.closed);
  if (!rows.length) return [...lines, '(no open claim)'].join('\n');
  return [...lines, '| Session | Item code | Since | State |', '|---|---|---|---|', ...rows.flatMap((c) => c.raw)].join('\n');
}

function repoSection(repo) {
  const dir = repo.path;
  const lines = [`## Repo: ${repo.name}`];
  const branchOut = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchOut === null) return [...lines, '(not readable as a git repository)'].join('\n');
  const branch = branchOut.trim();
  const upstream = (tryGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || '').trim();
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = (tryGit(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]) || '0\t0').trim().split(/\s+/);
    ahead = Number(counts[0]) || 0;
    behind = Number(counts[1]) || 0;
  }
  lines.push(upstream ? `branch: ${branch} (upstream ${upstream}, ahead ${ahead}, behind ${behind})` : `branch: ${branch} (no upstream)`);
  if (upstream && ahead > 0) lines.push(`PUSH PENDING: ${ahead} commit(s) not pushed to ${upstream}`);
  else if (!upstream && branch !== 'HEAD' && tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null) lines.push('PUSH PENDING: branch has no upstream');

  const dirty = (tryGit(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']) || '')
    .split('\n').filter((s) => s.trim()).filter((s) => !/^.. "?\.claude\//.test(s));
  lines.push(`dirty files: ${dirty.length}`);
  for (const d of dirty.slice(0, DIRTY_CAP)) lines.push(`  ${d}`);
  if (dirty.length > DIRTY_CAP) lines.push(`  ... and ${dirty.length - DIRTY_CAP} more`);

  const log = (tryGit(dir, ['log', `-${COMMIT_COUNT}`, '--format=%h %s']) || '').split('\n').filter(Boolean);
  lines.push('recent commits:');
  for (const c of log) lines.push(`  ${c}`);
  if (!log.length) lines.push('  (none)');
  return lines.join('\n');
}

function worktreeSection(root, repos) {
  const base = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  const lines = ['## Worktrees'];
  for (const repo of repos) {
    let list = [];
    try { list = listWorktrees(repo.path).slice(1); } catch {} // first entry = the main worktree
    for (const w of list) {
      lines.push(`${repos.length > 1 ? `${repo.name}: ` : ''}${path.relative(base, w.path) || '.'} branch ${w.branch || '(detached)'} ${w.head.slice(0, 7)}`);
    }
  }
  if (lines.length === 1) lines.push('(none)');
  return lines.join('\n');
}

/**
 * Builds the packet text (masked, within budget). Pure with respect to its inputs: `generatedAt`
 * (a string, or null/undefined for none) is the only time-dependent part and is injected.
 */
export function buildPacket({ root, config, code, note = '', generatedAt = null, budgetBytes }) {
  const budget = Number(budgetBytes ?? config.handoff?.budgetBytes) || 8192;
  const repos = discoverRepos(root, config);
  const head = [`# Handoff: ${code}`, ...(generatedAt ? [`generated: ${generatedAt}`] : [])].join('\n');
  const sections = [
    { name: 'board item', text: boardSection(root, config, code) },
    { name: 'claim', text: claimSection(root, config, code) },
    ...repos.map((r) => ({ name: `repo ${r.name}`, text: repoSection(r) })),
    { name: 'worktrees', text: worktreeSection(root, repos) },
  ];
  if (note) sections.push({ name: 'note', text: `## Note\n${note}` });
  return fitBudget(maskSecrets(head), sections.map((s) => ({ name: s.name, text: maskSecrets(s.text) })), budget);
}

/** Item codes that still have an open claim row or are named in an open coordination note. */
export function ownedCodes(coordinationText, codes) {
  const lines = coordinationText.split('\n');
  const owned = new Set();
  for (const c of readTable(lines).rows.map(parseClaim)) if (!c.closed) owned.add(c.itemCode);
  const SKIP_H2 = /^## (?:Protocol|Active claims|Closed|✅)/;
  let fence = false;
  let skipH2 = true;
  let skipH3 = false;
  const body = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; if (!skipH2 && !skipH3) body.push(line); continue; }
    if (!fence && /^## /.test(line)) { skipH2 = SKIP_H2.test(line); skipH3 = false; continue; }
    if (!fence && /^### /.test(line)) skipH3 = /^### ✅/.test(line);
    if (!skipH2 && !skipH3) body.push(line);
  }
  const text = body.join('\n');
  for (const code of codes) {
    if (new RegExp(`(?<![\\w-])${escapeRegExp(code)}(?![\\w-])`).test(text)) owned.add(code);
  }
  return owned;
}

function parseArgs(argv) {
  const out = { code: null, note: '', write: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--prune') out.prune = true;
    else if (a === '--note') out.note = argv[++i] ?? '';
    else if (!a.startsWith('--') && !out.code) out.code = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root, config } = loadConfig(process.cwd());
  const dirName = config.handoff?.dir || 'handoffs';
  const dir = path.resolve(root, dirName);

  if (args.prune) {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
    const codes = names.map((f) => f.slice(0, -3));
    const coord = path.resolve(root, config.coordination?.file || 'coordination.md');
    const owned = ownedCodes(fs.existsSync(coord) ? fs.readFileSync(coord, 'utf8') : '', codes);
    const orphans = codes.filter((c) => !owned.has(c));
    if (!orphans.length) { console.log('handoff: no orphaned packets.'); return 0; }
    for (const c of orphans) {
      if (args.write) fs.rmSync(path.join(dir, `${c}.md`), { force: true });
      console.log(`${args.write ? 'deleted' : 'orphaned'}: ${dirName}/${c}.md`);
    }
    if (!args.write) console.log('  to delete: node scripts/handoff-packet.mjs --prune --write');
    return 0;
  }

  if (!args.code || !CODE_RE.test(args.code)) {
    console.error('usage: node scripts/handoff-packet.mjs <item-code> [--write] [--note "<text>"] | --prune [--write]');
    return 1;
  }
  const generatedAt = args.write ? (process.env.HANDOFF_NOW || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) : null;
  const text = buildPacket({ root, config, code: args.code, note: args.note, generatedAt });
  if (!args.write) { process.stdout.write(text); return 0; }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${args.code}.md`);
  fs.writeFileSync(file, text);
  console.log(`handoff: ${dirName}/${args.code}.md (${bytes(text)} bytes) -- commit it and name it in the coordination note for ${args.code}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { console.error(`handoff-packet: ${e.message}`); process.exitCode = 1; }
}
