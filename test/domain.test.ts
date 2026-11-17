import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../src/domain/catalog';
import { describeGitError, parseLogLine, parsePorcelainV2, pickRemoteUrl, remoteToWebUrl } from '../src/domain/gitParse';
import { languageForFile, toShares } from '../src/domain/languages';
import { emptyCatalog, initialsFor, parseTags, ProjectMeta } from '../src/domain/model';
import { displayPath, pathKey } from '../src/domain/paths';
import { fuzzyScore, matchScore, relativeTime, sortProjects } from '../src/domain/search';

test('pathKey folds case, slashes and trailing separators on Windows only', () => {
  assert.equal(pathKey('C:\\Code\\Repo\\', 'win32'), pathKey('c:\\code\\repo', 'win32'));
  assert.equal(pathKey('C:/Code/Repo', 'win32'), 'c:\\code\\repo');
  assert.equal(pathKey('C:\\', 'win32'), 'c:\\');
  assert.notEqual(pathKey('/home/a/Repo', 'linux'), pathKey('/home/a/repo', 'linux'));
  assert.equal(pathKey('/home/a/repo/', 'linux'), '/home/a/repo');
});

test('displayPath shortens the home directory', () => {
  assert.equal(displayPath('C:\\Users\\me\\src\\x', 'C:\\Users\\me', 'win32'), '~\\src\\x');
  assert.equal(displayPath('/home/me/src/x', '/home/me', 'linux'), '~/src/x');
  assert.equal(displayPath('/home/meow/x', '/home/me', 'linux'), '/home/meow/x');
});

test('porcelain v2: branch, upstream, ahead/behind and change counts', () => {
  const out = [
    '# branch.oid 1234567890abcdef',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +3 -2',
    '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
    '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
    '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
    '? untracked.txt',
    '? other.txt',
    '! ignored.log',
  ].join('\n');
  assert.deepEqual(parsePorcelainV2(out), {
    branch: 'feature/x', detached: false, oid: '1234567890abcdef', upstream: 'origin/feature/x',
    ahead: 3, behind: 2, staged: 3, modified: 2, untracked: 2, conflicts: 1,
  });
});

test('porcelain v2: detached HEAD and fresh repo', () => {
  const detached = parsePorcelainV2('# branch.oid abcdef1234\n# branch.head (detached)\n');
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, 'abcdef1');
  const fresh = parsePorcelainV2('# branch.oid (initial)\n# branch.head main\n');
  assert.equal(fresh.branch, 'main');
  assert.equal(fresh.oid, undefined);
  assert.equal(fresh.upstream, undefined);
});

test('log line parsing keeps subjects with any punctuation', () => {
  const c = parseLogLine('abc1234\x1ffix: a | b, c; "d"\x1fAda\x1f1700000000\n');
  assert.deepEqual(c, { hash: 'abc1234', subject: 'fix: a | b, c; "d"', author: 'Ada', time: 1700000000 });
  assert.equal(parseLogLine(''), undefined);
});

test('remote URL → web URL, credentials always stripped', () => {
  assert.equal(remoteToWebUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(remoteToWebUrl('https://github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(remoteToWebUrl('https://user:ghp_SECRET@github.com/owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(remoteToWebUrl('https://x-access-token:SECRET@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(remoteToWebUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git'), 'https://gitlab.example.com/group/sub/repo');
  assert.equal(remoteToWebUrl('https://git.example.com:8443/team/repo.git'), 'https://git.example.com:8443/team/repo');
  assert.equal(remoteToWebUrl('git@ssh.dev.azure.com:v3/contoso/Web/portal'), 'https://dev.azure.com/contoso/Web/_git/portal');
  assert.equal(remoteToWebUrl('https://contoso@dev.azure.com/contoso/Web/_git/portal'), 'https://dev.azure.com/contoso/Web/_git/portal');
  assert.equal(remoteToWebUrl('contoso@vs-ssh.visualstudio.com:v3/contoso/Web/portal'), 'https://dev.azure.com/contoso/Web/_git/portal');
  assert.equal(remoteToWebUrl('C:\\repos\\bare.git'), undefined);
  assert.equal(remoteToWebUrl('/srv/git/bare.git'), undefined);
  assert.equal(remoteToWebUrl('file:///srv/git/bare.git'), undefined);
  assert.equal(remoteToWebUrl(undefined), undefined);
  for (const url of ['https://u:SECRET@github.com/o/r.git', 'https://SECRET@github.com/o/r.git']) {
    assert.ok(!remoteToWebUrl(url)!.includes('SECRET'));
  }
});

test('pickRemoteUrl prefers origin', () => {
  const out = 'upstream\thttps://github.com/up/r.git (fetch)\nupstream\thttps://github.com/up/r.git (push)\norigin\tgit@github.com:me/r.git (fetch)\n';
  assert.equal(pickRemoteUrl(out), 'git@github.com:me/r.git');
  assert.equal(pickRemoteUrl('fork\thttps://x/y.git (fetch)\n'), 'https://x/y.git');
  assert.equal(pickRemoteUrl(''), undefined);
});

test('git errors become a readable reason; "not a repo" stays silent', () => {
  assert.match(describeGitError("fatal: detected dubious ownership in repository at 'D:/x'")!, /safe\.directory/);
  assert.equal(describeGitError('fatal: not a git repository (or any of the parent directories): .git'), undefined);
});

test('languages: data formats ignored, generated files skipped, small shares folded', () => {
  assert.equal(languageForFile('main.ts')?.name, 'TypeScript');
  assert.equal(languageForFile('index.d.ts'), undefined);
  assert.equal(languageForFile('Dockerfile')?.name, 'Dockerfile');
  assert.equal(languageForFile('view.blade.php')?.name, 'Blade');
  assert.equal(languageForFile('package.json'), undefined);
  assert.equal(languageForFile('README.md'), undefined);
  const ts = languageForFile('a.ts')!;
  const css = languageForFile('a.css')!;
  const sh = languageForFile('a.sh')!;
  const shares = toShares(new Map([[ts, 9000], [css, 990], [sh, 10]]));
  assert.deepEqual(shares.map((s) => s.name), ['TypeScript', 'CSS', 'Other']);
});

test('fuzzy search: substring beats scattered, word starts win, misses are zero', () => {
  assert.ok(fuzzyScore('board', 'repo-board') > fuzzyScore('board', 'b-o-a-r-d'));
  assert.ok(fuzzyScore('rb', 'repo-board') > fuzzyScore('rb', 'rubber'));
  assert.equal(fuzzyScore('xyz', 'repo-board'), 0);
  const fields = { name: 'PostNook', path: 'C:\\code\\PostNook', description: 'Social scheduling', tags: ['dotnet', 'saas'], branch: 'feature/queue', languages: ['C#'] };
  assert.ok(matchScore('post', fields) > 0);
  assert.ok(matchScore('#dot', fields) > 0);
  assert.equal(matchScore('#oss', fields), 0);
  assert.ok(matchScore('queue', fields) > 0);
  assert.ok(matchScore('#saas sched', fields) > 0);
  assert.equal(matchScore('post zzz', fields), 0);
});

test('catalog: add dedupes by path key, remove remembers discovered repos', () => {
  let cat = emptyCatalog();
  const a = C.addProject(cat, { path: process.platform === 'win32' ? 'C:\\Code\\Alpha' : '/code/Alpha' });
  cat = a.catalog;
  const again = C.addProject(cat, { path: process.platform === 'win32' ? 'c:\\code\\alpha\\' : '/code/Alpha/' });
  assert.equal(again.catalog.projects.length, 1);
  assert.equal(again.project.id, a.project.id);

  const merged = C.mergeDiscovered(cat, [process.platform === 'win32' ? 'C:\\Code\\Beta' : '/code/Beta', a.project.path]);
  assert.equal(merged.added.length, 1);
  cat = C.removeProject(merged.catalog, merged.added[0]!.id);
  assert.equal(cat.ignoredPaths.length, 1);
  assert.equal(C.mergeDiscovered(cat, [merged.added[0]!.path]).added.length, 0, 'removed repo must not come back');

  // Adding it by hand un-ignores it.
  const manual = C.addProject(cat, { path: merged.added[0]!.path });
  assert.equal(manual.catalog.ignoredPaths.length, 0);
});

test('catalog: removing a manually added repo also keeps it out of later scans', () => {
  const repo = process.platform === 'win32' ? 'C:\\_GITHUB_\\Gamma' : '/code/Gamma';
  const added = C.addProject(emptyCatalog(), { path: repo });
  assert.equal(added.project.source, 'manual');
  const removed = C.removeProject(added.catalog, added.project.id);
  assert.equal(removed.projects.length, 0);
  assert.equal(C.mergeDiscovered(removed, [repo]).added.length, 0);
});

test('catalog: moveProject places at index within the target collection', () => {
  let cat = emptyCatalog();
  const col = C.saveCollection(cat, { name: 'Work' });
  cat = col.catalog;
  const ids: string[] = [];
  for (const n of ['a', 'b', 'c', 'd']) {
    const r = C.addProject(cat, { path: `/x/${n}`, collectionId: n === 'd' ? null : col.collection.id });
    cat = r.catalog;
    ids.push(r.project.id);
  }
  cat = C.moveProject(cat, ids[3]!, col.collection.id, 1);
  const order = cat.projects.filter((p) => p.collectionId === col.collection.id).map((p) => p.name);
  assert.deepEqual(order, ['a', 'd', 'b', 'c']);
  cat = C.removeCollection(cat, col.collection.id);
  assert.ok(cat.projects.every((p) => p.collectionId === undefined));
  assert.equal(cat.projects.length, 4);
});

test('sanitizeCatalog repairs hand-edited JSON', () => {
  const cat = C.sanitizeCatalog({
    collections: [{ id: 'c', name: 'C', color: 'zzz' }, { id: 'c', name: 'dupe' }],
    projects: [
      { path: '/x/a', name: '  A ', tags: ['t', 'T', 3], collectionId: 'missing', pinned: 'yes', color: '#ABC' },
      { path: '/x/a/' },
      { name: 'no path' },
    ],
    ignoredPaths: ['/x/b', 5],
  });
  assert.equal(cat.collections.length, 1);
  assert.equal(cat.collections[0]!.color, undefined);
  assert.equal(cat.projects.length, 1);
  const p = cat.projects[0]!;
  assert.equal(p.name, 'A');
  assert.deepEqual(p.tags, ['t']);
  assert.equal(p.collectionId, undefined);
  assert.equal(p.pinned, undefined);
  assert.equal(p.color, '#abc');
  assert.equal(cat.ignoredPaths.length, 1);
  assert.deepEqual(C.sanitizeCatalog('garbage'), emptyCatalog());
});

test('sort modes', () => {
  const mk = (id: string, name: string, lastOpenedAt?: number) => ({ id, name, path: `/x/${id}`, tags: [], source: 'manual' as const, addedAt: 0, ...(lastOpenedAt ? { lastOpenedAt } : {}) });
  const projects = [mk('1', 'beta', 10), mk('2', 'Alpha'), mk('3', 'gamma', 30), mk('4', 'repo10'), mk('5', 'repo9')];
  const git = (o: object) => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, ...o });
  const meta = (g: object | null): ProjectMeta => ({ availability: 'ok', git: g ? git(g) : null, languages: [], updatedAt: 0, languagesAt: 0 });
  const m: Record<string, ProjectMeta> = {
    '1': meta({ modified: 1, lastCommit: { hash: 'a', subject: '', author: '', time: 100 } }),
    '2': meta({ behind: 5, lastCommit: { hash: 'a', subject: '', author: '', time: 300 } }),
    '3': meta(null),
  };
  assert.deepEqual(sortProjects(projects, m, 'name').map((p) => p.name), ['Alpha', 'beta', 'gamma', 'repo9', 'repo10']);
  assert.deepEqual(sortProjects(projects, m, 'recent').map((p) => p.id).slice(0, 2), ['3', '1']);
  assert.deepEqual(sortProjects(projects, m, 'commit').map((p) => p.id).slice(0, 2), ['2', '1']);
  assert.deepEqual(sortProjects(projects, m, 'changes').map((p) => p.id).slice(0, 2), ['2', '1']);
  assert.deepEqual(sortProjects(projects, m, 'manual').map((p) => p.id), ['1', '2', '3', '4', '5']);
});

test('small helpers', () => {
  assert.equal(initialsFor('MyGameStudio'), 'MGS');
  assert.equal(initialsFor('shop-backend'), 'SB');
  assert.equal(initialsFor('tools'), 'TO');
  assert.deepEqual(parseTags(' #work, Work ,client-x;; '), ['work', 'client-x']);
  const now = 1_000_000_000_000;
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 hours ago');
  assert.equal(relativeTime(now - 86_400_000, now), '1 day ago');
});
