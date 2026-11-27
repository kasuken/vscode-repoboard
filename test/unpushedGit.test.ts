import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { GitClient } from '../src/services/git';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'repoboard-unpushed-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const commit = (cwd: string, file: string, message: string) => {
  writeFileSync(path.join(cwd, file), message);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', message);
};

test('GitClient: never-pushed branch, other branches to push, no-remote repo, linked worktree (real git)', async (t) => {
  try {
    git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  } catch {
    t.skip('git not available');
    return;
  }
  const client = new GitClient();

  // A clone with a pushed main, a pushed feature that is 2 ahead, a local-only branch and a never-pushed current branch.
  const work = path.join(tmp, 'work');
  git(tmp, 'clone', '-q', 'origin.git', 'work');
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'a.txt', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature/x');
  commit(work, 'f.txt', 'feature one');
  git(work, 'push', '-q', '-u', 'origin', 'feature/x');
  commit(work, 'f2.txt', 'feature two');
  commit(work, 'f3.txt', 'feature three');
  git(work, 'checkout', '-q', 'main');
  git(work, 'checkout', '-q', '-b', 'other-local');
  commit(work, 'o.txt', 'other one');
  git(work, 'checkout', '-q', 'main');
  git(work, 'checkout', '-q', '-b', 'never-pushed');
  commit(work, 'n1.txt', 'never one');
  commit(work, 'n2.txt', 'never two');
  const wt = path.join(tmp, 'wt-wip');
  git(work, 'worktree', 'add', '-q', '-b', 'wip', wt, 'main');
  commit(wt, 'w.txt', 'wip one');

  const status = await client.status(work);
  assert.equal(status!.hasRemote, true);
  assert.equal(status!.branch, 'never-pushed');
  assert.equal(status!.unpushed, 2);
  assert.equal(status!.unpushedCapped, undefined);
  assert.deepEqual(status!.branchesToPush, [
    { name: 'feature/x', count: 2, kind: 'ahead', upstream: 'origin/feature/x' },
    { name: 'other-local', count: 1, kind: 'unpushed' },
    { name: 'wip', count: 1, kind: 'unpushed' },
  ]);

  // Linked worktree: its own branch counts, the shared branch list belongs to the main repo.
  const wtStatus = await client.status(wt);
  assert.equal(wtStatus!.branch, 'wip');
  assert.equal(wtStatus!.unpushed, 1);
  assert.equal(wtStatus!.branchesToPush, undefined);

  // Back on main (pushed, in sync): nothing unpushed on the current branch.
  git(work, 'worktree', 'remove', '--force', wt);
  git(work, 'checkout', '-q', 'main');
  const onMain = await client.status(work);
  assert.equal(onMain!.unpushed, undefined);
  assert.equal(onMain!.branchesToPush!.length, 4);

  // No remote: every commit is local, which is not reported as unpushed.
  const solo = path.join(tmp, 'solo');
  git(tmp, 'init', '-q', '-b', 'main', 'solo');
  commit(solo, 'a.txt', 'one');
  commit(solo, 'b.txt', 'two');
  const soloStatus = await client.status(solo);
  assert.equal(soloStatus!.hasRemote, false);
  assert.equal(soloStatus!.unpushed, undefined);
  assert.equal(soloStatus!.branchesToPush, undefined);
});
