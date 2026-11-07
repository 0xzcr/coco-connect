// Comparing file paths between laptops. The hook hands us whatever path the agent used
// ("C:\repo\src\db.py", "/Users/me/repo/./src/db.py", a symlinked folder...), while a
// teammate's git reports "src/db.py". These helpers put both into git's form.

import fs from 'node:fs';
import path from 'node:path';

// Resolves symlinks in the deepest folder of `file` that exists, so macOS paths like
// /tmp/x and /private/tmp/x compare equal. The file itself, and even its folder, may not exist
// yet when the agent is about to create them.
export function realPath(file: string): string {
  const missingParts: string[] = [];
  let existing = path.resolve(file);

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      // Reached the filesystem root without finding anything that exists.
      return path.resolve(file);
    }
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(fs.realpathSync(existing), ...missingParts);
  } catch {
    return path.resolve(file);
  }
}

// Turns a path into the form git uses: relative to the repo root, with forward slashes.
// Returns null if the file is outside the repo (including on another drive on Windows).
export function repoRelative(repoRoot: string, file: string, paths: typeof path = path): string | null {
  const relative = paths.relative(repoRoot, paths.resolve(repoRoot, file));

  // "..foo" is a legitimate file name, so only ".." as a whole path segment means "outside".
  const goesUp = relative === '..' || relative.startsWith(`..${paths.sep}`);
  const outside = relative === '' || goesUp || paths.isAbsolute(relative);
  if (outside) {
    return null;
  }
  return relative.split(paths.sep).join('/');
}

// Windows and macOS file systems ignore letter case by default, so on them "Auth.ts" and
// "auth.ts" are the same file. Linux file systems don't.
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const ignoresCase = platform === 'win32' || platform === 'darwin';
  if (ignoresCase) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
