#!/usr/bin/env node
/**
 * gate-table - keeps the gate label table in README.md equal to what the registry
 * (scripts/lib/gates.mjs) produces for the three profiles.
 *
 * USAGE: node scripts/gate-table.mjs --write | --check [--readme <file>]
 *   --write   replaces ONLY the text between the two marker lines; every other byte of the
 *             file is kept.
 *   --check   exits 1 when the block differs from the generated table (or the markers are missing).
 * The default file is README.md two levels above this script (the scaffold repo root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTable } from './lib/gates.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const BEGIN = '<!-- gates:begin -->';
export const END = '<!-- gates:end -->';

/** Splits README text at the markers: { head, inner, tail } or null when they are missing/ambiguous. */
export function splitBlock(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < b || text.indexOf(BEGIN, b + 1) >= 0 || text.indexOf(END, e + 1) >= 0) return null;
  return { head: text.slice(0, b + BEGIN.length), inner: text.slice(b + BEGIN.length, e), tail: text.slice(e) };
}

export const wrap = (table) => `\n${table}\n`;

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const i = argv.indexOf('--readme');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = i >= 0 ? path.resolve(argv[i + 1] ?? '') : path.resolve(here, '..', '..', 'README.md');
  if (write === check) {
    console.error('usage: gate-table.mjs --write | --check [--readme <file>]');
    return 2;
  }
  if (!fs.existsSync(file)) {
    console.error(`gate-table: ${file} not found`);
    return 1;
  }
  const text = fs.readFileSync(file, 'utf8');
  const parts = splitBlock(text);
  if (!parts) {
    console.error(`gate-table: ${file} needs exactly one ${BEGIN} ... ${END} pair`);
    return 1;
  }
  const want = wrap(renderTable());
  if (check) {
    if (parts.inner === want) return 0;
    console.error('gate-table: the README block is out of date; run: node core/scripts/gate-table.mjs --write');
    return 1;
  }
  if (parts.inner !== want) fs.writeFileSync(file, parts.head + want + parts.tail);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
