#!/usr/bin/env node
// Small helper for setup-hooks.sh / setup-hooks.bat: prints one repo path
// per line (relative to root, skipping the root itself i.e. path === ".")
// read from agent-scaffold.config.json. Neither shell has a JSON parser, so
// this is the one place that reads the config for both installers.
//
// Fails silently with an empty list (exit 0) on any problem -- the callers
// then simply skip configuring any sub-repo hooksPath and only set up the
// root, which is the same fail-open posture as every other tool here.
//
//   node scripts/list-configured-repos.mjs <root>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) process.exit(0);

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(root, 'agent-scaffold.config.json'), 'utf8'));
} catch {
  process.exit(0);
}

for (const r of cfg.repos ?? []) {
  if (r.path && r.path !== '.') process.stdout.write(r.path + '\n');
}
