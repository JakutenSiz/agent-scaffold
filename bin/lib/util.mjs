// Small shared helpers for the agent-scaffold CLI: hashing, file walking, glob matching, JSON reading.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORE = path.join(PKG_ROOT, 'core');

export const toPosix = (p) => p.split(path.sep).join('/');
export const fromPosix = (p) => p.split('/').join(path.sep);

/** Drops every CR that directly precedes an LF, so a CRLF checkout hashes like the LF original. */
export function normalizeLF(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = Buffer.alloc(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x0d && src[i + 1] === 0x0a) continue;
    out[n++] = src[i];
  }
  return out.subarray(0, n);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(normalizeLF(buf)).digest('hex');

/** Posix-relative paths of every regular file under root (symlinks and OS noise skipped), sorted. */
export function walkFiles(root, { skip = [] } = {}) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || skip.includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(toPosix(path.relative(root, abs)));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

export function readIfExists(abs) {
  try {
    return fs.readFileSync(abs);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function readJson(abs) {
  const buf = readIfExists(abs);
  if (buf === null) return { ok: false, missing: true, error: 'file not found' };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')), bytes: buf };
  } catch (error) {
    return { ok: false, missing: false, error: error.message };
  }
}

export function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

const SPECIALS = '.+^$()|[]\\{}?';

/** Glob (`**`, `*`) to an anchored RegExp over posix paths. `**` + `/` also matches zero directories. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (SPECIALS.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** Template fill: replaces {{KEY}}; a placeholder with no value is an error, never silently left. */
export function fill(text, map) {
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in map ? map[k] : m));
  const left = out.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) throw new Error(`unfilled placeholders: ${left}`);
  return out;
}

export const packageVersion = () => JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
