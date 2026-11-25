// Tests for core/scripts/repomap-check.mjs: new files missing from the map are caught, files that
// are in the map pass, short names, the inventory rule, --all, and locale-aware matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCovered, lower, parseArgs, filterSource, buildIgnore } from '../core/scripts/repomap-check.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scripts', 'repomap-check.mjs');

function scrubEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

// Builds a temp git repo: commit 1 = map (+ optional config), commit 2 = the new file.
// Returns { dir, run(args) } where run returns { status, json }.
function makeRepo({ map, file, config, commitFile = true }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-')));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore', env: scrubEnv() });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'memory-bank'));
  fs.writeFileSync(path.join(dir, 'memory-bank', 'repoMap.md'), map);
  if (config) fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  git('add', '-A');
  git('commit', '-q', '-m', 'map');
  if (file && commitFile) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
    git('add', '-A');
    git('commit', '-q', '-m', 'add');
  }
  const run = (...extra) => {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, dir, '--json', ...extra], { encoding: 'utf8', env: scrubEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      return { status: 0, json: JSON.parse(out) };
    } catch (e) {
      return { status: e.status, json: JSON.parse(String(e.stdout)) };
    }
  };
  return { dir, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const missingFor = (map, file, config) => {
  const r = makeRepo({ map, file, config });
  try {
    return r.run('--range', 'HEAD~1..HEAD').json.missing;
  } finally {
    r.cleanup();
  }
};

test('a new file absent from the map is caught (exit 1)', () => {
  const r = makeRepo({ map: '# Map\n\nunrelated text\n', file: 'src/engine/whisper.py' });
  try {
    const res = r.run('--range', 'HEAD~1..HEAD');
    assert.equal(res.status, 1);
    assert.deepEqual(res.json.missing, ['src/engine/whisper.py']);
  } finally {
    r.cleanup();
  }
});

test('a file named in the map passes (exit 0)', () => {
  const r = makeRepo({ map: '# Map\n\n- whisper engine\n', file: 'src/engine/whisper.py' });
  try {
    const res = r.run('--range', 'HEAD~1..HEAD');
    assert.equal(res.status, 0);
    assert.deepEqual(res.json.missing, []);
  } finally {
    r.cleanup();
  }
});

test('short names: parent/file or full path in the map covers; a bare mention does not', () => {
  assert.deepEqual(missingFor('- `providers/asr.py` ASR', 'providers/asr.py'), []);
  assert.deepEqual(missingFor('- svc/providers/asr.py', 'svc/providers/asr.py'), []);
  assert.deepEqual(missingFor('asr is mentioned here', 'providers/asr.py'), ['providers/asr.py']);
});

test('inventory directory requires the file name; an ancestor dir mention is not enough', () => {
  assert.deepEqual(missingFor('- `src/components/`', 'src/components/Calendar.tsx'), ['src/components/Calendar.tsx']);
  assert.deepEqual(missingFor('- `src/components/` incl. Calendar', 'src/components/Calendar.tsx'), []);
  assert.deepEqual(missingFor('- `src/pages/`', 'src/pages/home.tsx'), []); // non-inventory: ancestor covers
});

test('--all audits every tracked source file; an uncommitted map falls back to all-tracked', () => {
  const r = makeRepo({ map: '# Map\n', file: 'src/engine/whisper.py' });
  try {
    const res = r.run('--all');
    assert.equal(res.json.mode, 'all-tracked');
    assert.deepEqual(res.json.missing, ['src/engine/whisper.py']);
  } finally {
    r.cleanup();
  }
  // Map never committed (untracked): since-map-commit would be empty -> all-tracked fallback.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-fresh-')));
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore', env: scrubEnv() });
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'memory-bank'));
    fs.writeFileSync(path.join(dir, 'memory-bank', 'repoMap.md'), '# Map\n');
    fs.mkdirSync(path.join(dir, 'src', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'engine', 'whisper.py'), '');
    git('add', 'src');
    git('commit', '-q', '-m', 'src only');
    const out = JSON.parse(
      (() => {
        try {
          return execFileSync(process.execPath, [SCRIPT, dir, '--json'], { encoding: 'utf8', env: scrubEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
          return String(e.stdout);
        }
      })(),
    );
    assert.match(out.mode, /^all-tracked/);
    assert.deepEqual(out.missing, ['src/engine/whisper.py']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo without a map: skipped, exit 0', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-nomap-')));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, dir, '--json'], { encoding: 'utf8', env: scrubEnv() });
    assert.deepEqual(JSON.parse(out), { skipped: 'no repoMap.md' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sourceExtensions from config decide which files count', () => {
  const config = { repos: [{ name: 'app', path: '.', sourceExtensions: ['go'] }] };
  assert.deepEqual(missingFor('# Map\n', 'cmd/server/main.go', config), ['cmd/server/main.go']);
  assert.deepEqual(missingFor('# Map\n', 'src/engine/whisper.py', config), []); // .py not a source ext here
});

test('locale-aware matching: Turkish dotted I in the map matches only with language "tr"', () => {
  const map = '- İSTEKSERVİSİ modülü\n';
  const file = 'src/engine/istekservisi.py';
  assert.deepEqual(missingFor(map, file, { language: 'tr' }), []);
  assert.deepEqual(missingFor(map, file, { language: 'en' }), [file]);
});

test('pure helpers: lower(), parseArgs(), isCovered(), filterSource()', () => {
  assert.equal(lower('İI', 'tr'), 'iı');
  assert.equal(lower('ABC', ''), 'abc');
  assert.equal(lower('ABC', 'not a locale!!'), 'abc'); // invalid tag falls back
  const p = parseArgs(['--range', 'A..B', '/some/repo', '--json']);
  assert.equal(p.range, 'A..B');
  assert.equal(p.repoDir, path.resolve('/some/repo'));
  assert.equal(p.json, true);
  assert.equal(isCovered('src/api/routes.py', '- src/api/ handlers'), true);
  assert.equal(isCovered('src/hooks/useThing.ts', '- src/hooks/'), false);
  const ignore = buildIgnore(['(^|/)generated/'], 'memory-bank');
  assert.deepEqual(
    filterSource(['a.py', 'a.test.py', 'generated/x.py', 'memory-bank/y.py', 'z.txt', 'a.py'], ['py'], ignore),
    ['a.py'],
  );
});

test('agent tool directories (.claude/.codex/.agents/.githooks) are not product source', () => {
  const ignore = buildIgnore([], 'memory-bank');
  assert.deepEqual(
    filterSource(['.claude/hooks/a-hook.mjs', '.claude/hooks/lib/x-lib.mjs', '.codex/y-tool.mjs', '.agents/z-tool.mjs', '.githooks/w-hook.mjs', 'src/real-code.mjs', 'sub/.claude/q.mjs'], ['mjs'], ignore),
    ['src/real-code.mjs', 'sub/.claude/q.mjs'],
  );
});

test('--all on a fresh install does not report the scaffold own .claude files', () => {
  const r = makeRepo({ map: '# Map\n', file: '.claude/hooks/some-hook.mjs' });
  try {
    const res = r.run('--all');
    assert.equal(res.status, 0);
    assert.deepEqual(res.json.missing, []);
  } finally { r.cleanup(); }
});

function cliRun(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: scrubEnv() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('argument resolves as a directory first, then as a config repo name; neither is an error (exit 2)', () => {
  const r = makeRepo({ map: '# Map\n', file: 'src/engine/whisper.py', config: { repos: [{ name: 'app', path: '.' }] } });
  try {
    // repo NAME instead of a directory: resolved through config.repos
    const byName = cliRun(['app', '--json', '--all'], r.dir);
    assert.equal(byName.status, 1, byName.stderr);
    assert.deepEqual(JSON.parse(byName.stdout).missing, ['src/engine/whisper.py']);
    // neither a directory nor a configured name
    const bad = cliRun(['nope', '--json'], r.dir);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /nope/);
    assert.match(bad.stderr, /not a directory or a configured repo name/);
    assert.equal(bad.stdout, '');
  } finally { r.cleanup(); }
});
