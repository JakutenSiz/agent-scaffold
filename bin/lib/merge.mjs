// Additive merges for the files a project and the package both write to:
// .claude/settings.json, .codex/hooks.json, .gitignore, .gitattributes.
// Nothing here ever removes or rewrites what the project already has.

/** The script file name inside a hook command line (`node ".../git-shield.mjs" --x` -> `git-shield.mjs`). */
export const scriptId = (command) => {
  const m = /([A-Za-z0-9_.-]+\.mjs)/.exec(command ?? '');
  return m ? m[1] : (command ?? '');
};

/** Every hook of a settings-shaped file as { event, matcher, id, key }. Identity = (event, matcher, script file name). */
export function hookTriples(json) {
  const out = [];
  for (const [event, groups] of Object.entries(json?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        const matcher = group.matcher ?? '';
        const id = scriptId(hook.command);
        out.push({ event, matcher, id, key: `${event}|${matcher}|${id}` });
      }
    }
  }
  return out;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Merges the package's hooks file into the project's. Rules:
 * - a package group is matched to a project group of the SAME matcher that already holds at least one
 *   of its scripts; the missing scripts are appended to that group;
 * - when no such group exists the package group is added as a NEW group, so two package groups that
 *   share a matcher stay two groups;
 * - permission lists are unioned (project entries first); every other key is kept, and a package key
 *   the project lacks is added.
 * Returns { value, added: [hook keys], allowAdded: n }. A second run adds nothing.
 */
export function mergeHooksConfig(existing, pkg) {
  const value = clone(existing ?? {});
  const added = [];
  let allowAdded = 0;

  for (const [key, pkgVal] of Object.entries(pkg ?? {})) {
    if (key === 'hooks' || key === 'permissions') continue;
    if (!(key in value)) value[key] = clone(pkgVal);
  }

  if (pkg?.permissions) {
    value.permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
    for (const [k, list] of Object.entries(pkg.permissions)) {
      if (!Array.isArray(list)) {
        if (!(k in value.permissions)) value.permissions[k] = clone(list);
        continue;
      }
      const have = Array.isArray(value.permissions[k]) ? value.permissions[k] : [];
      for (const entry of list) {
        if (!have.includes(entry)) {
          have.push(entry);
          if (k === 'allow') allowAdded += 1;
        }
      }
      value.permissions[k] = have;
    }
  }

  for (const [event, pkgGroups] of Object.entries(pkg?.hooks ?? {})) {
    if (!value.hooks || typeof value.hooks !== 'object') value.hooks = {};
    if (!Array.isArray(value.hooks[event])) value.hooks[event] = [];
    const groups = value.hooks[event];
    for (const pkgGroup of pkgGroups ?? []) {
      const matcher = pkgGroup.matcher ?? '';
      const pkgIds = new Set((pkgGroup.hooks ?? []).map((h) => scriptId(h.command)));
      const target = groups.find((g) => (g.matcher ?? '') === matcher && (g.hooks ?? []).some((h) => pkgIds.has(scriptId(h.command))));
      if (!target) {
        groups.push(clone(pkgGroup));
        for (const id of pkgIds) added.push(`${event}|${matcher}|${id}`);
        continue;
      }
      target.hooks = target.hooks ?? [];
      const present = new Set(target.hooks.map((h) => scriptId(h.command)));
      for (const hook of pkgGroup.hooks ?? []) {
        const id = scriptId(hook.command);
        if (present.has(id)) continue;
        target.hooks.push(clone(hook));
        present.add(id);
        added.push(`${event}|${matcher}|${id}`);
      }
    }
  }
  return { value, added, allowAdded };
}

export const GITIGNORE_BEGIN = '# >>> agent-scaffold >>>';
export const GITIGNORE_END = '# <<< agent-scaffold <<<';

/** The snippet's own lines without its leading blank and header comment, wrapped in the marker pair. */
export function gitignoreBlock(snippetText) {
  const lines = snippetText.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^# --- agent-scaffold/.test(l));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return `${GITIGNORE_BEGIN}\n${lines.join('\n')}\n${GITIGNORE_END}\n`;
}

/** Adds the marked block, or refreshes it in place when it is already there. */
export function mergeGitignore(existingText, snippetText) {
  const block = gitignoreBlock(snippetText);
  if (existingText === null || existingText === undefined) return block;
  const text = existingText.replace(/\r\n/g, '\n');
  const start = text.indexOf(GITIGNORE_BEGIN);
  const end = start === -1 ? -1 : text.indexOf(GITIGNORE_END, start);
  if (start !== -1 && end !== -1) {
    const after = text.indexOf('\n', end);
    return `${text.slice(0, start)}${block}${after === -1 ? '' : text.slice(after + 1)}`;
  }
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${base === '' ? '' : '\n'}${block}`;
}

/** Appends the package lines the file does not have yet (exact line match); never reorders or edits. */
export function mergeGitattributes(existingText, pkgText) {
  const pkgLines = pkgText.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (existingText === null || existingText === undefined) return `${pkgLines.join('\n')}\n`;
  const text = existingText.replace(/\r\n/g, '\n');
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = pkgLines.filter((l) => !have.has(l.trim()));
  if (!missing.length) return existingText;
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${missing.join('\n')}\n`;
}

/**
 * Merge for one merge-class file. `rel` is the project path. Returns { text } with the new content,
 * or { conflict: reason } when the project file cannot be merged safely (it is then left alone).
 */
export function mergeFile(rel, existingBuf, pkgBuf) {
  const existing = existingBuf === null ? null : existingBuf.toString('utf8');
  const pkg = pkgBuf.toString('utf8');
  if (rel === '.gitignore') return { text: mergeGitignore(existing, pkg) };
  if (rel === '.gitattributes') return { text: mergeGitattributes(existing, pkg) };
  // JSON hook files
  let existingJson = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      existingJson = JSON.parse(existing);
    } catch (error) {
      return { conflict: `not valid JSON (${error.message})` };
    }
    if (existingJson === null || typeof existingJson !== 'object' || Array.isArray(existingJson)) return { conflict: 'not a JSON object' };
  }
  const merged = mergeHooksConfig(existingJson, JSON.parse(pkg));
  const text = `${JSON.stringify(merged.value, null, 2)}\n`;
  // Untouched when nothing was added: keep the user's own formatting byte for byte.
  if (existing !== null && merged.added.length === 0 && merged.allowAdded === 0 && JSON.stringify(merged.value) === JSON.stringify(existingJson)) {
    return { text: existing };
  }
  return { text, added: merged.added, allowAdded: merged.allowAdded };
}
