// End-to-end install trial: core/ is copied into a fresh git project, the templates are filled,
// and the hooks and scripts are exercised the way a real install would use them. Each test
// builds its own project in a temp dir, so the scenarios stay independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core');

/** Replaces {{KEY}} placeholders; any placeholder left unfilled fails the test. */
export function fill(text, map) {
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in map ? map[k] : m));
  const left = out.match(/\{\{[A-Z0-9_]+\}\}/g);
  assert.equal(left, null, `unfilled placeholders: ${left}`);
  return out;
}

function sh(dir, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...scrubGitEnv(), ...env }, timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const git = (dir, ...a) => sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
const node = (dir, ...a) => sh(dir, process.execPath, a);

/** A fresh project: core/ copied, config from the example, templates filled, first commit made. */
function install(configPatch = (c) => c) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-install-')));
  fs.cpSync(CORE, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(CORE, src);
      return rel !== 'templates' && !rel.startsWith(`templates${path.sep}`) && rel !== 'agent-scaffold.config.example.json';
    },
  });
  const example = JSON.parse(fs.readFileSync(path.join(CORE, 'agent-scaffold.config.example.json'), 'utf8'));
  const config = configPatch({
    ...example,
    repos: [{ ...example.repos[0], path: '.', deployBranches: ['main'] }],
    secretScan: { ...example.secretScan, failClosed: false },
  });
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config, null, 2));

  const map = {
    PROJECT_NAME: config.projectName,
    BOARD_FILE: config.board.file,
    BOARD_ARCHIVE: config.board.archive,
    BOARD_CEILING: String(config.board.ceiling),
    COORDINATION_ARCHIVE: config.coordination.archive,
    COORDINATION_CEILING: String(config.coordination.ceiling),
    MEMORY_BANK_DIR: config.memoryBank.dir,
    REPORTS_DIR: config.docs.reports,
    HUMAN_GATEKEEPER: config.humanGatekeeper,
    HUMAN_TAG: config.humans[0],
    HUMAN_STEP_WEEKS: String(config.board.humanStepExpiryWeeks),
    LABEL_HUMAN_ONLY: config.labels.humanOnly,
    LABEL_ANYONE: config.labels.anyone,
    MULTI_REPO_PULL_NOTE: 'Single repo: nothing else to pull.',
  };
  const tmpl = (name) => fs.readFileSync(path.join(CORE, 'templates', name), 'utf8');
  fs.writeFileSync(path.join(dir, config.board.file), fill(tmpl('task-board.md.tmpl'), map));
  fs.writeFileSync(path.join(dir, config.coordination.file), fill(tmpl('coordination.md.tmpl'), map));
  fs.writeFileSync(path.join(dir, config.board.archive), '# Task board archive\n');
  fs.writeFileSync(path.join(dir, config.coordination.archive), '# Coordination archive\n');
  fs.cpSync(path.join(CORE, 'templates', 'memory-bank'), path.join(dir, config.memoryBank.dir), { recursive: true });

  for (const f of fs.readdirSync(path.join(dir, '.githooks'))) fs.chmodSync(path.join(dir, '.githooks', f), 0o755);
  assert.equal(git(dir, 'init', '-q', '-b', 'main').code, 0);
  git(dir, 'config', 'core.hooksPath', '.githooks');
  git(dir, 'add', '-A');
  const first = git(dir, 'commit', '-q', '-m', 'first commit');
  assert.equal(first.code, 0, first.out);
  return { dir, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const write = (dir, rel, text) => fs.writeFileSync(path.join(dir, rel), text);
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const commit = (dir, msg, env) => sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], env);

test('templates fill completely: fill() fails on a leftover placeholder', () => {
  assert.equal(fill('a {{X}} b', { X: '1' }), 'a 1 b');
  assert.throws(() => fill('a {{X}} {{Y}}', { X: '1' }), /unfilled placeholders/);
});

test('(a) SessionStart: valid JSON, no module or runtime errors, no noise lines on a fresh project', () => {
  // No remote exists in the fixture, so the automatic pull is off (it would report a missing upstream).
  const p = install((c) => ({ ...c, session: { ...c.session, autoPull: false, autoPullRepos: false } }));
  try {
    const stdin = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'e2e', cwd: p.dir });
    const r = spawnSync(process.execPath, [path.join(p.dir, '.claude', 'hooks', 'session-context.mjs')], {
      cwd: p.dir, input: stdin, encoding: 'utf8', env: scrubGitEnv(), timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    const all = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(all, /Cannot find module/);
    assert.doesNotMatch(all, /Error:/);
    const note = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(note, /^my-project session note:/);
    // Everything before the numbered guidance is a status line; a fresh project has none.
    // The memory bank still holds the template placeholders until the bootstrap fills them: that line is expected.
    const head = note.split('\n').slice(1).filter((l) => !/^\d\) |^Full working rules:|^memory bank: /.test(l));
    assert.deepEqual(head, [], `noise lines: ${head.join(' | ')}`);
  } finally { p.cleanup(); }
});

test('(b) board: warn mode shows the finding and passes; block mode stops; BOARD_LINT=warn passes', () => {
  const p = install();
  try {
    const board = p.config.board.file;
    const item = ['### 0101-first 🔴 [ANY] First item', '**Remaining:** build it', '**Last evidence:** 2026-01-01 abc1234'].join('\n');
    write(p.dir, board, read(p.dir, board).replace('## Open items\n', `## Open items\n\n${item}\n`));
    git(p.dir, 'add', board);
    const c1 = commit(p.dir, 'add item');
    assert.equal(c1.code, 0, c1.out);

    // A completion line is appended but heading and Remaining stay as they were (rule L1).
    const rot = () => {
      write(p.dir, board, read(p.dir, board).replace(item, `${item}\n**Note:** deployed and live now`));
      git(p.dir, 'add', board);
    };
    rot();
    const warn = commit(p.dir, 'rot, warn mode');
    assert.equal(warn.code, 0, warn.out);
    assert.match(warn.out, /\[pre-commit\] board:/);
    assert.match(warn.out, /L1 0101-first/);

    // Block mode stops the same change.
    git(p.dir, 'reset', '-q', '--soft', 'HEAD~1');
    const cfgPath = path.join(p.dir, 'agent-scaffold.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.board.lint.mode = 'block';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const blocked = commit(p.dir, 'rot, block mode');
    assert.equal(blocked.code, 1, blocked.out);
    assert.match(blocked.out, /COMMIT BLOCKED/);
    assert.match(blocked.out, /BOARD_LINT=skip/);

    // BOARD_LINT=warn overrides the block mode for this commit.
    const passed = commit(p.dir, 'rot, escape', { BOARD_LINT: 'warn' });
    assert.equal(passed.code, 0, passed.out);
  } finally { p.cleanup(); }
});

test('(c) coordination: a closed row stops the commit; --write works on the dirty file; then it passes', () => {
  const p = install();
  try {
    const file = p.config.coordination.file;
    const claim = '| e2e-session | 0101-first | 2026-01-01 | working |';
    write(p.dir, file, read(p.dir, file).replace('|---|---|---|---|\n', `|---|---|---|---|\n${claim}\n`));
    git(p.dir, 'add', file);
    const c1 = commit(p.dir, 'claim');
    assert.equal(c1.code, 0, c1.out);

    write(p.dir, file, read(p.dir, file).replace(claim, '| e2e-session | 0101-first | 2026-01-01 | ✅ DONE 2026-01-02 |'));
    git(p.dir, 'add', file);
    const stopped = commit(p.dir, 'close without archiving');
    assert.equal(stopped.code, 1, stopped.out);
    assert.match(stopped.out, /COMMIT BLOCKED/);

    // The file is dirty relative to HEAD (and staged); --write must still work.
    const w = node(p.dir, 'scripts/coordination-archive.mjs', '--write');
    assert.equal(w.code, 0, w.out);
    assert.doesNotMatch(read(p.dir, file), /0101-first/);
    git(p.dir, 'add', file, p.config.coordination.archive);
    const passed = commit(p.dir, 'close and archive');
    assert.equal(passed.code, 0, passed.out);
    assert.match(read(p.dir, p.config.coordination.archive), /0101-first/);
  } finally { p.cleanup(); }
});

test('(d) rule-inventory --strict exits 0 on a fresh install', () => {
  const p = install();
  try {
    const r = node(p.dir, 'scripts/rule-inventory.mjs', '--strict');
    assert.equal(r.code, 0, r.out);
  } finally { p.cleanup(); }
});

test('(e) repomap-check --all does not report the scaffold own .claude files', () => {
  const p = install();
  try {
    const r = node(p.dir, 'scripts/repomap-check.mjs', '.', '--all', '--json');
    const json = JSON.parse(r.stdout);
    const scaffold = (json.missing ?? []).filter((f) => /^(\.claude|\.codex|\.agents|\.githooks)\//.test(f));
    assert.deepEqual(scaffold, [], r.out);
  } finally { p.cleanup(); }
});
