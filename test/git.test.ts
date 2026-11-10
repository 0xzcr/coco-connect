import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findRepoRoot, normalizeRemote, parseStatus, repoIdentity, sameRepo, snapshot } from '../src/git.ts';
import { realPath, repoRelative, samePath } from '../src/paths.ts';
import { cloneOf, git, makeOrigin, tempDir } from './helpers.ts';

test('status parsing handles spaces, unicode and renames', () => {
  const output = ' M src/a b.ts\0R  new name é.txt\0old.txt\0?? notes.txt\0A  added.ts\0';
  assert.deepEqual(parseStatus(output), [
    { path: 'src/a b.ts', untracked: false },
    { path: 'new name é.txt', untracked: false },
    { path: 'notes.txt', untracked: true },
    { path: 'added.ts', untracked: false },
  ]);
  assert.deepEqual(parseStatus(''), []);
});

test('snapshot reports real changes and sets line-ending-only changes aside', () => {
  const repo = makeOrigin();
  fs.writeFileSync(path.join(repo, 'crlf.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(repo, 'real.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'more']);

  fs.writeFileSync(path.join(repo, 'crlf.txt'), 'a\r\nb\r\n');
  fs.writeFileSync(path.join(repo, 'real.txt'), 'y\n');
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'n');
  git(repo, ['mv', 'README.md', 'docs.md']);

  return snapshot(repo).then((result) => {
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.files, ['docs.md', 'new file.txt', 'real.txt']);
    assert.deepEqual(result.lineEndingOnly, ['crlf.txt']);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.unpushed, [], 'with no remote, nothing counts as unpushed');
  });
});

test('snapshot lists files in commits no remote has yet, until they are pushed', async () => {
  const repo = cloneOf(makeOrigin());
  fs.writeFileSync(path.join(repo, 'auth.ts'), 'a');
  fs.writeFileSync(path.join(repo, 'both.ts'), 'b');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'one']);
  fs.writeFileSync(path.join(repo, 'auth.ts'), 'a2');
  git(repo, ['commit', '-qam', 'two']);
  fs.writeFileSync(path.join(repo, 'both.ts'), 'b2');

  let result = await snapshot(repo);
  assert.deepEqual(result.files, ['both.ts']);
  assert.deepEqual(result.unpushed, ['auth.ts'], 'listed once, and never repeating an uncommitted file');

  git(repo, ['commit', '-qam', 'three']);
  git(repo, ['push', '-q', 'origin', 'HEAD:work']);
  result = await snapshot(repo);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.unpushed, []);

  // A new branch that was never pushed: only its own commits count.
  git(repo, ['checkout', '-qb', 'feature']);
  fs.writeFileSync(path.join(repo, 'new.ts'), 'n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'four']);
  result = await snapshot(repo);
  assert.deepEqual(result.unpushed, ['new.ts']);
});

test('snapshot works in a repo with no commits, and outside git', async () => {
  const fresh = tempDir('coco-fresh-');
  git(fresh, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(fresh, 'a.txt'), 'a');
  const result = await snapshot(fresh);
  assert.deepEqual(result.files, ['a.txt']);
  assert.equal(result.branch, 'main');

  const notRepo = tempDir('coco-plain-');
  const outside = await snapshot(notRepo);
  assert.deepEqual(outside.files, []);
});

test('clones of one project are the same repo; unrelated repos are not', async () => {
  const origin = makeOrigin();
  const a = await repoIdentity(cloneOf(origin));
  const b = await repoIdentity(cloneOf(origin));
  const other = await repoIdentity(makeOrigin());

  assert.ok(sameRepo(a, b));
  assert.ok(!sameRepo(a, other));
});

test('shallow clones match through the origin URL', () => {
  const full = { roots: ['a'.repeat(40)], remote: 'github.com/0xzcr/coco-connect' };
  const shallow = { roots: ['b'.repeat(40)], remote: 'github.com/0xzcr/coco-connect' };
  const fork = { roots: ['c'.repeat(40)], remote: 'github.com/someone/else' };
  const unborn = { roots: [], remote: '' };

  assert.ok(sameRepo(full, shallow));
  assert.ok(!sameRepo(full, fork));
  assert.ok(!sameRepo(unborn, unborn), 'two repos with nothing in common are not the same');
});

test('remote URLs normalise to one form', () => {
  const expected = 'github.com/0xzcr/coco-connect';
  assert.equal(normalizeRemote('git@github.com:0xzcr/coco-connect.git'), expected);
  assert.equal(normalizeRemote('https://github.com/0xzcr/coco-connect'), expected);
  assert.equal(normalizeRemote('https://user:token@GitHub.com/0xzcr/coco-connect/'), expected);
  assert.equal(normalizeRemote('ssh://git@github.com:22/0xzcr/coco-connect.git'), expected);
  assert.equal(normalizeRemote('ssh://git@github.com/0xzcr/coco-connect.git\n'), expected);
  assert.equal(normalizeRemote(''), '');
});

test('paths: Windows and POSIX paths come out in git form', () => {
  assert.equal(repoRelative('C:\\repo', 'C:\\repo\\src\\db.py', path.win32), 'src/db.py');
  assert.equal(repoRelative('C:\\repo', 'src\\db.py', path.win32), 'src/db.py');
  assert.equal(repoRelative('C:\\repo', 'D:\\other\\db.py', path.win32), null, 'another drive');
  assert.equal(repoRelative('/repo', '/repo/src/db.py', path.posix), 'src/db.py');
  assert.equal(repoRelative('/repo', '/repo/./src/../src/db.py', path.posix), 'src/db.py');
  assert.equal(repoRelative('/repo', '/elsewhere/db.py', path.posix), null);
  assert.equal(repoRelative('/repo', '/repo', path.posix), null, 'the root itself is not a file');
  assert.equal(repoRelative('/repo', '/repo/..foo', path.posix), '..foo', 'a name starting with dots is inside');
});

test('paths: case is ignored on Windows and macOS only', () => {
  assert.ok(samePath('src/Auth.ts', 'src/auth.ts', 'win32'));
  assert.ok(samePath('src/Auth.ts', 'src/auth.ts', 'darwin'));
  assert.ok(!samePath('src/Auth.ts', 'src/auth.ts', 'linux'));
});

test('paths: symlinked folders resolve, even for files that do not exist yet', () => {
  const real = tempDir('coco-real-');
  const link = path.join(tempDir('coco-link-'), 'link');
  fs.symlinkSync(real, link);

  assert.equal(realPath(path.join(link, 'new', 'deep', 'file.ts')), path.join(real, 'new', 'deep', 'file.ts'));
  assert.equal(realPath(path.join(link, 'file.ts')), path.join(real, 'file.ts'));
});

// The temp folder as the OS hands it out: C:\Users\RUNNER~1\... on GitHub's Windows runners,
// /var/folders/... (a symlink to /private/var) on macOS. Both must match what git reports.
test('paths: a short or symlinked repo path matches the repo root git reports', async (t) => {
  const given = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-short-'));
  const resolved = fs.realpathSync.native(given);
  if (given === resolved) {
    t.skip('the temp folder has no short name or symlink on this machine');
    return;
  }
  git(given, ['init', '-q']);

  assert.equal(await findRepoRoot(given), resolved);
  assert.equal(realPath(path.join(given, 'auth.ts')), path.join(resolved, 'auth.ts'));
  assert.equal(realPath(path.join(given, 'new', 'auth.ts')), path.join(resolved, 'new', 'auth.ts'));
});
