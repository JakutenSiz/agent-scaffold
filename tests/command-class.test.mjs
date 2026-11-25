// Tests for core/.claude/hooks/lib/command-class.mjs (pure shell classifier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReadCommand,
  isEditCommand,
  stripHeredocBodies,
  blankQuotedContent,
} from '../core/.claude/hooks/lib/command-class.mjs';

test('isReadCommand: commands counted as reads', () => {
  const reads = [
    'cat a.txt',
    'grep -rn x src',
    'rg foo',
    'sed -n 1,40p f',
    'cd x && head -5 f',
    'git grep foo',
    'git show HEAD:a.js',
    'Get-Content f',
    'FOO=1 tail -n 3 f',
  ];
  for (const cmd of reads) assert.ok(isReadCommand(cmd), `should count as read: ${cmd}`);
});

test('isReadCommand: commands NOT counted as reads', () => {
  const notReads = [
    'git log --oneline | head',
    'git diff',
    'ls -la',
    "cat > f <<'EOF'\nfoo\nEOF",
    'sed -i s/a/b/ f',
    'node --check x.js',
    'echo "cat x"',
    'git show abc123',
    '',
  ];
  for (const cmd of notReads) assert.ok(!isReadCommand(cmd), `should not count as read: ${cmd}`);
});

test('isEditCommand: sed -i / perl -pi / node -e writeFileSync are edits, reads are not', () => {
  assert.ok(isEditCommand('sed -i s/a/b/ f'));
  assert.ok(isEditCommand("perl -pi -e 's/a/b/' f"));
  assert.ok(isEditCommand('node -e "writeFileSync(\'f.js\',\'x\')"'));
  assert.ok(!isEditCommand('cat a.txt'));
  assert.ok(!isEditCommand('git status'));
  assert.ok(!isEditCommand(''));
});

test('heredoc bodies are dropped, the text before the marker is kept', () => {
  const out = stripHeredocBodies("cat > f <<'EOF'\ngrep inside\nEOF\nls");
  assert.ok(!out.includes('grep inside'));
  assert.ok(out.includes('cat > f'));
  assert.ok(out.includes('ls'));
});

test('quoted content is blanked', () => {
  assert.equal(blankQuotedContent(`echo "cat x" 'y'`), `echo "" ''`);
});
