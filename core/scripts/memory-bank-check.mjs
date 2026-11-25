#!/usr/bin/env node
// Enforces: R-21
/**
 * memory-bank-check — verifies every configured repo's memory bank against the schema.
 *
 * WHY: the memory-bank guide lists what each file must contain, but prose rules drift. This
 * script turns the checkable part (file exists, required headings present, dated entries,
 * a populated "start here" table, no leftover template placeholders) into a command.
 *
 * SCHEMA: `config.docs.memoryBankSchema` (default `docs/memory-bank-schema.json`), relative to
 * the project root. Each required heading is a case-insensitive regex matched against the text
 * of every markdown heading (levels 1-6, code fences ignored) in the file.
 *
 * WHAT IT CHECKS, per repo in config.repos[] (directory: <repo.path>/<config.memoryBank.dir>):
 *   - each schema file exists
 *   - each required heading has at least one matching heading
 *   - structure.datedEntries: enough level-N headings starting with an ISO date
 *   - structure.table: the table after a heading has at least minRows data rows
 *   - no unfilled template placeholder (`{{` or `<!-- fill:`) is left in the file
 *
 * USAGE:
 *   node scripts/memory-bank-check.mjs              # table of findings for every repo (exit 1 if any)
 *   node scripts/memory-bank-check.mjs <repo-dir>   # one repo: configured name/path, or a directory
 *   node scripts/memory-bank-check.mjs --line       # one-line summary for hooks; silent when clean; exit 0
 *
 * Fail-open: without a config or schema it prints a note (not in --line mode) and exits 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

const DEFAULT_SCHEMA = 'docs/memory-bank-schema.json';
const PLACEHOLDER = /\{\{|<!--\s*fill:/;

/** Markdown headings outside code fences: [{ level, text }]. */
export function parseHeadings(content) {
  const out = [];
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

/** Data rows (excluding header and separator) of the first table after the heading matching `afterHeading`. */
export function countTableRows(content, afterHeading) {
  const re = new RegExp(afterHeading, 'i');
  const lines = content.split(/\r?\n/);
  let i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && re.test(l));
  if (i < 0) return 0;
  let rows = 0;
  let inTable = false;
  for (i += 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^#{1,6}\s/.test(l)) break;
    if (l.startsWith('|')) {
      inTable = true;
      if (!/^\|[\s:|-]+\|?$/.test(l)) rows++;
    } else if (inTable && l !== '') break;
  }
  return Math.max(0, rows - 1); // first non-separator row is the header
}

/** Findings for one file's content: [{ kind, detail }]. */
export function checkContent(content, spec) {
  const findings = [];
  const headings = parseHeadings(content);
  for (const req of spec.requiredHeadings ?? []) {
    const re = new RegExp(req.match, 'i');
    if (!headings.some((h) => re.test(h.text))) {
      findings.push({ kind: 'missing-heading', detail: req.topic });
    }
  }
  const dated = spec.structure?.datedEntries;
  if (dated) {
    const re = new RegExp(dated.pattern);
    const n = headings.filter((h) => h.level === (dated.level ?? 2) && re.test(h.text)).length;
    if (n < (dated.min ?? 1)) findings.push({ kind: 'no-dated-entry', detail: `needs ${dated.min ?? 1} dated "## YYYY-MM-DD" entr${(dated.min ?? 1) === 1 ? 'y' : 'ies'}` });
  }
  const table = spec.structure?.table;
  if (table) {
    const rows = countTableRows(content, table.afterHeading);
    if (rows < (table.minRows ?? 1)) findings.push({ kind: 'table-rows', detail: `table after "${table.afterHeading}" has ${rows} row(s), needs ${table.minRows ?? 1}` });
  }
  if (PLACEHOLDER.test(content)) findings.push({ kind: 'placeholder', detail: 'unfilled template placeholder left in file' });
  return findings;
}

/** Findings for one memory-bank directory: [{ file, kind, detail }]. */
export function checkDir(mbDir, schema) {
  const out = [];
  for (const [file, spec] of Object.entries(schema.files ?? {})) {
    const p = path.join(mbDir, file);
    if (!fs.existsSync(p)) { out.push({ file, kind: 'missing-file', detail: 'file does not exist' }); continue; }
    for (const f of checkContent(fs.readFileSync(p, 'utf8'), spec)) out.push({ file, ...f });
  }
  return out;
}

/** Resolve CLI target to [{ name, dir }] using config repos, falling back to a plain directory. */
export function resolveTargets(root, config, target, cwd = process.cwd()) {
  const mb = config.memoryBank?.dir ?? 'memory-bank';
  const repos = (config.repos ?? []).map((r) => ({ name: r.name ?? r.path, dir: path.resolve(root, r.path || '.', mb), path: r.path }));
  if (!target) return repos;
  const hit = repos.find((r) => r.name === target || path.resolve(root, r.path || '.') === path.resolve(cwd, target));
  if (hit) return [hit];
  const abs = path.resolve(cwd, target);
  const dir = fs.existsSync(path.join(abs, mb)) ? path.join(abs, mb) : abs;
  return [{ name: target, dir }];
}

export function loadSchema(root, config) {
  const rel = config.docs?.memoryBankSchema ?? DEFAULT_SCHEMA;
  const p = path.resolve(root, rel);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function formatLine(results) {
  const bad = results.filter((r) => r.findings.length);
  if (!bad.length) return '';
  const total = bad.reduce((n, r) => n + r.findings.length, 0);
  const first = bad[0].findings[0];
  return `memory bank: ${total} finding(s) in ${bad.length} repo(s) (e.g. ${bad[0].name}/${first.file}: ${first.kind}) - run node scripts/memory-bank-check.mjs`;
}

function main() {
  const args = process.argv.slice(2);
  const line = args.includes('--line');
  const target = args.find((a) => !a.startsWith('--'));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const { root, config, found } = loadConfig(scriptDir);
  const note = (m) => { if (!line) console.log(m); };
  if (!found) { note('[agent-scaffold] agent-scaffold.config.json not found; memory-bank-check has nothing to check (fail-open).'); return; }
  const schema = loadSchema(root, config);
  if (!schema) { note('[agent-scaffold] memory-bank schema not readable; skipping (fail-open).'); return; }

  const results = resolveTargets(root, config, target).map((t) => ({ name: t.name, findings: checkDir(t.dir, schema) }));
  if (line) { const s = formatLine(results); if (s) console.log(s); return; }

  let missing = 0;
  for (const r of results) {
    if (!r.findings.length) { console.log(`${r.name}: OK`); continue; }
    console.log(`${r.name}: ${r.findings.length} finding(s)`);
    for (const f of r.findings) console.log(`  ${f.file.padEnd(24)} ${f.kind.padEnd(16)} ${f.detail}`);
    missing += r.findings.length;
  }
  if (missing) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[agent-scaffold] memory-bank-check failed: ${e.message}`); }
}
