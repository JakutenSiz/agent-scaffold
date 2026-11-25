#!/usr/bin/env node
// Enforces: R-70
/**
 * rule-inventory — which written rule is enforced by code, and which is advice only.
 *
 * Why: a review of one project's rulebook found that most of its written rules were
 * advice ("do Y when the work is done") and that exactly those were the ones not
 * followed. Rules that must hold are moved to a deterministic moment (session start,
 * commit, push). This script makes the split visible so a new rule cannot quietly stay
 * advice.
 *
 * How it reads:
 *   - Rule sources: the working rules, CLAUDE.md, the memory-bank guide, the task board
 *     and the coordination file. A rule is a line carrying an id in brackets: [R-12].
 *     The first line that carries an id defines it. Projects may add their own series
 *     with another capital letter ([P-01]).
 *   - Enforcers: files under .claude/hooks, scripts and .githooks whose first lines
 *     contain "Enforces: R-01, R-02".
 *
 * Honest limit: "a file cites the id" is a pointer, not proof that the rule is really
 * enforced. Read the enforcer before trusting the word "enforced".
 *
 * Usage:
 *   node scripts/rule-inventory.mjs            # table
 *   node scripts/rule-inventory.mjs --json     # machine-readable
 *   node scripts/rule-inventory.mjs --line     # one line, only when something is wrong
 *   node scripts/rule-inventory.mjs --strict   # exit 1 on unknown or duplicate ids
 *   node scripts/rule-inventory.mjs --root <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

const ID = '[A-Z]-[0-9]{2,3}';
const DEFINITION_RE = new RegExp('\\[(' + ID + ')\\]', 'g');
const ENFORCES_RE = new RegExp('Enforces:\\s*((?:' + ID + ')(?:\\s*,\\s*(?:' + ID + '))*)');
const HEADER_LINES = 20;
const ENFORCER_DIRS = ['.claude/hooks', 'scripts', '.githooks'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Rule definitions in one document: [{ id, text, line }]. Fenced code is ignored. */
export function rulesIn(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const m of raw.matchAll(DEFINITION_RE)) {
      const rest = raw.slice(m.index + m[0].length).replace(/[*_`]/g, '').trim();
      out.push({ id: m[1], text: rest.slice(0, 90), line: i + 1 });
    }
  });
  return out;
}

/** Ids a code file says it enforces (header lines only). */
export function enforcedBy(text) {
  const head = text.split('\n').slice(0, HEADER_LINES).join('\n');
  const m = head.match(ENFORCES_RE);
  return m ? m[1].split(',').map((s) => s.trim()) : [];
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function ruleSources(root, config) {
  const mb = config.memoryBank?.dir ?? 'memory-bank';
  const list = [
    config.docs?.workingRules, 'CLAUDE.md', 'AGENTS.md', config.docs?.memoryBankGuide,
    config.docs?.toolTraps, config.board?.file, config.coordination?.file,
  ];
  for (const r of config.repos ?? []) list.push(path.join(r.path || '.', mb, 'systemPatterns.md'));
  return [...new Set(list.filter(Boolean))].filter((f) => fs.existsSync(path.join(root, f)));
}

export function inventory(root, config) {
  const rules = new Map();
  const duplicates = [];
  for (const file of ruleSources(root, config)) {
    for (const r of rulesIn(fs.readFileSync(path.join(root, file), 'utf8'))) {
      if (!rules.has(r.id)) rules.set(r.id, { id: r.id, text: r.text, source: `${file}:${r.line}`, enforcers: [] });
      else if (rules.get(r.id).source.split(':')[0] !== file) duplicates.push({ id: r.id, first: rules.get(r.id).source, again: `${file}:${r.line}` });
    }
  }
  const unknown = [];
  for (const dir of ENFORCER_DIRS) {
    for (const full of walk(path.join(root, dir))) {
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      for (const id of enforcedBy(text)) {
        if (rules.has(id)) rules.get(id).enforcers.push(rel);
        else unknown.push({ id, file: rel });
      }
    }
  }
  const all = [...rules.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { rules: all, advice: all.filter((r) => r.enforcers.length === 0), unknown, duplicates };
}

export function summaryLine(inv) {
  const problems = [];
  if (inv.unknown.length) problems.push(`${inv.unknown.length} id(s) cited by code but defined nowhere`);
  if (inv.duplicates.length) problems.push(`${inv.duplicates.length} id(s) defined in two files`);
  return problems.length ? `rules: ${problems.join(', ')} → node scripts/rule-inventory.mjs` : '';
}

export function table(inv) {
  const lines = [`Rule inventory — ${inv.rules.length} rules: ${inv.rules.length - inv.advice.length} cited by an enforcer, ${inv.advice.length} advice only`, ''];
  for (const r of inv.rules) {
    const kind = r.enforcers.length ? 'enforced' : 'advice  ';
    lines.push(`${r.id.padEnd(6)} ${kind}  ${r.text}`);
    lines.push(`       ${r.source}${r.enforcers.length ? '  ←  ' + r.enforcers.join(', ') : ''}`);
  }
  if (inv.unknown.length) {
    lines.push('', 'Cited by code but defined in no rule source (deleted rule, or a typo):');
    for (const u of inv.unknown) lines.push(`  ${u.id}  ←  ${u.file}`);
  }
  if (inv.duplicates.length) {
    lines.push('', 'Defined in more than one file (one rule, one home):');
    for (const d of inv.duplicates) lines.push(`  ${d.id}  ${d.first}  and  ${d.again}`);
  }
  lines.push('', 'A cited id is a pointer, not proof: read the enforcer before trusting "enforced".');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
  const { root, config } = loadConfig(rootArg || process.cwd());
  const inv = inventory(root, config);
  if (args.includes('--json')) console.log(JSON.stringify(inv, null, 2));
  else if (args.includes('--line')) { const l = summaryLine(inv); if (l) console.log(l); }
  else console.log(table(inv));
  if (args.includes('--strict') && (inv.unknown.length || inv.duplicates.length)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
