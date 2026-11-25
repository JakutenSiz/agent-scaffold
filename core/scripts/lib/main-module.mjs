// "Is this file being run directly?" check that survives symlinked paths.
// The usual `import.meta.url === pathToFileURL(process.argv[1]).href` comparison silently
// returns false when the path goes through a symlink (macOS: /var -> /private/var,
// /tmp -> /private/tmp), so a script run from such a directory does nothing and exits 0.
// Both sides are resolved with realpath before comparing.
// Usage: if (isMainModule(import.meta.url)) main();
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(argv1); }
  catch { return false; }
}
