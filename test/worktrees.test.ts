import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { dropNestedWorktrees, groupWorktrees, mergeDiscovered } from '../src/domain/catalog';
import { parseWorktreeList, worktreeMainFromGitFile } from '../src/domain/gitParse';
import { emptyCatalog } from '../src/domain/model';
import { pathKey } from '../src/domain/paths';
import { GitClient, worktreeMainOf } from '../src/services/git';

test('parseWorktreeList: main, branch, detached, prunable, locked, bare', () => {
  const out = [
    'worktree /code/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /code/wt/feature',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feature/login',
    'locked',
    '',
    'worktree /code/wt/review',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const trees = parseWorktreeList(out);
  assert.equal(trees.length, 3);
  assert.deepEqual(trees[1], { path: '/code/wt/feature', branch: 'feature/login', detached: false, bare: false, prunable: false, locked: true });
  assert.equal(trees[2]!.branch, '3333333');
  assert.equal(trees[2]!.prunable, true);
  assert.equal(parseWorktreeList('worktree /srv/repo.git\nbare\n')[0]!.bare, true);
});

test('worktreeMainFromGitFile: worktrees resolve to the main repo; submodules do not', () => {
  const posix = (from: string, to: string) => path.posix.resolve(from, to);
  const win = (from: string, to: string) => path.win32.resolve(from, to);
  assert.equal(worktreeMainFromGitFile('gitdir: /code/app/.git/worktrees/feature\n', '/code/wt/feature', posix), '/code/app');
  assert.equal(worktreeMainFromGitFile('gitdir: C:/_GITHUB_/Brainy/.git/worktrees/x', 'C:\\wt\\x', win), 'C:\\_GITHUB_\\Brainy');
  assert.equal(worktreeMainFromGitFile('gitdir: ../../.git/worktrees/x', '/code/app/wt/x', posix), '/code/app');
  assert.equal(worktreeMainFromGitFile('gitdir: /srv/repo.git/worktrees/x', '/w/x', posix), '/srv/repo.git');
  assert.equal(worktreeMainFromGitFile('gitdir: ../.git/modules/lib', '/code/app/lib', posix), undefined);
  assert.equal(worktreeMainFromGitFile('not a pointer', '/x', posix), undefined);
});

test('groupWorktrees and dropNestedWorktrees: worktrees fold into a main repo on the board', () => {
  const main = path.resolve('/code/app');
  const wt1 = path.resolve('/code/wt/app-feature');
  const wt2 = path.resolve('/code/wt/orphan-x');
  const mainOf = new Map([[wt1, main], [wt2, path.resolve('/elsewhere/orphan')]]);

  // Main repo found in the same scan: its worktree is grouped; a worktree whose main is unknown stays.
  const g = groupWorktrees(emptyCatalog(), [main, wt1, wt2], mainOf);
  assert.deepEqual(g.repos, [main, wt2]);
  assert.deepEqual(g.grouped, [wt1]);

  // A board that already has the worktree as a discovered tile loses it; a hand-added one stays.
  let cat = mergeDiscovered(emptyCatalog(), [main, wt1]).catalog;
  const keyed = new Map([...mainOf].map(([k, v]) => [pathKey(k), v]));
  const cleaned = dropNestedWorktrees(cat, keyed);
  assert.equal(cleaned.dropped, 1);
  assert.deepEqual(cleaned.catalog.projects.map((p) => p.path), [main]);
  assert.equal(cleaned.catalog.ignoredPaths.length, 0, 'not ignored, so "separate" mode can bring it back');

  cat = { ...cat, projects: cat.projects.map((p) => (p.path === wt1 ? { ...p, source: 'manual' as const } : p)) };
  assert.equal(dropNestedWorktrees(cat, keyed).dropped, 0);
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-wt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('GitClient reads linked worktrees from a real repository', async (t) => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
  try {
    git(tmp, 'init', '-q', '-b', 'main', 'app');
  } catch {
    t.skip('git not available');
    return;
  }
  const app = path.join(tmp, 'app');
  writeFileSync(path.join(app, 'a.txt'), 'a');
  git(app, 'add', '.');
  git(app, 'commit', '-q', '-m', 'init');
  const wt = path.join(tmp, 'wt-feature');
  git(app, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  writeFileSync(path.join(wt, 'b.txt'), 'b');

  // Git reports canonical paths (macOS /private/var, Windows long names), so compare real paths.
  const same = (a: string, b: string) => pathKey(realpathSync.native(a)) === pathKey(realpathSync.native(b));
  const client = new GitClient();
  const status = await client.status(app);
  assert.equal(status?.worktrees?.length, 1);
  assert.equal(status!.worktrees![0]!.branch, 'feature/x');
  assert.ok(same(status!.worktrees![0]!.path, wt));
  assert.equal(status!.worktrees![0]!.changes, 1);

  const wtStatus = await client.status(wt);
  assert.ok(same(wtStatus!.worktreeOf!, app));
  assert.equal(wtStatus!.worktrees, undefined);
  assert.ok(same((await worktreeMainOf(wt))!, app));
  assert.equal(await worktreeMainOf(app), undefined);
});
