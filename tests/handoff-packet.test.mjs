// handoff-packet tests -- temporary repositories only. Fake secrets are assembled from pieces so
// that no real-looking token sits in this file as one literal (the push gate scans for those).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../core/scripts/lib/worktree-check.mjs';
import { loadConfig } from '../core/scripts/lib/config.mjs';
import { buildPacket, maskSecrets, fitBudget } from '../core/scripts/handoff-packet.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scripts', 'handoff-packet.mjs');
const ENV = scrubGitEnv();

const BOARD = `# Task board

### 1125-demo-item 🟡 [DEV] Demo item title
**Remaining:** wire the thing, then run the gate
**Human step:** [OWNER] approve the rollout
**Last evidence:** unit test green on 2026-11-24
**Trap:** none

### 1125-other-item 🔴 [DEV] Other item
**Remaining:** nothing yet
`;

const COORD = `# Agent Coordination

## Protocol
mentions 1125-ghost-pack only in the protocol text

## Active claims

| Session | Item code | Since | State |
|---|---|---|---|
| s-1 | 1125-demo-item | 2026-11-24 | working on the wiring |
| s-2 | 1125-closed-one | 2026-11-20 | ✅ DONE 2026-11-21 |

## Open messages

- 2026-11-24 note about 1125-noted-pack stays open

## Handed-over work

### 2026-11-23 handoff for 1125-handed-pack
body

### ✅ 2026-11-01 finished handoff for 1125-finished-pack
body

## Closed
`;

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Root repo cloned from a bare remote, one pushed commit, board + coordination + config. */
function fixture({ config = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'root');
  sh(base, 'init', '-q', '--bare', remote);
  sh(base, 'clone', '-q', remote, root);
  sh(root, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'agent-scaffold.config.json'), JSON.stringify({ projectName: 'demo', ...config }));
  fs.writeFileSync(path.join(root, 'task-board.md'), BOARD);
  fs.writeFileSync(path.join(root, 'coordination.md'), COORD);
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'first commit');
  sh(root, 'push', '-q', '-u', 'origin', 'main');
  const load = () => loadConfig(root);
  const packet = (opts = {}) => {
    const { config: cfg } = load();
    return buildPacket({ root, config: cfg, code: '1125-demo-item', ...opts });
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: ENV });
  return { base, root, packet, run, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('packet carries the board item fields, the claim row and the repo section in order', () => {
  const f = fixture();
  try {
    const p = f.packet();
    assert.match(p, /1125-demo-item/);
    assert.match(p, /Demo item title/);
    assert.match(p, /wire the thing, then run the gate/);
    assert.match(p, /\[OWNER\] approve the rollout/);
    assert.match(p, /unit test green on 2026-11-24/);
    assert.match(p, /\| s-1 \| 1125-demo-item \| 2026-11-24 \| working on the wiring \|/);
    assert.doesNotMatch(p, /1125-closed-one/);
    assert.match(p, /branch: main/);
    assert.match(p, /first commit/);
    assert.doesNotMatch(p, /PUSH PENDING/);
    const at = (re) => p.search(re);
    assert.ok(at(/Demo item title/) < at(/\| s-1 \|/));
    assert.ok(at(/\| s-1 \|/) < at(/branch: main/));
  } finally { f.cleanup(); }
});

test('an unpushed commit adds a PUSH PENDING line with the ahead count', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'x');
    sh(f.root, 'add', 'a.txt');
    sh(f.root, 'commit', '-qm', 'local only');
    const p = f.packet();
    assert.match(p, /ahead 1, behind 0/);
    assert.match(p, /PUSH PENDING: 1 commit\(s\)/);
    assert.match(p, /local only/);
  } finally { f.cleanup(); }
});

test('dirty file list excludes .claude/ and shows other changes', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, '.claude', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.claude', 'cache', 'junk.json'), '{}');
    fs.writeFileSync(path.join(f.root, 'real-change.txt'), 'x');
    const p = f.packet();
    assert.match(p, /real-change\.txt/);
    assert.doesNotMatch(p, /junk\.json/);
    assert.doesNotMatch(p, /\.claude\//);
  } finally { f.cleanup(); }
});

test('open worktrees are listed and the optional note is included', () => {
  const f = fixture();
  try {
    sh(f.root, 'worktree', 'add', '-q', '-b', 'side', path.join(f.base, 'wt-side'));
    const p = f.packet({ note: 'remember to rerun the gate' });
    assert.match(p, /branch side/);
    assert.match(p, /remember to rerun the gate/);
    assert.ok(p.indexOf('branch side') < p.indexOf('remember to rerun the gate'));
  } finally { f.cleanup(); }
});

test('deterministic: same repository state gives the same bytes; stamp only when injected', () => {
  const f = fixture();
  try {
    const a = f.packet();
    const b = f.packet();
    assert.equal(a, b);
    assert.doesNotMatch(a, /generated:/);
    const c = f.packet({ generatedAt: '2026-11-25T10:00:00Z' });
    assert.match(c, /generated: 2026-11-25T10:00:00Z/);
    assert.equal(f.packet({ generatedAt: '2026-11-25T10:00:00Z' }), c);
  } finally { f.cleanup(); }
});

test('over budget: trailing sections are cut, a truncated: line names them, output fits the budget', () => {
  const f = fixture({ config: { handoff: { dir: 'handoffs', budgetBytes: 1500 } } });
  try {
    const note = Array.from({ length: 200 }, (_, i) => `note line number ${i} with some filler text`).join('\n');
    const p = f.packet({ note });
    assert.ok(Buffer.byteLength(p) <= 1500, `size ${Buffer.byteLength(p)}`);
    assert.match(p, /^truncated: .+ \(\d+\)$/m);
    assert.match(p, /Demo item title/); // the head survives
    assert.doesNotMatch(p, /note line number 199/);
  } finally { f.cleanup(); }
});

test('fitBudget: result never exceeds the budget even when it is tiny', () => {
  const sections = [{ name: 'a', text: '## a\n' + 'x'.repeat(500) }, { name: 'b', text: '## b\n' + 'y'.repeat(500) }];
  for (const budget of [2000, 400, 120, 40]) {
    const out = fitBudget('# head', sections, budget);
    assert.ok(Buffer.byteLength(out) <= budget, `budget ${budget}: ${Buffer.byteLength(out)}`);
  }
  assert.match(fitBudget('# head', sections, 400), /truncated: b \(/);
});

const j = (...parts) => parts.join('');
const MASKS = {
  'AWS access key id': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'GitHub token': j('gh', 'p_', 'x'.repeat(36)),
  'GitHub fine-grained token': j('github', '_pat_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  'Slack token': j('xo', 'xb-', '1234567890-abcdefghijkl'),
  'Stripe key': j('sk', '_live_', 'a1B2c3D4e5F6g7H8'),
  'Google API key': j('AI', 'za', 'A'.repeat(35)),
  'Google OAuth token': j('ya', '29.', 'a0AfH6SMBxyzabcdefghijklmnop'),
  'PEM block': j('-----BEGIN ', 'PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\nline2line2line2\n-----END ', 'PRIVATE KEY-----'),
  'Bearer header': j('Bear', 'er ', 'abc123DEF456ghi789'),
  'password assignment': j('pass', 'word', ' = ', 'hunter2hunter2'),
  'secret colon': j('sec', 'ret', ': ', 'topsecretvalue'),
  'token assignment': j('to', 'ken', '=', 'abcd1234'),
  'api key assignment': j('api', '_key', '=', 'zzzz9999'),
  'api-key json': j('"api', '-key": ', '"qwerty1234"'),
  JWT: j('ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcDEF123_-ghiJKL'),
  'long hex': 'a1b2c3d4'.repeat(5),
  'long base64': j('aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5', 'bC7d'),
};

for (const [name, secret] of Object.entries(MASKS)) {
  test(`mask: ${name} does not leave the packet unmasked`, () => {
    const masked = maskSecrets(`before ${secret} after`);
    assert.match(masked, /\[REDACTED\]/);
    const core = secret.replace(/^.*[=:]\s*/s, '').replace(/^Bearer /, '').replace(/^"|"$/g, '');
    assert.ok(!masked.includes(core.split('\n')[0]) || core.length < 8, `leaked: ${masked}`);
    assert.match(masked, /^before /);
    assert.match(masked, / after$/);
  });
}

test('mask: ordinary text, short SHAs and paths survive', () => {
  const text = 'commit abc1234 touched core/scripts/lib/board-format.mjs on branch feature/long-branch-name-here-1125';
  assert.equal(maskSecrets(text), text);
});

test('mask: a secret in the note never reaches the packet text', () => {
  const f = fixture();
  try {
    const secret = j('gh', 'p_', 'q'.repeat(36));
    const p = f.packet({ note: `token seen: ${secret}` });
    assert.ok(!p.includes(secret));
    assert.match(p, /\[REDACTED\]/);
  } finally { f.cleanup(); }
});

test('CLI --write writes <dir>/<code>.md with a stamp and prints one pointer line; plain run only prints', () => {
  const f = fixture();
  try {
    const dry = f.run('1125-demo-item');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Demo item title/);
    assert.ok(!fs.existsSync(path.join(f.root, 'handoffs')));
    const w = f.run('1125-demo-item', '--write', '--note', 'hello');
    assert.equal(w.status, 0, w.stderr);
    const file = path.join(f.root, 'handoffs', '1125-demo-item.md');
    assert.ok(fs.existsSync(file));
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /generated: \d{4}-\d{2}-\d{2}T/);
    assert.match(body, /hello/);
    assert.equal(w.stdout.trim().split('\n').length, 1);
    assert.match(w.stdout, /handoffs\/1125-demo-item\.md/);
  } finally { f.cleanup(); }
});

test('CLI rejects a code that is not a plain item code', () => {
  const f = fixture();
  try {
    const r = f.run('../evil');
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(f.base, 'evil.md')));
  } finally { f.cleanup(); }
});

test('--prune selects only packets without an open claim or open note; --write deletes them', () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, 'handoffs');
    fs.mkdirSync(dir);
    const names = ['1125-demo-item', '1125-closed-one', '1125-noted-pack', '1125-handed-pack', '1125-finished-pack', '1125-ghost-pack', '1125-nowhere'];
    for (const n of names) fs.writeFileSync(path.join(dir, `${n}.md`), 'x');
    const dry = f.run('--prune');
    assert.equal(dry.status, 0, dry.stderr);
    for (const n of ['1125-closed-one', '1125-finished-pack', '1125-ghost-pack', '1125-nowhere']) assert.match(dry.stdout, new RegExp(n));
    for (const n of ['1125-demo-item', '1125-noted-pack', '1125-handed-pack']) assert.doesNotMatch(dry.stdout, new RegExp(n));
    assert.equal(fs.readdirSync(dir).length, names.length);
    const w = f.run('--prune', '--write');
    assert.equal(w.status, 0, w.stderr);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['1125-demo-item.md', '1125-handed-pack.md', '1125-noted-pack.md']);
  } finally { f.cleanup(); }
});
