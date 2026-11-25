// Quote-aware shell tokenizer shared by hooks (copied from push-guard.mjs so that hook stays
// untouched; keep the two in step if one changes).

/** Quote-aware split of a shell command line into segments of tokens. */
export function splitCommand(cmd) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = '';
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      endToken();
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      endSegment();
    } else {
      cur += ch;
      has = true;
    }
  }
  endSegment();
  return segments;
}
