import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { parseStashList, stashBranch, stashLabel } from '../src/domain/gitParse';
import { hasStashes, type GitStatus, type ProjectMeta } from '../src/domain/model';
import { sortProjects } from '../src/domain/search';
import { GitClient } from '../src/services/git';

const US = '\x1f';

test('parseStashList: normal entries, messages with colons', () => {
  const out = [`stash@{0}${US}1700000100${US}WIP on main: 1a2b3c4 fix: login flicker`, `stash@{1}${US}1700000000${US}On feature/x: note: with colons`].join('\n') + '\n';
  assert.deepEqual(parseStashList(out), [
    { ref: 'stash@{0}', time: 1700000100, message: 'WIP on main: 1a2b3c4 fix: login flicker' },
    { ref: 'stash@{1}', time: 1700000000, message: 'On feature/x: note: with colons' },
  ]);
});

test('parseStashList: empty output and junk lines', () => {
  assert.deepEqual(parseStashList(''), []);
  assert.deepEqual(parseStashList('\n\n'), []);
  const out = [`gpg: Signature made`, `stash@{0}${US}1700000000${US}On main: a`, `too${US}many${US}fields${US}here`, `only${US}two`, `${US}1${US}no ref`, `stash@{1}${US}1700000000${US}On main: b\r`].join('\n');
  assert.deepEqual(parseStashList(out).map((e) => e.ref), ['stash@{0}', 'stash@{1}']);
});

test('stashBranch and stashLabel', () => {
  assert.equal(stashBranch('WIP on main: 1a2b3c subject'), 'main');
  assert.equal(stashBranch('On feature/cart: try new drawer'), 'feature/cart');
  assert.equal(stashBranch('custom message'), undefined);
  assert.equal(stashLabel('WIP on main: 1a2b3c4 fix login flicker'), 'On main · fix login flicker');
  assert.equal(stashLabel('On feature/cart: try new cart drawer'), 'On feature/cart · try new cart drawer');
  assert.equal(stashLabel('WIP on main: 1a2b3c4'), 'On main');
  assert.equal(stashLabel('something else'), 'something else');
  assert.ok(stashLabel('On x: ' + 'y'.repeat(200)).length <= 80);
});

test('"with stashes" predicate and the most-changes tie-breaker', () => {
  const g = (o: Partial<GitStatus>): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, ...o });
  assert.equal(hasStashes(g({ stashes: 1 })), true);
  assert.equal(hasStashes(g({})), false);
  assert.equal(hasStashes(null), false);
  const mk = (id: string, name: string) => ({ id, name, path: `/x/${id}`, tags: [], source: 'manual' as const, addedAt: 0 });
  const meta = (git: GitStatus): ProjectMeta => ({ availability: 'ok', git, languages: [], updatedAt: 0, languagesAt: 0 });
  const projects = [mk('a', 'alpha'), mk('b', 'beta'), mk('c', 'gamma')];
  const m = { a: meta(g({})), b: meta(g({ stashes: 2 })), c: meta(g({ modified: 1 })) };
  assert.deepEqual(sortProjects(projects, m, 'changes').map((p) => p.id), ['c', 'b', 'a']);
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-stash-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('GitClient reads the stash list from a real repository; a linked worktree gets none', async (t) => {
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
  const client = new GitClient();

  const clean = await client.status(app);
  assert.equal(clean!.stashes, 0);
  assert.equal(clean!.stashList, undefined);

  writeFileSync(path.join(app, 'a.txt'), 'changed');
  git(app, 'stash', 'push', '-q', '-m', 'first note: with a colon');
  writeFileSync(path.join(app, 'a.txt'), 'changed again');
  git(app, 'stash', 'push', '-q');
  const status = await client.status(app);
  assert.equal(status!.stashes, 2);
  assert.deepEqual(status!.stashList!.map((e) => e.ref), ['stash@{0}', 'stash@{1}']);
  assert.match(status!.stashList![0]!.message, /^WIP on main: /);
  assert.equal(status!.stashList![1]!.message, 'On main: first note: with a colon');
  assert.ok(status!.stashList![0]!.time > 1_600_000_000);
  assert.equal(status!.modified, 0, 'stashes are not file changes');

  const wt = path.join(tmp, 'wt');
  git(app, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  const wtStatus = await client.status(wt);
  assert.ok(wtStatus!.worktreeOf);
  assert.equal(wtStatus!.stashes, 0);
  assert.equal(wtStatus!.stashList, undefined);
});
