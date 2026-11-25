// Loads bin/file-classes.json and classifies package paths (relative to core/).
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, globToRegExp } from './util.mjs';

let cache = null;

export function loadClasses() {
  if (!cache) {
    const raw = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bin', 'file-classes.json'), 'utf8'));
    cache = raw.rules.map((r) => ({ re: globToRegExp(r.glob), glob: r.glob, class: r.class }));
  }
  return cache;
}

/** engine | seed | hybrid | merge, or null when no rule matches. */
export function classify(corePath) {
  for (const rule of loadClasses()) if (rule.re.test(corePath)) return rule.class;
  return null;
}
