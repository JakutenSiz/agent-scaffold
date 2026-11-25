// Tests for core/scripts/memory-bank-check.mjs (R-21) and its schema.
// The installed layout is reproduced in a temp project: scripts/ (+ lib/), docs/ schema,
// agent-scaffold.config.json, and a memory-bank/ built from the shipped templates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHeadings, countTableRows, checkContent } from '../core/scripts/memory-bank-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '..', 'core');
const TEMPLATES = path.join(CORE, 'templates', 'memory-bank');
const SCHEMA_FILE = path.join(CORE, 'docs', 'memory-bank-schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
const MD_FILES = Object.keys(schema.files);

/** Turn a template into plausible filled content: placeholders replaced, dated heading added. */
function fill(content) {
  return content
    .replace(/^## <!--[^\n]*-->\s*<!--[^\n]*-->\s*$/gm, '## 2026-01-01 Entry')
    .replace(/<!--[\s\S]*?-->/g, 'filled')
    .replace(/\{\{[^}]*\}\}/g, 'filled');
}

function makeProject({ repos } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-check-'));
  fs.cpSync(path.join(CORE, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.copyFileSync(SCHEMA_FILE, path.join(dir, 'docs', 'memory-bank-schema.json'));
  const list = repos ?? [{ name: 'app', path: '.' }];
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify({ version: 2, repos: list }));
  for (const r of list) {
    const mb = path.join(dir, r.path, 'memory-bank');
    fs.mkdirSync(mb, { recursive: true });
    for (const f of MD_FILES) fs.writeFileSync(path.join(mb, f), fill(fs.readFileSync(path.join(TEMPLATES, f), 'utf8')));
  }
  return dir;
}

function run(dir, ...args) {
  const env = { ...process.env };
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'memory-bank-check.mjs'), ...args], { cwd: dir, encoding: 'utf8', env });
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('filled templates pass', () => {
  const dir = makeProject();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /app: OK/);
  } finally { cleanup(dir); }
});

test('a removed required heading fails and names the file', () => {
  const dir = makeProject();
  try {
    const p = path.join(dir, 'memory-bank', 'projectbrief.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^## Top-Level Goals$/m, 'Goals gone'));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /projectbrief\.md\s+missing-heading\s+top-level goals/);
  } finally { cleanup(dir); }
});

test('a missing file fails', () => {
  const dir = makeProject();
  try {
    fs.rmSync(path.join(dir, 'memory-bank', 'repoMap.md'));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /repoMap\.md\s+missing-file/);
  } finally { cleanup(dir); }
});

test('unfilled template placeholders are findings', () => {
  const dir = makeProject();
  try {
    const p = path.join(dir, 'memory-bank', 'techContext.md');
    fs.appendFileSync(p, '\n<!-- fill: not done yet -->\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /techContext\.md\s+placeholder/);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/<!-- fill:[^>]*-->/g, '') + '\n{{PROJECT_NAME}}\n');
    assert.match(run(dir).stdout, /techContext\.md\s+placeholder/);
  } finally { cleanup(dir); }
});

test('activeContext without a dated entry fails', () => {
  const dir = makeProject();
  try {
    const p = path.join(dir, 'memory-bank', 'activeContext.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## 2026-01-01 Entry', '## Some undated heading'));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /activeContext\.md\s+no-dated-entry/);
  } finally { cleanup(dir); }
});

test('repoMap start-here table needs rows', () => {
  const dir = makeProject();
  try {
    const p = path.join(dir, 'memory-bank', 'repoMap.md');
    const text = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\| filled/.test(l)).join('\n');
    fs.writeFileSync(p, text);
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /repoMap\.md\s+table-rows/);
  } finally { cleanup(dir); }
});

test('--line is silent and exits 0 when clean', () => {
  const dir = makeProject();
  try {
    const r = run(dir, '--line');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { cleanup(dir); }
});

test('--line prints exactly one line and exits 0 on findings', () => {
  const dir = makeProject();
  try {
    fs.rmSync(path.join(dir, 'memory-bank', 'progress.md'));
    const r = run(dir, '--line');
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /memory bank: 1 finding/);
  } finally { cleanup(dir); }
});

test('a <repo-dir> argument checks only that repo', () => {
  const dir = makeProject({ repos: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }] });
  try {
    fs.rmSync(path.join(dir, 'b', 'memory-bank', 'repoMap.md'));
    const onlyA = run(dir, 'a');
    assert.equal(onlyA.status, 0, onlyA.stdout);
    assert.doesNotMatch(onlyA.stdout, /b:/);
    const onlyB = run(dir, 'b');
    assert.equal(onlyB.status, 1);
    assert.match(onlyB.stdout, /b: 1 finding/);
    assert.equal(run(dir).status, 1);
  } finally { cleanup(dir); }
});

test('missing config or schema is fail-open', () => {
  const dir = makeProject();
  try {
    fs.rmSync(path.join(dir, 'docs', 'memory-bank-schema.json'));
    assert.equal(run(dir).status, 0);
    fs.rmSync(path.join(dir, 'agent-scaffold.config.json'));
    assert.equal(run(dir).status, 0);
  } finally { cleanup(dir); }
});

test('config.docs.memoryBankSchema overrides the schema path', () => {
  const dir = makeProject();
  try {
    fs.renameSync(path.join(dir, 'docs', 'memory-bank-schema.json'), path.join(dir, 'custom-schema.json'));
    const cfgPath = path.join(dir, 'agent-scaffold.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.docs = { memoryBankSchema: 'custom-schema.json' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    fs.rmSync(path.join(dir, 'memory-bank', 'repoMap.md'));
    assert.equal(run(dir).status, 1);
  } finally { cleanup(dir); }
});

test('parseHeadings ignores code fences; countTableRows counts data rows', () => {
  const md = '# T\n```\n## not a heading\n```\n## Real\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  assert.deepEqual(parseHeadings(md).map((h) => h.text), ['T', 'Real']);
  assert.equal(countTableRows(md, 'real'), 2);
  assert.deepEqual(checkContent(md, { requiredHeadings: [{ topic: 'x', match: 'nope' }] }).map((f) => f.kind), ['missing-heading']);
});

test('schema stays consistent with the shipped templates', () => {
  for (const [file, spec] of Object.entries(schema.files)) {
    const tpl = path.join(TEMPLATES, file);
    assert.ok(fs.existsSync(tpl), `template missing for ${file}`);
    const headings = parseHeadings(fs.readFileSync(tpl, 'utf8'));
    for (const req of spec.requiredHeadings) {
      const re = new RegExp(req.match, 'i');
      assert.ok(headings.some((h) => re.test(h.text)), `${file}: no template heading matches "${req.topic}" (/${req.match}/)`);
    }
    // Every template with a table or dated entries must satisfy the structural rules once filled.
    assert.deepEqual(checkContent(fill(fs.readFileSync(tpl, 'utf8')), spec), [], `${file}: filled template has findings`);
  }
  // Every shipped markdown template is covered by the schema.
  const md = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(md, [...MD_FILES].sort());
});
