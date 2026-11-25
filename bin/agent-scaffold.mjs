#!/usr/bin/env node
// agent-scaffold CLI: install | upgrade | doctor. Exit codes: 0 ok, 1 refused or failed, 2 usage error.
import { install, upgrade } from './lib/commands.mjs';
import { doctor } from './lib/doctor.mjs';

const USAGE = `usage:
  agent-scaffold install <dir> [--dry-run] [--config <file.json>]
  agent-scaffold upgrade <dir> [--dry-run]
  agent-scaffold doctor  <dir> [--json]

install writes the scaffold into <dir> and never overwrites an existing file (a <file>.new is written instead).
upgrade refreshes the engine files from a newer package; files you changed get a <file>.new.
doctor reports the health of an installation (PASS/WARN/FAIL per row, exit 1 on any FAIL).`;

const FLAGS = { install: ['--dry-run', '--config', '--no-check'], upgrade: ['--dry-run', '--no-check'], doctor: ['--json'] };

function usage(message) {
  if (message) console.error(message);
  console.error(USAGE);
  return 2;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (!FLAGS[cmd]) return usage(`unknown command: ${cmd}`);
  const positional = [];
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    if (!FLAGS[cmd].includes(a)) return usage(`unknown option for ${cmd}: ${a}`);
    if (a === '--config') {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) return usage('--config needs a file');
      opts.config = rest[++i];
    } else opts[a.slice(2)] = true;
  }
  if (positional.length !== 1) return usage(`${cmd} needs exactly one target directory`);
  const target = positional[0];
  if (cmd === 'install') return install({ target, configPath: opts.config, dryRun: !!opts['dry-run'], check: !opts['no-check'] });
  if (cmd === 'upgrade') return upgrade({ target, dryRun: !!opts['dry-run'], check: !opts['no-check'] });
  return doctor({ target, json: !!opts.json });
}

process.exitCode = main(process.argv.slice(2));
