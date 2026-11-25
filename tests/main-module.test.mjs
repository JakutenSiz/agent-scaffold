// Guards the "is this file run directly?" check: it must go through isMainModule (realpath on both
// sides). Comparing import.meta.url with process.argv[1] directly silently returns false when the
// path crosses a symlink (macOS /var -> /private/var), so the script exits 0 doing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../core/scripts/lib/main-module.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['core/scripts', 'core/.claude/hooks'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
const EXEMPT = new Set(['core/scripts/lib/main-module.mjs']);

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const PATTERNS = [
  (s) => /pathToFileURL\(\s*(?:resolve\(\s*)?process\.argv\[1\]/.test(s),
  (s) => /process\.argv\[1\]/.test(s) && /import\.meta\.url/.test(s),
  (s) => /path\.resolve\(\s*process\.argv\[1\]\s*\)/.test(s),
];

test('isMainModule: true for the file itself, false for another file or no argv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-module-'));
  try {
    const a = path.join(dir, 'a.mjs');
    const b = path.join(dir, 'b.mjs');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    assert.equal(isMainModule(pathToFileURL(a).href, a), true);
    assert.equal(isMainModule(pathToFileURL(a).href, b), false);
    assert.equal(isMainModule(pathToFileURL(a).href, undefined), false);
    assert.equal(isMainModule(pathToFileURL(path.join(dir, 'missing.mjs')).href, a), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isMainModule: true when argv[1] goes through a symlinked directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-module-link-'));
  try {
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'x.mjs'), '');
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      t.skip('symlinks unavailable on this platform');
      return;
    }
    assert.equal(isMainModule(pathToFileURL(path.join(real, 'x.mjs')).href, path.join(link, 'x.mjs')), true);
    assert.equal(isMainModule(pathToFileURL(path.join(link, 'x.mjs')).href, path.join(real, 'x.mjs')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no script or hook compares argv[1] with import.meta.url directly', () => {
  const findings = [];
  for (const dir of SCAN) {
    for (const f of sourceFiles(path.join(ROOT, dir))) {
      if (EXEMPT.has(f)) continue;
      fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (PATTERNS.some((p) => p(line))) findings.push(`${f}:${i + 1}  ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(findings, [], `use isMainModule(import.meta.url) from scripts/lib/main-module.mjs:\n${findings.join('\n')}`);
});
