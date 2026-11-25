#!/usr/bin/env node
// Enforces: R-24
/**
 * board-lint - catches task-board rot at commit time.
 *
 * WHY: the usual failure is not the board's size but that whoever finishes an item appends
 * "done" evidence to the body and never flips the `###` heading or the Remaining field, so
 * the item still looks open to every tool and agent that reads the heading first. Advice to
 * "update the heading too" never held; this check runs when the board is committed.
 *
 * Only items CHANGED in the commit are inspected (old text vs new text), so existing debt
 * never blocks a commit; the one whole-file rule is the duplicate-code check.
 *
 * USAGE:
 *   node scripts/board-lint.mjs --staged                 # git HEAD blob <-> index (pre-commit)
 *   node scripts/board-lint.mjs --files <old> <new>      # two files (testing, ad-hoc review)
 *   options: --mode warn|block   --json
 *
 * MODE: config.board.lint.mode (default `warn`). The environment variable named by
 * config.board.lint.escapeEnv (default BOARD_LINT) overrides it: `warn` | `block` | `off`.
 * A --mode flag beats both.
 *
 * EXIT CODES: 0 = clean, or findings in warn mode, or fail-open (no config / no board);
 *             1 = `block` mode and at least one error-level finding;
 *             2 = usage error. Warn-level findings never fail the commit.
 *
 * RULES (field names come from config.board.fields, owner tags from config.humans/labels):
 *   L1 error  a completion line was added to the body but the `###` heading and the
 *             Remaining field are unchanged (side notes and struck-through + done marks exempt)
 *   L2 error  a dated or off-template paragraph was appended to an open item
 *             (replace the old text instead of appending an era; a changed field is not new)
 *   L3 error  the same item code heads more than one `###` item (whole file; `↪ DUPLICATE` exempt)
 *   L4 warn   heading and Remaining disagree: a done/live heading with an owner tag still in
 *             Remaining, or an open/partial heading whose Remaining is empty
 *   L5 warn   the changed item's body is longer than 35 lines (template: 20)
 *   L6 warn   a done item without a Last evidence line containing a commit sha, URL,
 *             "release" or "deploy ok"
 *   L7 warn   a done item that still carries a warning mark or a "do not touch" note
 *   L8 warn   Human step field without a human tag, or Remaining starting with a human tag
 *             while no Human step field exists (the human queue reads only that field)
 *
 * If it stops a commit: (1) a side sentence that merely mentions a done word gets
 * `(side note)`; (2) a struck-through `~~[TAG] step~~` closes a sub-step without a heading
 * change; (3) if the item really finished, update the heading and Remaining in the same edit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { boardFormat, parseItems, duplicateKeys, stripStruck } from './lib/board-format.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const MAX_BODY_LINES = 35;
const DATED_ADDITION = /^\*\*(?:✅ |⚠️ )?(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2})/;
const LABELED = /^\*\*([^*]+):\*\*/;
const SIDE_NOTE = /\(side note\)|side note:/i;
// 7+ hex chars with at least one digit and one letter | URL | release | deploy ok
const EVIDENCE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|http|release|deploy ok/i;
const LEFTOVER = /⚠️|do not touch|don't touch/i;

/** @returns {{rule:string, code:string, message:string, severity:'error'|'warn'}[]} */
export function lintBoard(oldText, newText, fmt) {
  const oldItems = new Map(parseItems(oldText, fmt).map((it) => [it.key, it]));
  const newAll = parseItems(newText, fmt);
  const findings = [];
  const add = (rule, code, message, severity) => findings.push({ rule, code, message, severity });
  const { done, live, open, partial, deferred } = fmt.status;

  for (const key of duplicateKeys(newAll)) {
    add('L3', key, 'the same item code heads more than one `###` item - update the existing item instead of opening a twin', 'error');
  }

  const remainingLine = (it) => it.body.find((l) => fmt.re.remaining.test(l)) ?? '';

  for (const it of newAll) {
    if (it.duplicate) continue;
    const old = oldItems.get(it.key);
    if (old && old.heading === it.heading && old.body.join('\n') === it.body.join('\n')) continue; // unchanged
    const remLine = remainingLine(it);

    if (old) {
      const oldLines = new Set(old.body);
      const added = it.body.filter((l) => !oldLines.has(l));
      // A line whose label already existed was edited, not appended.
      const oldLabels = new Set(old.body.map((l) => l.match(LABELED)?.[1].trim()).filter(Boolean));
      const trulyNew = added.filter((l) => { const m = l.match(LABELED); return !(m && oldLabels.has(m[1].trim())); });
      const countsAsDone = (l) => fmt.doneRe.test(l) && !SIDE_NOTE.test(l) && !(/~~[^~]+~~/.test(l) && l.includes(done));

      if (it.status !== done) {
        for (const l of trulyNew) {
          const m = l.match(LABELED);
          if (DATED_ADDITION.test(l) || (m && !fmt.templateLabels.has(m[1].trim()))) {
            add('L2', it.code, 'dated or off-template paragraph appended - replace the old text, do not append an era (update the Last evidence line)', 'error');
            break;
          }
        }
      }
      if (added.some(countsAsDone) && old.heading === it.heading && remainingLine(old) === remLine) {
        add('L1', it.code, 'a completion line was added to the body but the heading and Remaining are unchanged', 'error');
      }
    }

    const remText = remLine.replace(fmt.re.remaining, '').trim();
    if ((it.status === done || it.status === live) && fmt.ownerRe.test(stripStruck(remText, fmt))) {
      add('L4', it.code, 'heading looks finished but Remaining still carries an owner-tagged step', 'warn');
    } else if ((it.status === open || it.status === partial) && remLine && /^(none\.?)?$/i.test(remText)) {
      add('L4', it.code, 'heading is open but Remaining is empty', 'warn');
    }

    if (it.body.length > MAX_BODY_LINES) add('L5', it.code, `body is ${it.body.length} lines (template 20, threshold ${MAX_BODY_LINES})`, 'warn');

    if (it.status === done) {
      const evidence = it.body.find((l) => fmt.re.lastEvidence.test(l));
      if (!evidence || !EVIDENCE.test(evidence)) add('L6', it.code, 'done item: Last evidence is missing or has no sha / URL / release / deploy ok', 'warn');
      if (it.body.some((l) => LEFTOVER.test(l))) add('L7', it.code, 'done item still carries a warning mark or "do not touch" note - clean it up', 'warn');
    }

    const stepLine = it.body.find((l) => fmt.re.humanStep.test(l));
    if (stepLine && !fmt.humanTagRe.test(stepLine)) {
      add('L8', it.code, 'Human step has no human tag - the human queue ignores untagged lines', 'warn');
    } else if (!stepLine && it.status !== done && it.status !== deferred && fmt.humanStartRe.test(stripStruck(firstRemainingPart(it, fmt), fmt))) {
      add('L8', it.code, 'Remaining starts with a human tag but there is no Human step field - move it there (the human queue reads only that field)', 'warn');
    }
  }
  return findings;
}

/**
 * Codes of items that were closed in this edit: open -> done, or added directly as done.
 * Pure. done -> done, items that left the board (archived) and `live` items are not transitions.
 */
export function doneTransitions(oldText, newText, fmt) {
  const before = new Map(parseItems(oldText, fmt).map((it) => [it.key, it]));
  return parseItems(newText, fmt)
    .filter((it) => !it.duplicate && it.status === fmt.status.done && before.get(it.key)?.status !== fmt.status.done)
    .map((it) => it.code);
}

/** First part of Remaining: the field line, or the next filled line when it is empty; cut at ` · `. */
export function firstRemainingPart(it, fmt) {
  const i = it.body.findIndex((l) => fmt.re.remaining.test(l));
  if (i < 0) return '';
  let text = it.body[i].replace(fmt.re.remaining, '').trim();
  for (let j = i + 1; !text && j < it.body.length && !LABELED.test(it.body[j]); j++) text = it.body[j].trim();
  return text.split(' · ')[0];
}

// ---- CLI ----
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}
const gitOrEmpty = (args, cwd) => { try { return git(args, cwd); } catch { return ''; } };

/** Mode precedence: --mode flag > env var named by config > config > `warn`. */
export function resolveMode(config, flag, env = process.env) {
  const lint = config.board?.lint ?? {};
  const fromEnv = env[lint.escapeEnv ?? 'BOARD_LINT'];
  return flag || fromEnv || lint.mode || 'warn'; // an empty env var counts as unset
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const { root, config, found } = loadConfig(arg('--root') ?? SCRIPT_DIR);
  const mode = resolveMode(config, arg('--mode'));
  if (mode === 'off' || mode === 'skip') return 0;

  let oldText = '';
  let newText = '';
  if (argv.includes('--staged')) {
    if (!found) return 0; // fail-open: scaffold not configured
    const rel = config.board.file.replaceAll('\\', '/');
    oldText = gitOrEmpty(['show', `HEAD:./${rel}`], root);
    newText = gitOrEmpty(['show', `:./${rel}`], root);
    if (!newText) return 0; // board not in the index
  } else if (argv.includes('--files')) {
    const i = argv.indexOf('--files');
    if (!argv[i + 1] || !argv[i + 2]) { console.error('usage: board-lint.mjs --files <old> <new>'); return 2; }
    oldText = fs.readFileSync(path.resolve(argv[i + 1]), 'utf8');
    newText = fs.readFileSync(path.resolve(argv[i + 2]), 'utf8');
  } else {
    console.error('usage: board-lint.mjs [--staged | --files <old> <new>] [--mode warn|block] [--json]');
    return 2;
  }

  const findings = lintBoard(oldText, newText, boardFormat(config));
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  if (argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const f of findings) console.log(`${f.rule} ${f.code}: ${f.message}`);
    if (findings.length) console.log(`board-lint: ${errors} error(s), ${warnings} warning(s) (mode: ${mode})`);
  }
  return mode === 'block' && errors > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`board-lint: ${e.message}\n`); process.exitCode = 0; } // fail-open on internal errors
}
