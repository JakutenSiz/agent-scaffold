// Shared plan/execute core of `install` and `upgrade`. The plan is pure (it only reads the project),
// so --dry-run is the same code path minus execute().
//
// Decision table per file class, comparing the project file (disk), the manifest hash (what the
// last install wrote) and the package file (pkg):
//   engine  missing or == pkg -> write/keep | disk == manifest -> update in place | otherwise -> <file>.new
//   seed    missing -> write | equal -> keep | different: install writes <file>.new, upgrade never touches it
//   hybrid  missing -> write | equal -> keep | different -> always <file>.new
//   merge   additive merge in place (hooks files, .gitignore, .gitattributes); unmergeable -> <file>.new
import fs from 'node:fs';
import path from 'node:path';
import { fromPosix, readIfExists, sha256 } from './util.mjs';
import { mergeFile } from './merge.mjs';
import { MANIFEST_REL, manifestText } from './manifest.mjs';

const abs = (target, rel) => path.join(target, fromPosix(rel));
const wantsExec = (rel) => rel.startsWith('.githooks/') || rel.endsWith('.sh');

/**
 * @param {{target:string, entries:Array<{rel:string,cls:string,content:Buffer}>, oldFiles:Object|null, mode:'install'|'upgrade'}} args
 * oldFiles: the manifest's file table, or null when there is no manifest (install, or an upgrade that adopts).
 */
export function planEntries({ target, entries, oldFiles, mode }) {
  const files = { ...(oldFiles ?? {}) };
  const actions = [];
  const writes = [];
  const chmods = [];

  for (const { rel, cls, content } of entries) {
    const disk = readIfExists(abs(target, rel));
    const pkgSha = sha256(content);
    const diskSha = disk === null ? null : sha256(disk);
    const old = oldFiles?.[rel];
    const record = () => { files[rel] = { sha256: pkgSha, class: cls }; };
    const act = (kind, extra = {}) => actions.push({ rel, cls, kind, ...extra });
    const writeNew = (kind = 'new', note) => {
      writes.push({ rel: `${rel}.new`, content });
      act(kind, { newRel: `${rel}.new`, note });
    };
    const write = (kind, data, extra) => {
      writes.push({ rel, content: data });
      if (wantsExec(rel)) chmods.push(rel);
      act(kind, extra);
    };
    const keep = () => {
      if (wantsExec(rel) && disk !== null) chmods.push(rel);
      act('same');
    };

    if (cls === 'merge') {
      const merged = mergeFile(rel, disk, content);
      if (merged.conflict) { writeNew('new', merged.conflict); continue; }
      const mergedBuf = Buffer.from(merged.text);
      if (disk === null) write('created', mergedBuf);
      else if (sha256(mergedBuf) === diskSha) act('same');
      else write('merged', mergedBuf, { added: merged.added?.length ?? 0 });
      record();
      continue;
    }

    if (cls === 'seed') {
      if (disk === null) {
        if (old && mode === 'upgrade') { act('kept', { note: 'missing, seed not recreated' }); continue; }
        write('created', content); record();
      } else if (diskSha === pkgSha) { keep(); record(); }
      else if (mode === 'install') writeNew('new');
      else act('kept');
      continue;
    }

    if (cls === 'hybrid') {
      if (disk === null) { write('created', content); record(); }
      else if (diskSha === pkgSha) { keep(); record(); }
      else writeNew('new');
      continue;
    }

    // engine
    if (disk === null) { write(old ? 'restored' : 'created', content); record(); }
    else if (diskSha === pkgSha) { keep(); record(); }
    else if (old && diskSha === old.sha256) { write('updated', content); record(); }
    else writeNew('new');
  }

  // Files the previous install tracked that the package no longer has: reported, never deleted.
  const wanted = new Set(entries.map((e) => e.rel));
  const retired = [];
  for (const [rel, info] of Object.entries(oldFiles ?? {})) {
    if (wanted.has(rel)) continue;
    delete files[rel];
    if (info.class === 'engine') retired.push(rel);
  }
  return { actions, writes, chmods, files, retired };
}

/** Applies a plan to disk: files, executable bits, manifest. */
export function executePlan(target, plan) {
  for (const w of plan.writes) {
    const p = abs(target, w.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, w.content);
  }
  if (process.platform !== 'win32') {
    for (const rel of new Set(plan.chmods)) {
      const p = abs(target, rel);
      try {
        const mode = fs.statSync(p).mode;
        if ((mode & 0o111) !== 0o111) fs.chmodSync(p, mode | 0o755);
      } catch { /* a vanished file is not worth failing the run */ }
    }
  }
  const manifestPath = abs(target, MANIFEST_REL);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifestText(plan.files));
}

const KIND_LABEL = {
  created: 'created', restored: 'restored', updated: 'updated in place', merged: 'merged', same: 'unchanged', kept: 'kept (yours)', new: '.new written',
};

/** Output lines for a plan: counts, then the .new list and the retired list. */
export function describePlan(plan, { dry }) {
  const lines = [];
  const counts = {};
  for (const a of plan.actions) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const verb = dry ? 'would be ' : '';
  const summary = Object.keys(KIND_LABEL).filter((k) => counts[k]).map((k) => `${counts[k]} ${verb}${KIND_LABEL[k]}`);
  lines.push(`files: ${summary.join(', ') || 'nothing to do'}`);
  const merged = plan.actions.filter((a) => a.kind === 'merged');
  for (const m of merged) lines.push(`  merged ${m.rel}${m.added ? ` (+${m.added} hook(s) added)` : ''}`);
  const news = plan.actions.filter((a) => a.newRel);
  if (news.length) {
    lines.push(`review these ${news.length} file(s), your version was not overwritten:`);
    for (const n of news) lines.push(`  ${n.newRel}${n.note ? `  (${n.note})` : ''}`);
  }
  if (plan.retired.length) {
    lines.push(`engine files the package no longer ships (left in place, delete them yourself if unused):`);
    for (const rel of plan.retired) lines.push(`  ${rel}`);
  }
  return lines;
}
