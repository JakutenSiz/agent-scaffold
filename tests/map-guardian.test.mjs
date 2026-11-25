// Tests for core/.claude/hooks/map-guardian.mjs: selective first-edit injection under a byte
// budget, once-per-session behaviour, broken-registry warning, and the reuse-registry deny gate.
// The hook runs as a child process with a real stdin payload (a fake session id, a temp project).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, selectMapSlice } from '../core/.claude/hooks/map-guardian.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', '.claude', 'hooks', 'map-guardian.mjs');

function makeProject({ map, registry, config = {} }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mapg-')));
  fs.writeFileSync(path.join(dir, 'agent-scaffold.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'memory-bank'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory-bank', 'repoMap.md'), map);
  if (registry !== undefined) {
    fs.writeFileSync(path.join(dir, 'memory-bank', 'reuse-registry.json'), typeof registry === 'string' ? registry : JSON.stringify(registry));
  }
  return dir;
}

let counter = 0;
function runHook(dir, relFile, { content = '// edit', sid } = {}) {
  const payload = JSON.stringify({
    cwd: dir,
    session_id: sid || `mapg-test-${process.pid}-${Date.now()}-${counter++}`,
    agent_id: 'test',
    tool_input: { file_path: path.join(dir, relFile), new_string: content },
  });
  return spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
}

const ctxOf = (r) => {
  assert.equal(r.status, 0, `exit 0 expected, stderr: ${r.stderr}`);
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '') : '';
};

const filler = (label, n) =>
  Array.from({ length: n }, (_, i) => `- ${label} line ${i}: a long filler description for budget pressure (${label}-${i}) and then some more text`).join('\n');

// A map far bigger than the budget: a task table, a section mentioning the edited area, and noise.
function bigMap() {
  return [
    '# Repo Map',
    '',
    '## Task Starting Points',
    '',
    '| Task | Entry file | Notes |',
    '|---|---|---|',
    '| add an API route | `src/api/routes.ts` | register in index |',
    '| change billing | `src/billing/service.ts` | credits live here |',
    '',
    '## Billing Area',
    '',
    '- `src/billing/invoice_builder.ts` builds invoices',
    '- `src/billing/refunds.ts` refund rules',
    '',
    '## Noise A',
    '',
    filler('noise-a', 150),
    '',
    '## Noise B',
    '',
    filler('noise-b', 150),
  ].join('\n');
}

test('selective injection: stays within the byte budget and includes the matching section', () => {
  const dir = makeProject({ map: bigMap() });
  try {
    const ctx = ctxOf(runHook(dir, 'src/billing/invoice_builder.ts'));
    assert.ok(ctx.length > 0, 'first edit injects context');
    assert.ok(Buffer.byteLength(ctx, 'utf8') <= 8000, `over budget: ${Buffer.byteLength(ctx, 'utf8')}`);
    assert.match(ctx, /map trimmed, full: /);
    assert.ok(ctx.includes('Table of contents'));
    assert.ok(ctx.includes('## Billing Area'), 'heading of the matching section');
    assert.ok(ctx.includes('invoice_builder.ts` builds invoices'), 'matching line');
    assert.ok(ctx.includes('| change billing |'), 'task table is part of the core');
    assert.ok(!ctx.includes('noise-b line 100'), 'unrelated section is not injected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('budget comes from config.memoryBank.mapBudgetBytes', () => {
  const dir = makeProject({ map: bigMap(), config: { memoryBank: { mapBudgetBytes: 2500 } } });
  try {
    const ctx = ctxOf(runHook(dir, 'src/billing/refunds.ts'));
    assert.ok(Buffer.byteLength(ctx, 'utf8') <= 2500, `over budget: ${Buffer.byteLength(ctx, 'utf8')}`);
    assert.ok(ctx.includes('refunds.ts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a small map is injected whole (no trimming note)', () => {
  const dir = makeProject({ map: '# Repo Map\n\n## Layout\n\n- `src/a.ts` entry\n' });
  try {
    const ctx = ctxOf(runHook(dir, 'src/a.ts'));
    assert.ok(ctx.includes('--- repoMap.md ---'));
    assert.ok(ctx.includes('- `src/a.ts` entry'));
    assert.doesNotMatch(ctx, /map trimmed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('huge registry and huge table of contents still respect the budget; dropped entries are flagged', () => {
  const registry = {
    entries: Array.from({ length: 60 }, (_, i) => ({
      name: `Piece ${i}`,
      canonical: [`src/shared/piece-${i}.ts`],
      use: `Piece ${i} long usage note `.repeat(12),
      triggers: [],
    })),
  };
  const dir = makeProject({ map: bigMap(), registry });
  try {
    const ctx = ctxOf(runHook(dir, 'src/billing/refunds.ts'));
    assert.ok(Buffer.byteLength(ctx, 'utf8') <= 8000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const small = makeProject({ map: '# Repo Map\n\n## S\n\n- x\n', registry });
  try {
    const ctx = ctxOf(runHook(small, 'src/b.ts'));
    assert.ok(Buffer.byteLength(ctx, 'utf8') <= 8000);
    assert.ok(ctx.includes('Piece 0:'));
    assert.match(ctx, /\+\d+ more entries — full list: memory-bank\/reuse-registry\.json/);
  } finally {
    fs.rmSync(small, { recursive: true, force: true });
  }
  // Pathological table of contents: the hard cap still holds.
  const headings = Array.from({ length: 800 }, (_, i) => `## Section number ${i}\n\n- item ${i}`).join('\n\n');
  const out = buildContext({ mapText: headings, rel: 'src/a.ts', repoName: 'r', mapPath: '/m', registry: null, budget: 3000 });
  assert.ok(Buffer.byteLength(out, 'utf8') <= 3000);
});

test('second edit in the same (session, agent, repo) does not inject again', () => {
  const dir = makeProject({ map: bigMap() });
  try {
    const sid = `mapg-once-${process.pid}-${Date.now()}`;
    assert.ok(ctxOf(runHook(dir, 'src/billing/refunds.ts', { sid })).length > 0);
    assert.equal(ctxOf(runHook(dir, 'src/api/routes.ts', { sid })), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('broken reuse-registry.json: exit 0, no deny, one warning line on stderr', () => {
  const dir = makeProject({ map: '# Repo Map\n', registry: '{broken' });
  try {
    const r = runHook(dir, 'src/a.ts', { content: 'new Date(' });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
    assert.match(r.stderr, /reuse-registry\.json could not be parsed/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REGISTRY = {
  entries: [
    {
      name: 'date helper',
      canonical: ['src/shared/dates.ts'],
      triggers: ['new Date('],
      exempt: ['tests/'],
      use: 'use the shared date helper',
    },
  ],
};

test('reuse gate: a copy of a registered piece is denied; the canonical file, exempt paths and references pass', () => {
  const dir = makeProject({ map: '# Repo Map\n', registry: REGISTRY });
  try {
    const denied = runHook(dir, 'src/feature/calendar.ts', { content: 'const d = new Date(2026, 1);' });
    assert.equal(denied.status, 0);
    const out = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /CANONICAL piece for "date helper"/);
    assert.match(out.permissionDecisionReason, /src\/shared\/dates\.ts/);

    const canonical = JSON.parse(runHook(dir, 'src/shared/dates.ts', { content: 'new Date(' }).stdout || '{}');
    assert.notEqual(canonical.hookSpecificOutput?.permissionDecision, 'deny');
    const exempt = JSON.parse(runHook(dir, 'tests/dates.test.ts', { content: 'new Date(' }).stdout || '{}');
    assert.notEqual(exempt.hookSpecificOutput?.permissionDecision, 'deny');
    const referencing = JSON.parse(runHook(dir, 'src/feature/other.ts', { content: "import { x } from './dates'; new Date(" }).stdout || '{}');
    assert.notEqual(referencing.hookSpecificOutput?.permissionDecision, 'deny');
    // Non-source extension: never gated.
    const notSource = JSON.parse(runHook(dir, 'src/feature/notes.txt', { content: 'new Date(' }).stdout || '{}');
    assert.notEqual(notSource.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registry with a string canonical (not an array) does not crash the hook', () => {
  const dir = makeProject({
    map: '# Repo Map\n',
    registry: { entries: [{ name: 'x', canonical: 'src/shared/x.ts', triggers: ['zzz'] }] },
  });
  try {
    const r = runHook(dir, 'src/a.ts');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /is not a function/);
    assert.ok(ctxOf(r).includes('x.ts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no config / no map: hook stays silent', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mapg-none-')));
  try {
    const r = runHook(dir, 'src/a.ts');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('selectMapSlice: language-independent core detection and matching', () => {
  const map = [
    '# Harita',
    '',
    '## Görev tablosu',
    '',
    '| Görev | Dosya |',
    '|---|---|',
    '| rota ekle | `src/api/routes.ts` |',
    '| fatura | `src/billing/service.ts` |',
    '',
    '## Diğer',
    '',
    '- `src/billing/refunds.ts`',
  ].join('\n');
  const s = selectMapSlice(map, 'src/billing/refunds.ts');
  assert.equal(s.coreTitle, '## Görev tablosu');
  assert.ok(s.matchLines.some((l) => l.includes('refunds.ts')));
  assert.ok(s.toc.includes('## Diğer'));
});

test('reuse gate mode: memoryBank.reuseGate=off (or the minimal profile) never denies; standard still does', () => {
  const content = 'const d = new Date(2026, 1);';
  for (const [config, denies] of [
    [{ memoryBank: { reuseGate: 'off' } }, false],
    [{ profile: 'minimal' }, false],
    [{ profile: 'strict' }, true],
    [{}, true],
  ]) {
    const dir = makeProject({ map: '# Repo Map\n', registry: REGISTRY, config });
    try {
      const r = runHook(dir, 'src/feature/calendar.ts', { content });
      const decision = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : null;
      assert.equal(decision === 'deny', denies, JSON.stringify(config));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('reuse gate off still injects the JIT map slice', () => {
  const dir = makeProject({ map: '# Repo Map\nsrc/feature/calendar.ts\n', registry: REGISTRY, config: { memoryBank: { reuseGate: 'off' } } });
  try {
    assert.match(ctxOf(runHook(dir, 'src/feature/calendar.ts', { content: 'new Date(' })), /FIRST edit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
