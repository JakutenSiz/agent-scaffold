import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesIn, enforcedBy, inventory, summaryLine } from '../core/scripts/rule-inventory.mjs';
import { DEFAULTS } from '../core/scripts/lib/config.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-inv-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('rulesIn finds bracketed ids and ignores fenced code', () => {
  const rules = rulesIn('- [R-01] Do not read file after file.\n```\n[R-99] not a rule\n```\n- [P-07] **Project** rule.');
  assert.deepEqual(rules.map((r) => r.id), ['R-01', 'P-07']);
  assert.equal(rules[1].text, 'Project rule.');
});

test('enforcedBy reads only the header', () => {
  assert.deepEqual(enforcedBy('#!/usr/bin/env node\n// Enforces: R-01, R-02\ncode();'), ['R-01', 'R-02']);
  const late = Array(40).fill('x();').join('\n') + '\n// Enforces: R-09';
  assert.deepEqual(enforcedBy(late), []);
});

test('inventory splits enforced from advice and reports unknown and duplicate ids', () => {
  const dir = project({
    'docs/agent-working-rules.md': '- [R-01] Delegate reading.\n- [R-02] Single level.\n- [R-03] Pass the mid model.\n',
    'CLAUDE.md': '- [R-02] restated here by mistake\n',
    '.claude/hooks/read-guard.mjs': '// Enforces: R-01, R-02\n',
    'scripts/ghost.mjs': '// Enforces: R-77\n',
  });
  try {
    const inv = inventory(dir, DEFAULTS);
    assert.deepEqual(inv.rules.map((r) => r.id), ['R-01', 'R-02', 'R-03']);
    assert.deepEqual(inv.advice.map((r) => r.id), ['R-03']);
    assert.deepEqual(inv.unknown, [{ id: 'R-77', file: 'scripts/ghost.mjs' }]);
    assert.equal(inv.duplicates.length, 1);
    assert.equal(inv.duplicates[0].id, 'R-02');
    assert.match(summaryLine(inv), /1 id\(s\) cited by code/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('summaryLine is empty when nothing is wrong', () => {
  assert.equal(summaryLine({ rules: [], advice: [], unknown: [], duplicates: [] }), '');
});

// Lock for the package itself: every id an enforcer in core/ cites exists in the rulebook,
// and no id is defined twice.
test('core/ is consistent: no unknown or duplicate rule ids', () => {
  const inv = inventory(CORE, DEFAULTS);
  assert.deepEqual(inv.unknown, [], 'ids cited by code but missing from core/docs/agent-working-rules.md');
  assert.deepEqual(inv.duplicates, []);
  assert.ok(inv.rules.length >= 25, 'rulebook should define the R-series');
});
