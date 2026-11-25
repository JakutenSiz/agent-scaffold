#!/usr/bin/env node
// Secret shield — PreToolUse hook for Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell.
// Stops an agent from reading or overwriting secret files (.env, private keys, credential
// files) by accident. Accident level only: it is a name-based heuristic, not a sandbox.
//
// Config (scripts/lib/config.mjs): secrets.mode block|warn|off, secrets.protectedPaths (globs;
// a glob without "/" matches the basename), secrets.allow (globs that lift a match).
// Paths are resolved against the payload cwd; ".." is normalized and symlinks are followed
// (realpath), so a harmless-looking link to .env is still caught.
//
// Shell forms covered: direct arguments, redirections (< .env, > .env), bash/sh -c bodies,
// source/., $(...) and backticks, git show <ref>:<path>, wildcards (the token is turned into a
// glob and tried against the entries of ONE directory), quote splitting (.e"n"v).
//
// KNOWN GAPS (deliberate, accident-level): interpreter bodies (python -c / node -e), paths built
// from $VARIABLES (only a leading $HOME/~ is expanded), directory-level access (grep -r, tar,
// rsync, find), printenv/env, wildcards in a directory component, and Codex sessions (only the
// Bash tool is bridged there).
//
// NO escape prefix exists: the agent cannot type its way past this hook. Relaxing it is a human
// edit of secrets.* in the config.
//
// Fail-open: any parse/internal error -> silent exit 0. So does a project without config.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';
import { splitCommand } from './lib/shell-words.mjs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const ECHOES = new Set(['echo', 'printf']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5000;

const WILD = /[*?[]/;

/** Glob -> RegExp. `**` crosses "/", `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, end);
        if (body[0] === '!') body = '^' + body.slice(1);
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += ch.replace(/[.+^${}()|\\/]/g, (c) => (c === '/' ? '/' : `\\${c}`));
    }
  }
  return new RegExp(`^${re}$`);
}

function compile(globs) {
  const out = [];
  for (const g of Array.isArray(globs) ? globs : []) {
    if (typeof g !== 'string' || !g) continue;
    try {
      out.push({ slash: g.includes('/'), re: globToRegExp(g.replace(/^\.\//, '')) });
    } catch {
      // invalid glob — skip
    }
  }
  return out;
}

const matchesAny = (list, abs, rel) =>
  list.some((m) => (m.slash ? m.re.test(abs) || (rel !== null && m.re.test(rel)) : m.re.test(path.basename(abs))));

/** Builds { check(abs) } over compiled lists. check returns true when the path is protected. */
function makeMatcher(root, secrets) {
  const protectedList = compile(secrets.protectedPaths);
  const allowList = compile(secrets.allow);
  const relOf = (p) => {
    const r = path.relative(root, p);
    return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
  };
  const one = (p) => {
    const rel = relOf(p);
    const posix = p.split(path.sep).join('/');
    if (matchesAny(allowList, posix, rel)) return false;
    return matchesAny(protectedList, posix, rel);
  };
  return (abs) => {
    if (one(abs)) return true;
    let real = null;
    try {
      real = realpathSync(abs);
    } catch {
      try {
        real = path.join(realpathSync(path.dirname(abs)), path.basename(abs));
      } catch {
        real = null;
      }
    }
    return real !== null && real !== abs && one(real);
  };
}

function expandHome(p) {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  const m = /^\$(?:HOME|\{HOME\})(\/.*)?$/.exec(p);
  if (m) return path.join(home, m[1] ?? '');
  return p;
}

// Token -> candidate path strings (git ref:path, --opt=path, redirect prefix, backticks, backslashes).
function candidatesOf(token) {
  let t = token.replace(/^\d*[<>]+&?/, '').replace(/^`+|`+$/g, '');
  if (!t || t.startsWith('&')) return [];
  const out = new Set([t]);
  const add = (s) => s && out.add(s);
  if (t.includes('\\')) {
    add(t.replace(/\\/g, ''));
    add(t.replace(/\\/g, '/'));
  }
  for (const v of [...out]) {
    const eq = v.indexOf('=');
    if (eq > 0) add(v.slice(eq + 1));
    const colon = v.lastIndexOf(':');
    if (colon > 0) add(v.slice(colon + 1));
  }
  return [...out].filter((s) => s && !(s.startsWith('-') && !s.includes('=') && !s.includes(':')));
}

function matchingEntries(dirAbs, basenameGlob) {
  let re;
  try {
    re = globToRegExp(basenameGlob);
  } catch {
    return [];
  }
  let names;
  try {
    names = readdirSync(dirAbs);
  } catch {
    return [];
  }
  return names.slice(0, MAX_ENTRIES).filter((n) => re.test(n) && (basenameGlob.startsWith('.') || !n.startsWith('.')));
}

/** First protected hit for one candidate string, or null. `base` = directory it resolves against. */
function checkCandidate(cand, base, isProtected) {
  const expanded = expandHome(cand);
  const abs = path.resolve(base, expanded);
  if (isProtected(abs)) return abs;
  if (WILD.test(path.basename(expanded)) && !WILD.test(path.dirname(expanded))) {
    const dirAbs = path.dirname(abs);
    for (const name of matchingEntries(dirAbs, path.basename(expanded))) {
      const p = path.join(dirAbs, name);
      if (isProtected(p)) return p;
    }
  }
  return null;
}

function checkTokens(tokens, base, isProtected, depth, hits) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const head = path.basename(tokens[i] ?? '').replace(/\.exe$/i, '');
  const rest = tokens.slice(i + 1);

  if ((SHELLS.has(head) || head === 'eval') && depth < MAX_DEPTH) {
    let inner = null;
    if (head === 'eval') inner = rest.join(' ');
    else {
      const k = rest.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
      if (k !== -1 && rest[k + 1] !== undefined) inner = rest[k + 1];
    }
    if (inner) for (const seg of splitCommand(inner)) checkTokens(seg, base, isProtected, depth + 1, hits);
  }

  const echoOnly = ECHOES.has(head);
  let afterRedirect = false;
  for (const tok of tokens.slice(i)) {
    const bareRedirect = /^\d*[<>]+&?$/.test(tok);
    const hasPrefix = /^\d*[<>]/.test(tok);
    const isTarget = afterRedirect || hasPrefix;
    afterRedirect = bareRedirect;
    if (bareRedirect) continue;
    // command substitution hidden inside a quoted token: "$(cat .env)" / "`cat .env`"
    if (depth < MAX_DEPTH && (tok.includes('`') || tok.includes('$('))) {
      for (const m of tok.matchAll(/`([^`]*)`|\$\(([^)]*)\)/g)) {
        for (const seg of splitCommand(m[1] ?? m[2] ?? '')) checkTokens(seg, base, isProtected, depth + 1, hits);
      }
    }
    if (echoOnly && !isTarget && !/^`|`$/.test(tok)) continue;
    for (const c of candidatesOf(tok)) {
      const hit = checkCandidate(c, base, isProtected);
      if (hit) hits.push(hit);
    }
  }
}

/**
 * Protected paths a tool call touches.
 * @returns {string[]} absolute paths (empty = nothing protected)
 */
export function findProtected(tool, input, { cwd, root, secrets }) {
  const isProtected = makeMatcher(root, secrets);
  const hits = [];
  const ti = input ?? {};
  const fileLike = (p, base = cwd) => {
    if (typeof p !== 'string' || !p) return;
    for (const c of candidatesOf(p)) {
      const hit = checkCandidate(c, base, isProtected);
      if (hit) hits.push(hit);
    }
  };
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      fileLike(ti.file_path);
      fileLike(ti.notebook_path);
      break;
    case 'Grep':
    case 'Glob': {
      const base = typeof ti.path === 'string' && ti.path ? path.resolve(cwd, ti.path) : cwd;
      fileLike(ti.path);
      fileLike(ti.glob, base);
      fileLike(ti.pattern && tool === 'Glob' ? ti.pattern : null, base);
      break;
    }
    case 'Bash':
    case 'PowerShell':
      if (typeof ti.command === 'string') {
        for (const seg of splitCommand(ti.command)) checkTokens(seg, cwd, isProtected, 0, hits);
      }
      break;
    default:
      break;
  }
  return [...new Set(hits)];
}

function emit(fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  try {
    const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { root, config, found } = loadConfig(startDir);
    if (!found) process.exit(0);
    const secrets = config.secrets ?? {};
    const mode = secrets.mode ?? 'block';
    if (mode === 'off') process.exit(0);

    const hits = findProtected(input.tool_name, input.tool_input, { cwd: startDir, root, secrets });
    if (!hits.length) process.exit(0);

    const shown = hits
      .slice(0, 3)
      .map((p) => {
        const r = path.relative(root, p);
        return r.startsWith('..') ? p : r;
      })
      .join(', ');
    const text =
      `[secret-shield] ${input.tool_name} touches a protected secret path (${shown}). ` +
      'Secret files (.env, keys, credential files) are not for agents to read or overwrite: use the ' +
      '.env.example template, ask the human for the value, or have the human run the command. ' +
      'Protection is configured under secrets.* in agent-scaffold.config.json (human-edited).';
    if (mode === 'warn') emit({ additionalContext: text });
    else emit({ permissionDecision: 'deny', permissionDecisionReason: text });
  } catch {
    // fail-open
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
