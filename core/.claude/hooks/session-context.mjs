#!/usr/bin/env node
// SessionStart hook — injects a short per-session working note.
// Runs under both Claude Code (.claude) and Codex (.codex/hooks.json) so the
// coordination file becomes an async message channel both agents see every
// session.
//
// Fully config-driven: see scripts/lib/config.mjs and
// agent-scaffold.config.example.json for every parameter used below. If this
// project has not installed the scaffold (no agent-scaffold.config.json
// found), the hook FAILS OPEN — exits 0 with no output — so it never
// interferes with a project that hasn't opted in.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';

const execFileP = promisify(execFile);

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {}

const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { root, config, found } = loadConfig(startDir);
if (!found) process.exit(0); // scaffold not installed here — stay silent

// Main-session registration for read-guard's subagent exemption. SessionStart
// only runs for real sessions (never for Task/Agent subagents) — so a
// session_id NOT in mains.txt means "subagent" and the guard leaves it alone.
const sessionId = String(input.session_id || '').replace(/[^\w-]/g, '').slice(0, 64);
if (sessionId) {
  try {
    const rgDir = path.join(root, '.claude', '.read-guard');
    mkdirSync(rgDir, { recursive: true });
    const mainsFile = path.join(rgDir, 'mains.txt');
    let mains = [];
    try {
      mains = readFileSync(mainsFile, 'utf8').split('\n').filter(Boolean);
    } catch {}
    const now = Date.now();
    mains = mains.filter(
      (l) => now - (parseInt(l.split(' ')[1], 10) || 0) < 3 * 86_400_000 && l.split(' ')[0] !== sessionId,
    );
    mains.push(`${sessionId} ${now}`);
    writeFileSync(mainsFile, mains.join('\n') + '\n');
  } catch {}
}

let pullLine = '';
let freshnessLine = '';
let coordinationLine = '';
let boardLine = '';

try {
  // 0) Auto-pull — fast-forward ONLY (never produces a merge/conflict; a
  // dirty tree just makes git abort cleanly). Runs before the board/
  // coordination lines are checked so they are read fresh.
  if (config.session.autoPull) {
    try {
      const out = execSync('git pull --ff-only', {
        encoding: 'utf8',
        timeout: 20000,
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      pullLine = /already up to date/i.test(out)
        ? '0) Repo up to date (pull: already up to date).'
        : `0) Repo UPDATED (pull --ff-only): ${(out.split('\n').pop() || '').slice(0, 100)}`;
    } catch (e) {
      const why = String(e?.stderr || e?.message || '').split('\n')[0].slice(0, 120);
      pullLine = `0) WARNING: git pull FAILED (${why}) — board/coordination files may be STALE; run \`git pull --ff-only\` by hand when convenient.`;
    }
  }

  // 0b) Submodule freshness — REPORT ONLY, never auto-pulls (pulling a
  // submodule out from under another agent's checkout is not this hook's
  // call). Only meaningful for a multi-repo layout. 5-minute cache so
  // back-to-back session starts don't repeat the same fetches.
  if (config.layout === 'multi' && existsSync(path.join(root, '.gitmodules'))) {
    try {
      const cacheFile = path.join(root, '.claude', '.submodule-freshness-cache.json');
      let cached = null;
      try {
        cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      } catch {}
      if (cached && Date.now() - cached.ts < 5 * 60_000 && typeof cached.line === 'string') {
        freshnessLine = `${cached.line} [cached <5min]`;
      } else {
        const status = execSync('git submodule status', { encoding: 'utf8', cwd: root, timeout: 15000 });
        const subs = status
          .split('\n')
          .filter(Boolean)
          .map((l) => ({ mark: l[0], path: l.slice(1).trim().split(' ')[1] }))
          .filter((s) => s.path && s.mark !== '-');
        let fetchErrors = 0;
        const results = await Promise.all(
          subs.map(async (s) => {
            const dir = path.join(root, s.path);
            const notes = [];
            if (s.mark === '+') notes.push('checkout != umbrella pointer (may be in-flight work / pending bump)');
            try {
              const branch = (
                await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
              ).stdout.trim();
              if (branch !== 'HEAD') {
                await execFileP('git', ['fetch', '--quiet', 'origin', branch], { cwd: dir, timeout: 9000 });
                const behind =
                  parseInt(
                    (
                      await execFileP('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: dir })
                    ).stdout.trim(),
                    10,
                  ) || 0;
                if (behind > 0) notes.push(`${behind} commit(s) BEHIND origin/${branch}`);
              }
            } catch {
              fetchErrors++;
            }
            return notes.length ? `${s.path}: ${notes.join('; ')}` : null;
          }),
        );
        const issues = results.filter(Boolean);
        if (fetchErrors === subs.length && subs.length) {
          freshnessLine =
            '0b) WARNING: submodule freshness check FAILED (all fetches failed — network/SSH?); repos may be behind, ' +
            'run `git fetch` + `git status` by hand in the one you are about to work in.';
        } else if (issues.length) {
          freshnessLine =
            `0b) NOTE — behind/mismatched repos: ${issues.join(' | ')}. ` +
            'If the one you are about to work in is behind, `git pull --ff-only` there before starting ' +
            '(coordinate first if the tree is dirty or another agent has a claim on it — do not blind-pull).' +
            (fetchErrors ? ` (${fetchErrors} repo(s) could not be fetched, unverified)` : '');
        } else {
          freshnessLine =
            '0b) Submodule freshness: all up to date.' +
            (fetchErrors ? ` (${fetchErrors} repo(s) could not be fetched, unverified)` : '');
        }
        try {
          writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), line: freshnessLine }));
        } catch {}
      }
    } catch (e) {
      freshnessLine = `0b) WARNING: submodule freshness check errored (${String(e?.message || '')
        .split('\n')[0]
        .slice(0, 80)}); repos may be behind.`;
    }
  }

  if (existsSync(path.join(root, config.coordination.file))) {
    coordinationLine =
      `5) READ ${config.coordination.file} (it carries only OPEN claims/messages). Write a claim before starting work, ` +
      'flip it to DONE when finished, and move the closed message to its archive file in the SAME commit. ' +
      'The full protocol lives in that file. For time-critical live coordination between agents on the same machine, ' +
      'use the live-agent messaging tools if available; that channel leaves NO record, so persist any outcome to the ' +
      'coordination file right away.';
  }

  if (existsSync(path.join(root, config.board.file))) {
    boardLine =
      `6) TASK BOARD: ${config.board.file} — work is picked from there first. Claim the item you are working on; ` +
      'when done, write the evidence into that item and update its heading line too (body and heading can go stale ' +
      'independently). If important work has no matching item, add one before starting.';
  }
} catch {
  // no git here — these notes are best-effort, not required
}

let sizeLine = '';
try {
  sizeLine = execSync('node scripts/md-size-watch.mjs --line', {
    encoding: 'utf8',
    cwd: root,
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {}

const skillList = (config.session.skills || []).map((s) => `/${s}`).join(', ');
const subs = config.delegation.subagents || {};

const note = [
  `${config.projectName || 'Project'} session note:`,
  ...(sizeLine ? [`0c) ${sizeLine}`] : []),
  ...(pullLine ? [pullLine] : []),
  ...(freshnessLine ? [freshnessLine] : []),
  `1) Before starting non-trivial work, read the ${config.memoryBank.dir}/ directory of the repo you are working in ` +
    '(especially repoMap.md + activeContext.md).',
  `2) When meaningful work is done, update ${config.memoryBank.dir}/activeContext.md + progress.md in that repo. If you ` +
    `added a new source file, record it in ${config.memoryBank.dir}/repoMap.md (the push gate rejects a push whose new ` +
    'files cannot be found there). Before writing a shared piece (component/helper), check ' +
    `${config.memoryBank.dir}/reuse-registry.json — do not re-write a registered canonical piece.`,
  ...(skillList
    ? [
        `3) Use the project's skills for repeated rituals: ${skillList}. If the same procedure is being carried out a ` +
          "3rd time (2nd if the first run cost a trap), turn it into a skill instead of repeating it from memory.",
      ]
    : []),
  `4) Work delegation-first: the main model is the ARCHITECT. Multi-file exploration/reading -> '${subs.scout || 'scout'}'; ` +
    `well-specified mechanical edits -> '${subs.worker || 'worker'}'; gate/test runs -> '${subs.verifier || 'verifier'}'. ` +
    'Do not read file after file in the main context yourself — hand off and get a decision-ready summary back.',
  ...(coordinationLine ? [coordinationLine] : []),
  ...(boardLine ? [boardLine] : []),
  `7) Durable syntheses go to ${config.docs.reports}/, implementation specs go to ${config.docs.specs}/ — search both ` +
    'BEFORE re-exploring (closed items usually move to an archive subfolder).',
  `Full working rules: ${config.docs.workingRules}.`,
].join('\n');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
  }),
);
