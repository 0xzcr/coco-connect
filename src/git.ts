// Everything we learn from git: which repo this is, the branch, and which files have
// uncommitted changes. All calls are async with a timeout, so a slow `git status` on a
// huge repo never freezes the connection to teammates.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realPath } from './paths.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

// Above this we stop listing files: the teammate's agent doesn't need 50,000 paths, and the
// state message has to stay small.
export const MAX_REPORTED_FILES = 2000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
    windowsHide: true,
  });
  return stdout;
}

// The top folder of the git repo containing `dir`, with symlinks resolved.
// Null if `dir` isn't in a repo or git isn't installed.
export async function findRepoRoot(dir: string): Promise<string | null> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    // The same resolving the edit check applies to file paths, so the two always compare equal.
    // If the system can't resolve it (some network and virtual drives), we keep git's path
    // rather than acting as if there were no repo.
    return realPath(root);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Is the teammate working on the same project?
// ---------------------------------------------------------------------------

export interface RepoIdentity {
  roots: string[];  // hashes of the first commit(s); the same in every clone of a project
  remote: string;   // the origin URL in a comparable form, e.g. "github.com/0xzcr/coco-connect"
}

export async function repoIdentity(root: string): Promise<RepoIdentity> {
  let roots: string[] = [];
  try {
    const output = await git(root, ['rev-list', '--max-parents=0', 'HEAD']);
    roots = output.split('\n').filter((line) => line !== '').sort();
  } catch {
    // No commits yet.
  }

  let remote = '';
  try {
    remote = normalizeRemote(await git(root, ['remote', 'get-url', 'origin']));
  } catch {
    // No origin remote.
  }

  return { roots, remote };
}

// Turns the many spellings of one remote into one form:
//   git@github.com:0xzcr/coco-connect.git        -> github.com/0xzcr/coco-connect
//   https://user:token@GitHub.com/0xzcr/coco-connect/ -> github.com/0xzcr/coco-connect
//   ssh://git@github.com:22/0xzcr/coco-connect   -> github.com/0xzcr/coco-connect
export function normalizeRemote(raw: string): string {
  let url = raw.trim();
  if (url === '') {
    return '';
  }

  // Drop the scheme and any user:password@ in front of the host.
  url = url.replace(/^[a-z+]+:\/\//i, '');
  url = url.replace(/^[^@/]+@/, '');

  // scp-style "host:owner/repo" becomes "host/owner/repo". A ":22" port is dropped too.
  url = url.replace(/^([^/:]+):(\d+\/)?/, '$1/');

  url = url.replace(/\.git\/?$/, '').replace(/\/+$/, '');

  // Host names ignore case, so lowercase the host. The path is kept as written.
  const slash = url.indexOf('/');
  if (slash === -1) {
    return url.toLowerCase();
  }
  return url.slice(0, slash).toLowerCase() + url.slice(slash);
}

// Two clones are the same project if they share a first commit, or the same origin.
// The origin check covers shallow clones (`--depth 1`), whose "first" commit is wherever the
// clone was cut off rather than the project's real first commit.
export function sameRepo(a: RepoIdentity, b: RepoIdentity): boolean {
  const theirRoots = new Set(b.roots);
  const sharesRoot = a.roots.some((root) => theirRoots.has(root));
  const sharesRemote = a.remote !== '' && a.remote === b.remote;
  return sharesRoot || sharesRemote;
}

// ---------------------------------------------------------------------------
// Branch and changed files
// ---------------------------------------------------------------------------

export interface RepoSnapshot {
  branch: string;
  files: string[];          // changed files to tell teammates about, relative to the repo root
  unpushed: string[];       // changed in local commits no remote has yet; never repeats `files`
  lineEndingOnly: string[]; // changed only in line endings (CRLF vs LF); left out of `files`
  truncated: boolean;       // true if `files` and `unpushed` together had more than MAX_REPORTED_FILES
}

export async function currentBranch(root: string): Promise<string> {
  try {
    const branch = (await git(root, ['branch', '--show-current'])).trim();
    if (branch !== '') {
      return branch;
    }
    // Detached HEAD, e.g. in the middle of a rebase.
    const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    return `detached at ${commit}`;
  } catch {
    return '';
  }
}

export interface StatusEntry {
  path: string;
  untracked: boolean;
}

// Parses `git status --porcelain=v1 -z`. With -z, paths are raw (no quoting of spaces or
// unicode), each entry ends with a NUL, and a rename or copy is followed by an extra entry
// holding the old path, which we skip.
//   " M src/a.ts\0R  new name.ts\0old name.ts\0?? notes.txt\0"
export function parseStatus(output: string): StatusEntry[] {
  const entries = output.split('\0');
  const result: StatusEntry[] = [];

  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    index += 1;

    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    result.push({ path: entry.slice(3), untracked: status === '??' });

    const renamedOrCopied = status[0] === 'R' || status[0] === 'C';
    if (renamedOrCopied) {
      index += 1;
    }
  }

  return result;
}

// Tracked files whose changes are more than line endings. On Windows, a wrong core.autocrlf
// setting can make every file look modified; without this filter one teammate's laptop
// would block everybody from the whole repo.
async function filesWithRealChanges(root: string): Promise<Set<string> | null> {
  try {
    const output = await git(root, ['diff', 'HEAD', '--name-only', '--ignore-cr-at-eol', '-z']);
    return new Set(output.split('\0').filter((path) => path !== ''));
  } catch {
    // No commits yet, so there is nothing to diff against. Report everything.
    return null;
  }
}

// Files changed in commits on this branch that no remote has yet. A teammate who commits is
// still about to conflict with you; only once they push can you pull their work first.
// Without any remote nothing can be pushed, and every commit would count, so the list is empty.
async function unpushedFiles(root: string): Promise<string[]> {
  try {
    const remotes = await git(root, ['for-each-ref', '--count=1', '--format=x', 'refs/remotes']);
    if (remotes.trim() === '') {
      return [];
    }
    // One path per changed file per commit, NUL-separated, so the same path can repeat.
    const output = await git(root, ['log', 'HEAD', '--not', '--remotes', '--name-only', '--format=', '-z']);
    const paths = new Set(output.split('\0').filter((path) => path !== ''));
    return [...paths].sort();
  } catch {
    // No commits yet.
    return [];
  }
}

export async function snapshot(root: string): Promise<RepoSnapshot> {
  // Independent git runs, started together so a refresh costs one git wait, not four.
  const [branch, status, realChanges, committed] = await Promise.all([
    currentBranch(root),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => null),
    filesWithRealChanges(root),
    unpushedFiles(root),
  ]);
  if (status === null) {
    return { branch, files: [], unpushed: [], lineEndingOnly: [], truncated: false };
  }
  const entries = parseStatus(status);
  const files: string[] = [];
  const lineEndingOnly: string[] = [];

  for (const entry of entries) {
    const keep = entry.untracked || realChanges === null || realChanges.has(entry.path);
    if (keep) {
      files.push(entry.path);
    } else {
      lineEndingOnly.push(entry.path);
    }
  }

  files.sort();
  const shownFiles = files.slice(0, MAX_REPORTED_FILES);

  // A file with both uncommitted and unpushed changes is listed once, under `files`.
  const uncommitted = new Set(files);
  const unpushed = committed.filter((path) => !uncommitted.has(path));
  const space = MAX_REPORTED_FILES - shownFiles.length;

  return {
    branch,
    files: shownFiles,
    unpushed: unpushed.slice(0, space),
    lineEndingOnly,
    truncated: files.length + unpushed.length > MAX_REPORTED_FILES,
  };
}

// The name the user set in git, used as their default display name.
export async function gitUserName(dir: string): Promise<string> {
  try {
    return (await git(dir, ['config', 'user.name'])).trim();
  } catch {
    return '';
  }
}
