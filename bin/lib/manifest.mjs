// The install manifest: .agent-scaffold/manifest.json = { packageVersion, schemaVersion, files: { rel: { sha256, class } } }.
// No timestamps and no absolute paths, so the file is deterministic and safe to commit.
import fs from 'node:fs';
import path from 'node:path';
import { fromPosix, packageVersion } from './util.mjs';

export const MANIFEST_REL = '.agent-scaffold/manifest.json';
export const SCHEMA_VERSION = 1;

/** { state: 'ok', value } | { state: 'missing' } | { state: 'broken', error } */
export function readManifest(target) {
  const abs = path.join(target, fromPosix(MANIFEST_REL));
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'missing' };
    return { state: 'broken', error: error.message };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || typeof value.files !== 'object' || value.files === null) {
      return { state: 'broken', error: 'no "files" table' };
    }
    return { state: 'ok', value };
  } catch (error) {
    return { state: 'broken', error: error.message };
  }
}

export function manifestText(files) {
  const sorted = {};
  for (const rel of Object.keys(files).sort()) sorted[rel] = { sha256: files[rel].sha256, class: files[rel].class };
  return `${JSON.stringify({ packageVersion: packageVersion(), schemaVersion: SCHEMA_VERSION, files: sorted }, null, 2)}\n`;
}
