#!/usr/bin/env node
// Enforces: R-60
/**
 * memory-bank-archive - sliding-window archiver for activeContext.md / progress.md.
 *
 * WHY: these files are meant to hold only "now", but in practice tend to
 * become an append-only session log until nobody can tell what's current
 * anymore.
 *
 * WHAT IT DOES: scans dated `## ` entries in each target file. Entries that
 * fall OUTSIDE the configured window AND carry no pending marker are moved
 * verbatim into `<memoryBank.dir>/archive/<file>-archive.md`. Nothing is
 * ever deleted. An entry that still matches one of config.memoryBank.pendingPhrases
 * (a case-insensitive substring match - e.g. "pending", "blocked", "flag off")
 * stays in place even if it is outside the window - better safe than lost.
 *
 * Recognizes both `## YYYY-MM-DD ...` and `## DD.MM.YYYY ...` headings.
 *
 * Idempotent: kept entries are rewritten byte-for-byte; a blank separator line is
 * added to an entry only when it does not already end with one (an earlier version
 * appended one blank line to EVERY kept entry on EVERY run, so the file grew each time).
 *
 * USAGE:
 *   node scripts/memory-bank-archive.mjs <repoName>              # dry run (report only)
 *   node scripts/memory-bank-archive.mjs <repoName> --write      # apply
 *   node scripts/memory-bank-archive.mjs <repoName> --days 10 --write
 *   node scripts/memory-bank-archive.mjs --all                   # every configured repo, dry run
 *   node scripts/memory-bank-archive.mjs --root <dir> ...        # act on <dir> instead of the script's own
 *                                                                #   project (worktrees); <dir> needs its own config
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { isMainModule } from './lib/main-module.mjs';

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(\d{2})\.(\d{2})\.(\d{4})/;

export function parseDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const d = m[1] ? new Date(`${m[1]}-${m[2]}-${m[3]}`) : new Date(`${m[6]}-${m[5]}-${m[4]}`);
  return isNaN(d) ? null : d;
}

export function isPending(text, phrases) {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

// Lines of a block, ending with exactly one blank separator (added only when missing).
export function blockLines(lines, b) {
  const s = lines.slice(b.s, b.e + 1);
  return s.length && s[s.length - 1].trim() === '' ? s : [...s, ''];
}

/**
 * Plan the split of one file. Returns null when there are no `## ` entries, otherwise
 * { lines, blocks, toMove, toKeep, live } where `live` is the new content of the file (array of lines).
 */
export function planArchive(raw, { days, pendingPhrases = [], today = new Date() }) {
  const lines = raw.split(/\r?\n/);
  const h2 = [];
  lines.forEach((l, i) => { if (/^## /.test(l)) h2.push(i); });
  if (!h2.length) return null;
  const preface = lines.slice(0, h2[0]);
  const blocks = h2.map((s, i) => {
    const e = (h2[i + 1] ?? lines.length) - 1;
    const body = lines.slice(s, e + 1).join('\n');
    const date = parseDate(lines[s]) || parseDate(body.slice(0, 400));
    return { s, e, heading: lines[s], body, date, pending: isPending(body, pendingPhrases) };
  });
  const age = (d) => Math.round((today - d) / 86400000);
  const toMove = blocks.filter((b) => b.date && age(b.date) > days && !b.pending);
  const toKeep = blocks.filter((b) => !toMove.includes(b));
  const live = [...preface, ...toKeep.flatMap((b) => blockLines(lines, b))];
  return { lines, blocks, toMove, toKeep, live };
}

function readArg(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = argv.indexOf(name);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const rootArg = readArg(argv, '--root');
  if (argv.includes('--root') && (!rootArg || rootArg.startsWith('--'))) {
    console.error('--root needs a directory: --root <dir>');
    process.exit(2);
  }
  const startDir = rootArg ? path.resolve(rootArg) : path.dirname(fileURLToPath(import.meta.url));
  const { root, config, found } = loadConfig(startDir);
  if (!found) {
    console.log('[agent-scaffold] agent-scaffold.config.json not found; nothing to archive (fail-open).');
    process.exit(0);
  }

  const WRITE = argv.includes('--write');
  const ALL = argv.includes('--all');
  const DAYS = Number(readArg(argv, '--days')) || config.memoryBank.windowDays || 14;
  const repoNames = (config.repos ?? []).map((r) => r.name);
  // skip the value of --root / --days when looking for repo names
  const positional = argv.filter((a, i) => !a.startsWith('--') && !['--root', '--days'].includes(argv[i - 1]));
  const targetRepoNames = ALL ? repoNames : positional.filter((a) => repoNames.includes(a));
  if (!targetRepoNames.length) {
    console.error('Usage: node scripts/memory-bank-archive.mjs <repoName|--all> [--days N] [--write] [--root <dir>]');
    process.exit(2);
  }

  const today = new Date();
  let totalMoved = 0;
  for (const repoName of targetRepoNames) {
    const repo = (config.repos ?? []).find((r) => r.name === repoName);
    if (!repo) continue;
    for (const file of ['activeContext.md', 'progress.md']) {
      const p = path.join(root, repo.path || '.', config.memoryBank.dir, file);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
      const plan = planArchive(raw, { days: DAYS, pendingPhrases: config.memoryBank.pendingPhrases ?? [], today });
      if (!plan) { console.log(`${repoName}/${file}: no dated \`## \` entries found`); continue; }
      const { lines, blocks, toMove, toKeep, live } = plan;
      if (!toMove.length) {
        console.log(`${repoName}/${file}: nothing to move (${blocks.length} entries, window ${DAYS} days)`);
        continue;
      }

      const archiveName = `${file.replace('.md', '')}-archive.md`;
      const archivePath = path.join(root, repo.path || '.', config.memoryBank.dir, 'archive', archiveName);
      const existing = fs.existsSync(archivePath)
        ? fs.readFileSync(archivePath, 'utf8').split(/\r?\n/)
        : [
            `# ${repoName} - ${file} archive`,
            '',
            '> Entries that fell outside the sliding window (moved verbatim, never deleted). ' +
              'Moved by `scripts/memory-bank-archive.mjs`.',
            '',
          ];
      while (existing.length && existing[existing.length - 1].trim() === '') existing.pop();
      const block = [
        `## Archived ${today.toISOString().slice(0, 10)} - ${toMove.length} entries (window ${DAYS} days)`,
        '',
        ...toMove.flatMap((b) => blockLines(lines, b)),
      ];

      console.log(
        `${repoName}/${file}: ${blocks.length} entries -> kept ${toKeep.length}, archived ${toMove.length}` +
          ` | ${lines.length} -> ${live.length} lines` + (WRITE ? '' : '  (dry run)'),
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
}

if (isMainModule(import.meta.url)) main();
