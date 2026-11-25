// Builds the list of files an install or upgrade wants in a project: { rel, cls, content }.
// core/ files are copied as they are, core/templates/ files are filled from the config,
// and a few small seed files (archives, config) are generated.
import fs from 'node:fs';
import path from 'node:path';
import { CORE, deepMerge, fill, fromPosix, walkFiles } from './util.mjs';
import { classify } from './classes.mjs';
import { DEFAULTS } from '../../core/scripts/lib/config.mjs';

export const CONFIG_REL = 'agent-scaffold.config.json';
export const EXAMPLE_CONFIG_REL = 'agent-scaffold.config.example.json';
/** package path -> project path, for the merge-class files whose project name differs. */
const MERGE_TARGET = { 'templates/gitignore.snippet': '.gitignore' };

/** Config as the hooks will see it: package defaults under the project file. */
export const mergedConfig = (raw) => deepMerge(DEFAULTS, raw ?? {});

const coreBytes = (rel) => fs.readFileSync(path.join(CORE, fromPosix(rel)));

function repoPaths(config) {
  const seen = new Set();
  const out = [];
  for (const r of config.repos ?? []) {
    const p = (r.path ?? '.').split('/').filter((s) => s && s !== '.').join('/');
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ name: r.name ?? (p || 'app'), path: p });
  }
  return out;
}

/** Placeholder values for the templates. Every key the templates use must be here (fill() throws otherwise). */
export function fillMap(config, extra = {}) {
  const multi = config.layout === 'multi';
  return {
    PROJECT_NAME: String(config.projectName),
    BOARD_FILE: config.board.file,
    BOARD_ARCHIVE: config.board.archive,
    BOARD_CEILING: String(config.board.ceiling),
    COORDINATION_FILE: config.coordination.file,
    COORDINATION_ARCHIVE: config.coordination.archive,
    COORDINATION_CEILING: String(config.coordination.ceiling),
    MEMORY_BANK_DIR: config.memoryBank.dir,
    REPORTS_DIR: config.docs.reports,
    SPECS_DIR: config.docs.specs,
    HUMAN_GATEKEEPER: config.humanGatekeeper,
    HUMAN_TAG: (config.humans ?? ['OWNER'])[0],
    HUMAN_STEP_WEEKS: String(config.board.humanStepExpiryWeeks),
    LABEL_HUMAN_ONLY: config.labels.humanOnly,
    LABEL_ANYONE: config.labels.anyone,
    MULTI_REPO_PULL_NOTE: multi ? ' and in every repo listed in the config' : '',
    PROSE_LANGUAGE: String(config.language),
    REPO_NAME: String(config.projectName),
    ROOT_RELATIVE: '',
    ...extra,
  };
}

const text = (rel, map) => Buffer.from(fill(coreBytes(rel).toString('utf8'), map));

/**
 * All wanted files for this config. `configBytes` is the exact content the project's config file
 * has (or will have): it is a seed entry like any other.
 */
export function buildEntries(config, configBytes) {
  const map = fillMap(config);
  const multi = config.layout === 'multi';
  const repos = repoPaths(config);
  const entries = [];
  const add = (rel, cls, content) => entries.push({ rel, cls, content });

  for (const rel of walkFiles(CORE)) {
    if (rel === EXAMPLE_CONFIG_REL) continue;
    if (rel.startsWith('templates/') && rel !== 'templates/gitignore.snippet') continue;
    const cls = classify(rel);
    if (!cls) throw new Error(`core/${rel} has no class in bin/file-classes.json`);
    add(MERGE_TARGET[rel] ?? rel, cls, coreBytes(rel));
  }

  add(CONFIG_REL, 'seed', configBytes);
  add('CLAUDE.md', 'seed', text('templates/CLAUDE.md.tmpl', map));
  add('GEMINI.md', 'seed', text('templates/GEMINI.md.tmpl', map));
  add(config.board.file, 'seed', text('templates/task-board.md.tmpl', map));
  add(config.board.archive, 'seed', Buffer.from('# Task board archive\n'));
  add(config.coordination.file, 'seed', text('templates/coordination.md.tmpl', map));
  add(config.coordination.archive, 'seed', Buffer.from('# Coordination archive\n'));
  add(`${config.docs.reports}/README.md`, 'seed', text('templates/reports/README.md', map));
  add(`${config.docs.specs}/README.md`, 'seed', text('templates/specs/README.md', map));

  // AGENTS.md: at the root, plus one per repo in a multi layout.
  add('AGENTS.md', 'seed', text('templates/AGENTS.md.tmpl', map));
  if (multi) {
    for (const repo of repos) {
      if (!repo.path) continue;
      const depth = repo.path.split('/').length;
      add(`${repo.path}/AGENTS.md`, 'seed', text('templates/AGENTS.md.tmpl', fillMap(config, { REPO_NAME: repo.name, ROOT_RELATIVE: '../'.repeat(depth) })));
    }
  }

  // Memory bank: one per repo in a multi layout, one at the bank dir otherwise.
  const bankRoots = multi ? repos.map((r) => (r.path ? `${r.path}/${config.memoryBank.dir}` : config.memoryBank.dir)) : [config.memoryBank.dir];
  const bankFiles = walkFiles(path.join(CORE, 'templates', 'memory-bank'));
  for (const bank of [...new Set(bankRoots)]) {
    for (const f of bankFiles) add(`${bank}/${f}`, 'seed', coreBytes(`templates/memory-bank/${f}`));
    add(`${bank}/archive/.gitkeep`, 'seed', Buffer.alloc(0));
  }

  // The same project path can be produced twice (for example two repos sharing a bank): last write wins is wrong, keep the first.
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.rel) ? false : (seen.add(e.rel), true)));
}
