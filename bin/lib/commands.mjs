// `install` and `upgrade`: both build the wanted file list from the config, plan against the project
// and execute (unless --dry-run). Exit codes: 0 done, 1 refused or failed, 2 usage error.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CORE, fromPosix, packageVersion, readJson } from './util.mjs';
import { CONFIG_REL, EXAMPLE_CONFIG_REL, buildEntries, mergedConfig } from './entries.mjs';
import { describePlan, executePlan, planEntries } from './apply.mjs';
import { MANIFEST_REL, readManifest } from './manifest.mjs';
import { ensureDirectoryLink, ensureHooksPath } from '../../core/.claude/hooks/ensure-agent-compat.mjs';

const LINKS = [['.agents/skills', '.claude/skills'], ['.codex/hooks', '.claude/hooks']];

function parseConfigBytes(bytes, label) {
  try {
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} is not a JSON object` };
    return { raw };
  } catch (error) {
    return { error: `${label} is not valid JSON (${error.message})` };
  }
}

/** node --check over the .mjs files the run wrote or confirmed. Returns the number of failures. */
function syntaxCheck(target, plan, log) {
  const rels = plan.actions
    .filter((a) => a.rel.endsWith('.mjs') && ['created', 'restored', 'updated', 'same'].includes(a.kind))
    .map((a) => a.rel);
  const failed = [];
  for (const rel of rels) {
    const r = spawnSync(process.execPath, ['--check', path.join(target, fromPosix(rel))], { encoding: 'utf8' });
    if (r.status !== 0) failed.push(`${rel}: ${(r.stderr ?? '').split('\n').find((l) => l.trim()) ?? 'syntax error'}`);
  }
  if (failed.length) {
    log(`syntax check: ${failed.length} of ${rels.length} file(s) FAILED`);
    for (const f of failed) log(`  ${f}`);
  } else log(`syntax check: ${rels.length} .mjs file(s) OK`);
  return failed.length;
}

function ensureLinks(target, log) {
  for (const [link, source] of LINKS) {
    try {
      ensureDirectoryLink(target, link, source);
    } catch (error) {
      log(`warning: ${error.message}`);
    }
  }
}

export function install({ target: targetArg, configPath, dryRun = false, check = true, wire = true, log = console.log }) {
  const target = path.resolve(targetArg);
  const manifest = readManifest(target);
  if (manifest.state === 'ok') {
    log(`${target} already has ${MANIFEST_REL}: use upgrade to update it (agent-scaffold upgrade <dir>).`);
    return 1;
  }
  if (manifest.state === 'broken') {
    log(`${MANIFEST_REL} exists but cannot be read (${manifest.error}). Fix or remove it, then run upgrade.`);
    return 1;
  }

  let configBytes;
  if (configPath) {
    try {
      configBytes = fs.readFileSync(path.resolve(configPath));
    } catch (error) {
      log(`cannot read --config ${configPath}: ${error.message}`);
      return 2;
    }
  } else {
    try {
      configBytes = fs.readFileSync(path.join(target, CONFIG_REL));
    } catch {
      configBytes = fs.readFileSync(path.join(CORE, EXAMPLE_CONFIG_REL));
    }
  }
  const parsed = parseConfigBytes(configBytes, configPath ?? CONFIG_REL);
  if (parsed.error) {
    log(parsed.error);
    return 2;
  }
  const config = mergedConfig(parsed.raw);

  log(`agent-scaffold ${packageVersion()}: install into ${target}${dryRun ? ' (dry-run)' : ''}`);
  let entries;
  try {
    entries = buildEntries(config, configBytes);
  } catch (error) {
    log(error.message);
    return 1;
  }
  const plan = planEntries({ target, entries, oldFiles: null, mode: 'install' });
  for (const line of describePlan(plan, { dry: dryRun })) log(line);

  if (dryRun) {
    log('dry-run: nothing was written.');
    return 0;
  }
  executePlan(target, plan);
  if (wire) {
    ensureLinks(target, log);
    ensureHooksPath(target, config, log);
  }

  let failures = 0;
  if (check) failures = syntaxCheck(target, plan, log);
  log('next: fill the "<!-- fill: ... -->" lines in the memory bank and CLAUDE.md, then run: agent-scaffold doctor <dir>');
  return failures ? 1 : 0;
}

export function upgrade({ target: targetArg, dryRun = false, check = true, log = console.log }) {
  const target = path.resolve(targetArg);
  let isDir = false;
  try { isDir = fs.statSync(target).isDirectory(); } catch { /* missing */ }
  if (!isDir) {
    log(`${target} is not a directory: nothing to upgrade.`);
    return 1;
  }
  const manifest = readManifest(target);
  if (manifest.state === 'broken') {
    log(`${MANIFEST_REL} exists but cannot be read (${manifest.error}). Fix or remove it.`);
    return 1;
  }
  const cfgFile = path.join(target, CONFIG_REL);
  if (manifest.state === 'missing' && !fs.existsSync(cfgFile)) {
    log(`${target} is not an installation (no ${MANIFEST_REL} and no ${CONFIG_REL}). Run install first.`);
    return 1;
  }
  let configBytes;
  try {
    configBytes = fs.readFileSync(cfgFile);
  } catch (error) {
    log(`cannot read ${CONFIG_REL}: ${error.message}`);
    return 1;
  }
  const parsed = parseConfigBytes(configBytes, CONFIG_REL);
  if (parsed.error) {
    log(parsed.error);
    return 1;
  }
  const config = mergedConfig(parsed.raw);

  const adopt = manifest.state === 'missing';
  const from = adopt ? null : manifest.value.packageVersion;
  log(`agent-scaffold ${packageVersion()}: upgrade ${target}${dryRun ? ' (dry-run)' : ''}`);
  if (adopt) log('no manifest: adopt. Files identical to the package are recorded, different ones get <file>.new, nothing is overwritten.');
  else log(`package version: ${from} -> ${packageVersion()}`);

  let entries;
  try {
    entries = buildEntries(config, configBytes);
  } catch (error) {
    log(error.message);
    return 1;
  }
  const plan = planEntries({ target, entries, oldFiles: adopt ? null : manifest.value.files, mode: 'upgrade' });
  for (const line of describePlan(plan, { dry: dryRun })) log(line);

  const example = readJson(path.join(CORE, EXAMPLE_CONFIG_REL));
  if (example.ok) {
    const missing = Object.keys(example.value).filter((k) => !k.startsWith('$') && !(k in parsed.raw));
    if (missing.length) log(`config keys in the example but not in ${CONFIG_REL} (defaults apply, nothing written): ${missing.join(', ')}`);
  }

  if (dryRun) {
    log('dry-run: nothing was written.');
    return 0;
  }
  executePlan(target, plan);
  let failures = 0;
  if (check) failures = syntaxCheck(target, plan, log);
  return failures ? 1 : 0;
}
