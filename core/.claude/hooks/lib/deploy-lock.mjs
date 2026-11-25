// Enforces: R-43
// Deploy lock: while one process is pushing to a deploy branch of a repo, a second deploy push
// to the SAME repo is refused. There is no lock file; the evidence is the running processes
// (`ps` command lines + the working directory of each candidate via `lsof`).
// Pure part: candidates(psText, branches). Process scan: lockCheck(). Nothing in here throws.
// Skipped on Windows (no ps/lsof) and whenever anything cannot be measured (fail-open).
// Escape: put `DEPLOY_LOCK=skip` in front of the command (or export it).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const unquote = (t) => t.replace(/^["']|["']$/g, '');

// Parse `ps -axo pid=,command=` text into deploy-push candidates: [{ pid, target, c? }]. Only a
// process whose argv0 is git counts (see the match below).
// `c` is the `git -C <dir>` argument (the push runs in that directory). Deletion pushes
// (`--delete`, `:branch`) never deploy and are ignored.
export function candidates(psText, branches = [], excludePids = []) {
  const result = [];
  if (!branches.length) return result;
  for (const line of String(psText || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (excludePids.includes(pid)) continue;
    // argv0 must be git (`git` or `<path>/git`), then optional `-C <dir>` / `-c k=v` options, then push.
    // A wrapper (`sh -c "git push ..."`) or a tool that merely mentions the text is not a push.
    const pm = m[2].match(/^(?:\S*\/)?git((?:\s+-[Cc]\s+\S+)*)\s+push\b([^&|;]*)/);
    if (!pm) continue;
    const dirs = [...pm[1].matchAll(/-C\s+(\S+)/g)];
    const c = unquote(dirs.length ? dirs[dirs.length - 1][1] : '');
    const tokens = pm[2].trim().split(/\s+/).map(unquote).filter(Boolean);
    if (tokens.includes('--delete') || tokens.includes('-d')) continue;
    const refs = tokens.filter((t) => !t.startsWith('-')).slice(1); // first positional = remote
    let target = '';
    for (const t of refs) {
      if (t.startsWith(':')) continue;
      const dst = t.includes(':') ? t.split(':').pop() : t;
      if (branches.includes(dst)) {
        target = dst;
        break;
      }
    }
    if (target) result.push(c ? { pid, target, c } : { pid, target });
  }
  return result;
}

// `ps -o etime=` output ([[dd-]hh:]mm:ss) -> whole minutes.
export function elapsedMinutes(etime) {
  const p = String(etime).trim().split(/[-:]/).map(Number).reverse(); // [s, m, h, d]
  if (p.some((n) => Number.isNaN(n))) return null;
  return Math.floor(((p[3] || 0) * 86400 + (p[2] || 0) * 3600 + (p[1] || 0) * 60 + (p[0] || 0)) / 60);
}

const sh = (command, args, opts = {}) =>
  execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function commonDir(cwd) {
  const g = sh('git', ['rev-parse', '--git-common-dir'], { cwd }).trim();
  // realpath: lsof reports /private/var/... while the caller may hold /var/... (macOS symlink)
  return realpathSync(path.resolve(cwd, g));
}

// Returns null (no lock / skipped) or the deny reason (string). Never throws.
export function lockCheck(dir, { cmd = '', env = process.env, branches = [] } = {}) {
  try {
    if (process.platform === 'win32') return null;
    if (env.DEPLOY_LOCK === 'skip' || /(?:^|\s)DEPLOY_LOCK=skip(?:\s|$)/.test(cmd)) return null;
    let psText;
    try {
      psText = sh('ps', ['-axo', 'pid=,command=']);
    } catch {
      return null; // ps unavailable - pass silently
    }
    const list = candidates(psText, branches, [process.pid, process.ppid]);
    if (!list.length) return null;
    let mine;
    try {
      mine = commonDir(dir);
    } catch {
      return null; // our own repo could not be resolved - skip
    }
    for (const a of list) {
      let sameRepo = true; // a candidate whose cwd cannot be found counts as the same repo
      try {
        const out = sh('lsof', ['-a', '-p', String(a.pid), '-d', 'cwd', '-Fn']);
        const n = out.split('\n').find((l) => l.startsWith('n'));
        if (n && n.length > 1) {
          const cwd = a.c ? path.resolve(n.slice(1), a.c) : n.slice(1);
          try {
            sameRepo = commonDir(cwd) === mine;
          } catch {
            sameRepo = false; // cwd exists but is not a git repository - unrelated job
          }
        }
      } catch {
        // lsof missing / timed out / process gone - sameRepo stays true
      }
      if (!sameRepo) continue;
      let minutes = '?';
      try {
        const e = elapsedMinutes(sh('ps', ['-o', 'etime=', '-p', String(a.pid)]));
        if (e !== null) minutes = String(e);
      } catch {}
      return (
        `DEPLOY LOCK: another deploy push is running in this repo (pid ${a.pid}, ${minutes} min, target ${a.target}). ` +
        'Wait for it to finish and let that session verify the deploy result. To pass on purpose, prefix the command with DEPLOY_LOCK=skip.'
      );
    }
    return null;
  } catch {
    return null;
  }
}
