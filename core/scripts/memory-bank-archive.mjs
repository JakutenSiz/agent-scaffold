#!/usr/bin/env node
/**
 * memory-bank-archive — sliding-window archiver for activeContext.md / progress.md.
 *
 * WHY: these files are meant to hold only "now", but in practice tend to
 * become an append-only session log until nobody can tell what's current
 * anymore.
 *
 * WHAT IT DOES: scans dated `## ` entries in each target file. Entries that
 * fall OUTSIDE the configured window AND carry no pending marker are moved
 * verbatim into `<memoryBank.dir>/archive/<file>-archive.md`. Nothing is
 * ever deleted. An entry that still matches one of config.memoryBank.pendingPhrases
 * (a case-insensitive substring match — e.g. "pending", "blocked", "flag off")
 * stays in place even if it is outside the window — better safe than lost.
 *
 * Recognizes both `## YYYY-MM-DD ...` and `## DD.MM.YYYY ...` headings.
 *
 * USAGE:
 *   node scripts/memory-bank-archive.mjs <repoName>              # dry run (report only)
 *   node scripts/memory-bank-archive.mjs <repoName> --write      # apply
 *   node scripts/memory-bank-archive.mjs <repoName> --days 10 --write
 *   node scripts/memory-bank-archive.mjs --all                   # every configured repo, dry run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const { root, config, found } = loadConfig(SCRIPT_DIR);

if (!found) {
  console.log('[agent-scaffold] agent-scaffold.config.json not found; nothing to archive (fail-open).');
  process.exit(0);
}

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const ALL = argv.includes('--all');

function readDaysArg() {
  const eq = argv.find((a) => a.startsWith('--days='));
  if (eq) return Number(eq.split('=')[1]);
  const idx = argv.indexOf('--days');
  if (idx !== -1 && argv[idx + 1] !== undefined) return Number(argv[idx + 1]);
  return NaN;
}
const DAYS = readDaysArg() || config.memoryBank.windowDays || 14;

const repoNames = (config.repos ?? []).map((r) => r.name);
const targetRepoNames = ALL ? repoNames : argv.filter((a) => repoNames.includes(a));
if (!targetRepoNames.length) {
  console.error('Usage: node scripts/memory-bank-archive.mjs <repoName|--all> [--days N] [--write]');
  process.exit(2);
}

const PENDING_PHRASES = (config.memoryBank.pendingPhrases ?? []).map((p) => p.toLowerCase());
function isPending(text) {
  const lower = text.toLowerCase();
  return PENDING_PHRASES.some((p) => lower.includes(p));
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(\d{2})\.(\d{2})\.(\d{4})/;

const today = new Date();
const daysAgo = (d) => Math.round((today - d) / 86400000);

function parseDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const d = m[1] ? new Date(`${m[1]}-${m[2]}-${m[3]}`) : new Date(`${m[6]}-${m[5]}-${m[4]}`);
  return isNaN(d) ? null : d;
}

let totalMoved = 0;
for (const repoName of targetRepoNames) {
  const repo = (config.repos ?? []).find((r) => r.name === repoName);
  if (!repo) continue;
  for (const file of ['activeContext.md', 'progress.md']) {
    const p = path.join(root, repo.path || '.', config.memoryBank.dir, file);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
    const L = raw.split(/\r?\n/);

    const h2 = [];
    L.forEach((l, i) => { if (/^## /.test(l)) h2.push(i); });
    if (!h2.length) { console.log(`${repoName}/${file}: no dated \`## \` entries found`); continue; }

    const preface = L.slice(0, h2[0]);
    const blocks = h2.map((s, i) => {
      const e = (h2[i + 1] ?? L.length) - 1;
      const body = L.slice(s, e + 1).join('\n');
      const date = parseDate(L[s]) || parseDate(body.slice(0, 400));
      return { s, e, heading: L[s], body, date, pending: isPending(body) };
    });

    const toMove = blocks.filter((b) => b.date && daysAgo(b.date) > DAYS && !b.pending);
    const toKeep = blocks.filter((b) => !toMove.includes(b));
    if (!toMove.length) {
      console.log(`${repoName}/${file}: nothing to move (${blocks.length} entries, window ${DAYS} days)`);
      continue;
    }

    const live = [...preface, ...toKeep.flatMap((b) => [...L.slice(b.s, b.e + 1), ''])];
    const archiveName = `${file.replace('.md', '')}-archive.md`;
    const archivePath = path.join(root, repo.path || '.', config.memoryBank.dir, 'archive', archiveName);
    const existing = fs.existsSync(archivePath)
      ? fs.readFileSync(archivePath, 'utf8').split(/\r?\n/)
      : [
          `# ${repoName} — ${file} archive`,
          '',
          '> Entries that fell outside the sliding window (moved verbatim, never deleted). ' +
            'Moved by `scripts/memory-bank-archive.mjs`.',
          '',
        ];
    const block = [
      `## Archived ${today.toISOString().slice(0, 10)} — ${toMove.length} entries (window ${DAYS} days)`,
      '',
      ...toMove.flatMap((b) => [...L.slice(b.s, b.e + 1), '']),
    ];

    console.log(
      `${repoName}/${file}: ${blocks.length} entries -> kept ${toKeep.length}, archived ${toMove.length}` +
        ` | ${L.length} -> ${live.length} lines` + (WRITE ? '' : '  (dry run)'),
    );
    for (const b of toMove.slice(0, 4)) console.log(`    -> ${b.heading.replace(/^##\s*/, '').slice(0, 84)}`);
    if (toMove.length > 4) console.log(`    -> ... +${toMove.length - 4}`);
    totalMoved += toMove.length;

    if (WRITE) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, [...existing, '', ...block].join(EOL));
      fs.writeFileSync(p, live.join(EOL));
    }
  }
}
console.log(
  WRITE
    ? `\nApplied: ${totalMoved} entries archived.`
    : `\nDry run: ${totalMoved} entries would be archived. Add --write to apply.`,
);
