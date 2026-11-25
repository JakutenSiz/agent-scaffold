// Enforces: R-01
// Shell command classifier used by read-guard.mjs to tell "reading" from "editing" intent.
// Pure functions in their own module so both the hook and the tests can import them.
//
// The approach is deliberately COARSE: this is not a shell parser, only a classifier that
// separates read intent (cat / grep / sed -n ...) from in-place edit intent (sed -i,
// perl -pi, node -e with a file write) accurately enough to feed a counter.

const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'awk',
  'get-content',
  'gc',
  'select-string',
  'sls',
  'type',
]);

/**
 * Drops heredoc bodies (`<<'EOF'`, `<<EOF`, `<<-EOF`): every line up to the terminator
 * is removed, the part of the opening line BEFORE the heredoc marker is kept.
 */
export function stripHeredocBodies(cmd) {
  const lines = String(cmd).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<-?\s*(['"]?)(\w+)\1/);
    if (m) {
      out.push(line.slice(0, m.index));
      const terminator = m[2];
      i++;
      while (i < lines.length && lines[i].trim() !== terminator) i++;
      i++; // skip the terminator line too
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

/**
 * Empties single/double quoted contents so an example such as `echo "cat x"` does not
 * look like a command name.
 */
export function blankQuotedContent(cmd) {
  return String(cmd)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

function firstPipelineSegment(pipeline) {
  return pipeline.split('|')[0];
}

function splitSequences(cmd) {
  return String(cmd).split(/&&|\|\||;|\n/);
}

// Splits a segment into words and drops leading VAR=value prefixes.
function wordsOf(segment) {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
  return parts.slice(i);
}

function segmentIsRead(segment) {
  const parts = wordsOf(segment);
  if (parts.length === 0) return false;
  const first = parts[0].toLowerCase();

  if (first === 'git') {
    const sub = (parts[1] || '').toLowerCase();
    if (sub === 'grep') return true;
    if (sub === 'show') {
      const arg = parts[2] || '';
      return arg.includes(':');
    }
    return false;
  }

  if (first === 'sed') {
    const hasN = parts.some((p) => p === '-n');
    const hasI = parts.some((p) => p === '-i' || p.startsWith('-i'));
    return hasN && !hasI;
  }

  if (first === 'cat') {
    if (segment.includes('>')) return false;
    return true;
  }

  return READ_COMMANDS.has(first);
}

/**
 * Says whether the command has read intent (cat / grep / sed -n ...).
 * @param {string} cmd
 * @returns {boolean}
 */
export function isReadCommand(cmd) {
  if (!cmd) return false;
  const clean = blankQuotedContent(stripHeredocBodies(cmd));
  for (const pl of splitSequences(clean)) {
    if (segmentIsRead(firstPipelineSegment(pl))) return true;
  }
  return false;
}

/**
 * Says whether the command edits a file IN PLACE (sed -i, perl -pi, node -e with
 * writeFileSync). Quoted content is intentionally left intact, because the
 * writeFileSync inside `node -e '...'` has to stay visible.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isEditCommand(cmd) {
  if (!cmd) return false;
  const clean = stripHeredocBodies(cmd);
  for (const pl of splitSequences(clean)) {
    const segment = firstPipelineSegment(pl);
    const parts = wordsOf(segment);
    if (parts.length === 0) continue;
    const first = parts[0].toLowerCase();
    if (first === 'sed' && parts.some((p) => p === '-i' || p.startsWith('-i'))) return true;
    if (first === 'perl' && parts.some((p) => p === '-pi' || p.startsWith('-pi'))) return true;
    if (first === 'node' && parts.some((p) => p === '-e') && /writefilesync/i.test(segment)) {
      return true;
    }
  }
  return false;
}
