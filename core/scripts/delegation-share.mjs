#!/usr/bin/env node
// Enforces: R-01 (measurement tool - it reports, it never blocks)
//
// Delegation share: what fraction of all tool calls does the MAIN session make, versus its
// subagents? The idea behind the rule: the main session is the expensive one (largest model,
// largest context re-read on every call), so its share of tool calls should stay LOW - it
// decides, workers do the grunt work. This script measures that share and the main session's
// shell/read distribution, and compares the share to a target band.
//
// WHAT IT DOES: scans Claude Code transcripts (~/.claude/projects/<slug>/*.jsonl) plus each
// session's subagent transcripts (<session>/subagents/*.jsonl), and prints main/sub tool-call
// counts, the main share, the share of "worker-type" tools (Read/Edit/Write/Grep/Glob/Bash)
// inside the main session, output tokens, big sessions that never delegated, and the main
// session's shell-command distribution.
//
// SCOPE: works ONLY with Claude Code and depends on its transcript layout, which is not a
// documented, stable API. If the layout changes the numbers will read zero, not wrong.
//
// USAGE:
//   node scripts/delegation-share.mjs [--days 14] [--target 20-25] [--dir <transcript-dir>]
//   --days N        look at transcripts modified in the last N days (default 14)
//   --target A-B    target band for the main share, in percent (default 20-25)
//   --dir PATH      read this transcript directory instead of ~/.claude/projects/<slug>
//   --help          print this text
// The project slug is derived from the project root (the directory holding
// agent-scaffold.config.json) by replacing every non-alphanumeric character with "-".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const DEFAULT_DAYS = 14;
export const DEFAULT_TARGET = [20, 25];
const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'PowerShell'];

/** @param {string[]} argv */
export function parseArgs(argv) {
  let days = DEFAULT_DAYS;
  let dir = null;
  let target = DEFAULT_TARGET;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') {
      days = Number(argv[++i]);
      if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    } else if (a === '--dir') {
      dir = argv[++i] ?? null;
    } else if (a === '--target') {
      const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(argv[++i] ?? ''));
      if (m && Number(m[1]) <= Number(m[2])) target = [Number(m[1]), Number(m[2])];
    } else if (a === '--help' || a === '-h') {
      help = true;
    }
  }
  return { days, dir, target, help };
}

/** Project root path -> the directory name Claude Code uses under ~/.claude/projects. */
export function slugFor(projectRoot) {
  return String(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}

/** Classify one shell command into a coarse category. */
export function shellClass(raw) {
  const c = String(raw).replace(/^\s*cd\s+[^;&]+(&&|;)\s*/, '').trim();
  if (/^(git|gh)\b/.test(c)) {
    if (/\b(commit|push|add|rebase|fetch|pull|mv|rm)\b/.test(c)) return 'git-write';
    return 'git-read';
  }
  if (/^ssh\b|^scp\b/.test(c)) return 'remote';
  if (/^(grep|rg|cat|head|tail|sed -n|ls|find|wc|awk)\b/.test(c)) return 'read/search';
  if (/^sed -i|^perl -pi|> *[\w/.]/.test(c) && !/^node/.test(c)) return 'file-write';
  if (/^(npm|npx|pnpm|yarn)\b|--test|tsc|playwright|py_compile|pytest/.test(c)) return 'test/gate';
  if (/^node\b|^python/.test(c)) return 'script';
  if (/^curl\b/.test(c)) return 'curl';
  if (/mysql|psql/.test(c)) return 'db';
  return 'other';
}

function emptyCounter() {
  return { tools: 0, byName: {}, models: {}, outTok: 0, shell: {} };
}

function merge(a, b) {
  for (const [k, v] of Object.entries(b.byName)) a.byName[k] = (a.byName[k] || 0) + v;
  for (const [k, v] of Object.entries(b.models)) a.models[k] = (a.models[k] || 0) + v;
  for (const [k, v] of Object.entries(b.shell)) a.shell[k] = (a.shell[k] || 0) + v;
  a.tools += b.tools;
  a.outTok += b.outTok;
}

/** "name -> count" object as one line, descending, with percentages. */
export function shareList(obj) {
  const total = Object.values(obj).reduce((t, v) => t + v, 0);
  if (!total) return '-';
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} (${((100 * v) / total).toFixed(0)}%)`)
    .join(', ');
}

/** { type: { count, tokens } } -> "type count / tokens / tokens-per-agent", highest per-agent first. */
export function typeDetailList(obj) {
  const rows = Object.entries(obj).filter(([, v]) => v.count > 0);
  if (!rows.length) return '-';
  return rows
    .map(([k, v]) => [k, v.count, v.tokens, Math.round(v.tokens / v.count)])
    .sort((a, b) => b[3] - a[3])
    .map(([k, count, tokens, avg]) => `${k} ${count} / ${tokens} / ${avg}`)
    .join(', ');
}

/** Count one transcript's TEXT (jsonl content). Pure: no file access. */
export function countTranscript(text) {
  const r = emptyCounter();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    const m = o.message.model;
    if (m) r.models[m] = (r.models[m] || 0) + 1;
    r.outTok += o.message.usage?.output_tokens || 0;
    for (const c of o.message.content || []) {
      if (c.type !== 'tool_use') continue;
      r.tools++;
      r.byName[c.name] = (r.byName[c.name] || 0) + 1;
      if (c.name === 'Bash') {
        const k = shellClass(String(c.input?.command || ''));
        r.shell[k] = (r.shell[k] || 0) + 1;
      }
    }
  }
  return r;
}

/** Scan `dir` (sessions modified in the last `days` days) plus each session's subagent files. */
export function scanDir(dir, days) {
  const cutoff = Date.now() - days * 864e5;
  const main = emptyCounter();
  const sub = emptyCounter();
  const types = {};
  const typeDetail = {};
  const sessions = [];
  let sessionCount = 0;
  let subCount = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { sessionCount, subCount, main, sub, sessions, types, typeDetail };
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    sessionCount++;
    const a = countTranscript(fs.readFileSync(p, 'utf8'));
    merge(main, a);

    const sd = path.join(dir, f.replace(/\.jsonl$/, ''), 'subagents');
    const s = emptyCounter();
    let n = 0;
    if (fs.existsSync(sd)) {
      for (const g of fs.readdirSync(sd)) {
        if (!g.endsWith('.jsonl')) continue;
        n++;
        const one = countTranscript(fs.readFileSync(path.join(sd, g), 'utf8'));
        merge(s, one);
        // Each agent-*.jsonl has a sibling <name>.meta.json like {"agentType":"worker",...}.
        let type = 'unknown';
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(sd, g.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
          if (meta && typeof meta.agentType === 'string' && meta.agentType) type = meta.agentType;
        } catch {
          // missing or broken meta file: stays 'unknown'
        }
        types[type] = (types[type] || 0) + one.tools;
        if (!typeDetail[type]) typeDetail[type] = { count: 0, tokens: 0 };
        typeDetail[type].count += 1;
        typeDetail[type].tokens += one.outTok;
      }
    }
    subCount += n;
    merge(sub, s);
    sessions.push({ file: f.slice(0, 8), main: a.tools, sub: s.tools, n });
  }
  return { sessionCount, subCount, main, sub, sessions, types, typeDetail };
}

/** Build the report lines. `target` is [min, max] in percent. */
export function buildReport({ days, sessionCount, subCount, main, sub, sessions, types = {}, typeDetail = {}, target = DEFAULT_TARGET }) {
  const total = main.tools + sub.tools;
  const share = total ? +((100 * main.tools) / total).toFixed(1) : 0;
  const mainWorker = WORKER_TOOLS.reduce((t, k) => t + (main.byName[k] || 0), 0);
  const mainWorkerShare = main.tools ? +((100 * mainWorker) / main.tools).toFixed(1) : 0;
  const big = sessions.filter((o) => o.main >= 50);
  const neverDelegated = big.filter((o) => o.n === 0).length;
  const shellTotal = Object.values(main.shell).reduce((t, v) => t + v, 0);
  const shellDist =
    Object.entries(main.shell)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}${shellTotal ? ` (${((100 * v) / shellTotal).toFixed(0)}%)` : ''}`)
      .join(', ') || '-';
  const [lo, hi] = target;
  const verdict = !total ? 'no data' : share > hi ? 'ABOVE target: the main session does too much itself' : share < lo ? 'below target' : 'within target';
  return [
    `Last ${days} days - sessions: ${sessionCount}, subagents: ${subCount}`,
    `Main tool calls: ${main.tools}, subagent tool calls: ${sub.tools}`,
    `MAIN SHARE: ${share}% (${verdict})`,
    `Worker-type tools (Read/Edit/Write/Grep/Glob/Bash/PowerShell) share inside the main session: ${mainWorkerShare}%`,
    `Output tokens - main: ${main.outTok}, subagents: ${sub.outTok}`,
    `Sessions with >=50 main tool calls and NO subagent: ${neverDelegated} / ${big.length}`,
    `Main-session shell distribution (${shellTotal} calls): ${shellDist}`,
    `Main-session models: ${shareList(main.models)}`,
    `Subagent models: ${shareList(sub.models)}`,
    `Subagent types (tool calls): ${shareList(types)}`,
    `Per subagent type (count / output tokens / tokens per agent): ${typeDetailList(typeDetail)}`,
    `TARGET BAND: ${lo}-${hi}% (decisions, commits and deploys stay with the main session; reads, edits and test runs go to workers)`,
  ];
}

const HELP = `Delegation share - Claude Code only; depends on the transcript layout (not a stable API).
Usage: node scripts/delegation-share.mjs [--days 14] [--target 20-25] [--dir <transcript-dir>]
  --days N       transcripts modified in the last N days (default ${DEFAULT_DAYS})
  --target A-B   target band for the main session's tool-call share, percent (default ${DEFAULT_TARGET.join('-')})
  --dir PATH     transcript directory (default ~/.claude/projects/<slug of the project root>)
Idea: the main session is the expensive one, so its share of all tool calls should stay low.`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const { root } = loadConfig(process.cwd());
  const dir = args.dir || path.join(os.homedir(), '.claude', 'projects', slugFor(root));
  const summary = scanDir(dir, args.days);
  for (const line of buildReport({ days: args.days, target: args.target, ...summary })) console.log(line);
}

if (isMainModule(import.meta.url)) main();
