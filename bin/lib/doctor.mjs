// `doctor`: read-only health report of an installation. Every row is PASS, WARN or FAIL; any FAIL means exit 1.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CORE, fromPosix, packageVersion, readJson, sha256, walkFiles } from './util.mjs';
import { CONFIG_REL, mergedConfig } from './entries.mjs';
import { MANIFEST_REL, readManifest } from './manifest.mjs';
import { hookTriples } from './merge.mjs';

const abs = (target, rel) => path.join(target, fromPosix(rel));
const head = (text, n = 6) => {
  const list = text.split(', ');
  return list.length > n ? `${list.slice(0, n).join(', ')} and ${list.length - n} more` : text;
};

function wiringRow(target, id, rel, pkgRel) {
  const pkg = readJson(path.join(CORE, fromPosix(pkgRel)));
  if (!pkg.ok) return { id, status: 'FAIL', message: `package file ${pkgRel} unreadable` };
  const file = abs(target, rel);
  if (!fs.existsSync(file)) return { id, status: 'FAIL', message: `${rel} is missing` };
  const mine = readJson(file);
  if (!mine.ok) return { id, status: 'FAIL', message: `${rel} is not valid JSON` };
  const have = new Set(hookTriples(mine.value).map((t) => t.key));
  const missing = hookTriples(pkg.value).filter((t) => !have.has(t.key));
  if (missing.length) {
    return { id, status: 'FAIL', message: `${rel} lacks ${missing.length} hook(s): ${head(missing.map((t) => `${t.event}/${t.matcher || '*'}/${t.id}`).join(', '))}` };
  }
  return { id, status: 'PASS', message: `${rel}: all ${hookTriples(pkg.value).length} package hooks are wired` };
}

function runScript(target, script, args = []) {
  const file = abs(target, `scripts/${script}`);
  if (!fs.existsSync(file)) return { missing: true };
  const r = spawnSync(process.execPath, [file, ...args], { cwd: target, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return { code: r.status, last: out[out.length - 1] ?? '' };
}

export function runDoctor(targetArg) {
  const target = path.resolve(targetArg);
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });

  const manifest = readManifest(target);
  const cfgFile = abs(target, CONFIG_REL);
  if (manifest.state === 'missing' && !fs.existsSync(cfgFile)) {
    add('installation', 'FAIL', `no ${MANIFEST_REL} and no ${CONFIG_REL} in ${target}: not an installation (run install)`);
    return checks;
  }

  // config
  let config = null;
  const cfg = fs.existsSync(cfgFile) ? readJson(cfgFile) : { ok: false, error: 'file is missing' };
  if (!cfg.ok) add('config', 'FAIL', `${CONFIG_REL}: ${cfg.error ?? 'unreadable'}`);
  else {
    config = mergedConfig(cfg.value);
    add('config', 'PASS', `${CONFIG_REL} parses (project ${config.projectName})`);
  }

  // manifest and version
  if (manifest.state === 'broken') add('manifest', 'FAIL', `${MANIFEST_REL} unreadable: ${manifest.error}`);
  else if (manifest.state === 'missing') add('manifest', 'WARN', `no ${MANIFEST_REL}: run upgrade to adopt this project`);
  else if (manifest.value.packageVersion !== packageVersion()) {
    add('manifest', 'WARN', `installed with ${manifest.value.packageVersion}, package is ${packageVersion()}: run upgrade`);
  } else add('manifest', 'PASS', `installed with package ${packageVersion()}`);

  // engine files and drift
  if (manifest.state === 'ok') {
    const missing = [];
    const drifted = [];
    for (const [rel, info] of Object.entries(manifest.value.files)) {
      if (info.class !== 'engine') continue;
      const file = abs(target, rel);
      if (!fs.existsSync(file)) { missing.push(rel); continue; }
      if (sha256(fs.readFileSync(file)) !== info.sha256) drifted.push(rel);
    }
    if (missing.length) add('engine-files', 'FAIL', `${missing.length} engine file(s) missing: ${head(missing.join(', '))}`);
    else add('engine-files', 'PASS', 'every engine file is present');
    if (drifted.length) add('drift', 'WARN', `${drifted.length} engine file(s) differ from the install: ${head(drifted.join(', '))}`);
    else add('drift', 'PASS', 'engine files match the manifest');
  }

  // pending .new files
  const pending = walkFiles(target, { skip: ['.git', 'node_modules'] }).filter((r) => r.endsWith('.new'));
  if (pending.length) add('pending-new', 'WARN', `${pending.length} .new file(s) waiting for review: ${head(pending.join(', '))}`);
  else add('pending-new', 'PASS', 'no .new files waiting');

  // wiring tables
  checks.push(wiringRow(target, 'settings-wiring', '.claude/settings.json', '.claude/settings.json'));
  checks.push(wiringRow(target, 'codex-wiring', '.codex/hooks.json', '.codex/hooks.json'));

  // git hooks path and executable bits
  const gp = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: target, encoding: 'utf8' });
  const inRepo = fs.existsSync(path.join(target, '.git'));
  if (!inRepo) add('hooks-path', 'WARN', 'not a git repository: core.hooksPath cannot be checked');
  else {
    const value = (gp.stdout ?? '').trim();
    if (!value) add('hooks-path', 'FAIL', 'core.hooksPath is empty: the git hooks do not run (git config core.hooksPath .githooks)');
    else if (value.replace(/\/$/, '') !== '.githooks') add('hooks-path', 'WARN', `core.hooksPath is "${value}", not .githooks`);
    else add('hooks-path', 'PASS', 'core.hooksPath = .githooks');
  }
  const hooksDir = abs(target, '.githooks');
  const hookFiles = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).filter((f) => fs.statSync(path.join(hooksDir, f)).isFile()) : [];
  if (process.platform === 'win32') add('hook-executable', 'PASS', 'skipped on Windows');
  else {
    const bad = hookFiles.filter((f) => (fs.statSync(path.join(hooksDir, f)).mode & 0o111) === 0);
    if (!hookFiles.length) add('hook-executable', 'FAIL', '.githooks has no hook files');
    else if (bad.length) add('hook-executable', 'FAIL', `not executable: ${bad.map((f) => `.githooks/${f}`).join(', ')}`);
    else add('hook-executable', 'PASS', `${hookFiles.length} git hook(s) executable`);
  }

  // directory links
  const linkProblems = [];
  const linkWarn = [];
  for (const [link, source] of [['.agents/skills', '.claude/skills'], ['.codex/hooks', '.claude/hooks']]) {
    const lp = abs(target, link);
    let real;
    try { real = fs.realpathSync(lp); } catch { linkWarn.push(`${link} is missing`); continue; }
    let want;
    try { want = fs.realpathSync(abs(target, source)); } catch { linkProblems.push(`${source} is missing`); continue; }
    if (real !== want) linkProblems.push(`${link} points to ${path.relative(target, real) || '.'}, not ${source}`);
  }
  if (linkProblems.length) add('links', 'FAIL', linkProblems.join('; '));
  else if (linkWarn.length) add('links', 'WARN', linkWarn.join('; '));
  else add('links', 'PASS', '.agents/skills and .codex/hooks resolve to the .claude directories');

  // node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18 ? 'PASS' : 'FAIL', `Node ${process.versions.node} (needs >= 18)`);

  // secret scanner
  const tool = config?.secretScan?.tool ?? 'gitleaks';
  const probe = spawnSync(tool, ['version'], { encoding: 'utf8' });
  const present = !(probe.error && probe.error.code === 'ENOENT');
  if (present) add('secret-scan', 'PASS', `${tool} is available`);
  else if (config?.secretScan?.failClosed ?? true) add('secret-scan', 'FAIL', `${tool} is not installed and secretScan.failClosed is on: pushes will be refused`);
  else add('secret-scan', 'WARN', `${tool} is not installed (secretScan.failClosed is off, pushes are not blocked)`);

  // checks owned by the installed scripts
  const mb = runScript(target, 'memory-bank-check.mjs');
  if (mb.missing) add('memory-bank', 'FAIL', 'scripts/memory-bank-check.mjs is missing');
  else add('memory-bank', mb.code === 0 ? 'PASS' : 'WARN', mb.code === 0 ? 'memory-bank-check passes' : `memory-bank-check: ${mb.last}`);
  const ri = runScript(target, 'rule-inventory.mjs', ['--strict']);
  if (ri.missing) add('rule-inventory', 'FAIL', 'scripts/rule-inventory.mjs is missing');
  else add('rule-inventory', ri.code === 0 ? 'PASS' : 'FAIL', ri.code === 0 ? 'rule-inventory --strict passes' : `rule-inventory --strict: ${ri.last}`);

  return checks;
}

export function doctor({ target, json = false, log = console.log }) {
  const checks = runDoctor(target);
  const ok = !checks.some((c) => c.status === 'FAIL');
  if (json) log(JSON.stringify({ ok, checks }, null, 2));
  else {
    for (const c of checks) log(`${c.status.padEnd(4)}  ${c.id.padEnd(16)} ${c.message}`);
    const n = (s) => checks.filter((c) => c.status === s).length;
    log(`${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail`);
  }
  return ok ? 0 : 1;
}
