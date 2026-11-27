import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchToPushLabel, countReachable, parseBranchList, parseUnpushedLog, unpushedSummary, type BranchInfo } from '../src/domain/gitParse';
import { attentionCount, hasWorkToPush, type GitStatus, type ProjectMeta } from '../src/domain/model';
import { matchesStateFilter, repoStateOf } from '../src/domain/search';

const US = '\x1f';
const git = (over: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, ...over });
const meta = (g: GitStatus | null): ProjectMeta => ({ availability: 'ok', git: g, languages: [], updatedAt: 0, languagesAt: 0 });
const logLine = (hash: string, parents: string[], refs = '') => `${hash}${US}${parents.join(' ')}${US}${refs}`;

test('parseBranchList: ahead/behind, gone, no upstream, malformed lines', () => {
  const out = [
    `main${US}origin/main${US}behind 1`,
    `feature${US}origin/feature${US}ahead 2, behind 1`,
    `gone-branch${US}origin/x${US}gone`,
    `local${US}${US}`,
    `in-sync${US}origin/in-sync${US}`,
    `garbage line`,
    `two${US}fields`,
    `${US}origin/x${US}ahead 1`,
    `crlf${US}origin/crlf${US}ahead 3\r`,
  ].join('\n');
  assert.deepEqual(parseBranchList(out), [
    { name: 'main', upstream: 'origin/main', ahead: 0, behind: 1, gone: false },
    { name: 'feature', upstream: 'origin/feature', ahead: 2, behind: 1, gone: false },
    { name: 'gone-branch', upstream: 'origin/x', ahead: 0, behind: 0, gone: true },
    { name: 'local', ahead: 0, behind: 0, gone: false },
    { name: 'in-sync', upstream: 'origin/in-sync', ahead: 0, behind: 0, gone: false },
    { name: 'crlf', upstream: 'origin/crlf', ahead: 3, behind: 0, gone: false },
  ]);
  assert.deepEqual(parseBranchList(''), []);
});

test('parseUnpushedLog: decorations, tags, bare HEAD, malformed lines', () => {
  const out = [
    logLine('c3', ['c2'], 'HEAD -> never-pushed'),
    logLine('c2', ['c1']),
    logLine('c1', [], 'tag: v1'),
    logLine('d1', ['c1'], 'other-local, tag: v2'),
    logLine('e1', [], 'HEAD'),
    logLine('f1', ['e1'], 'HEAD -> feature/x, topic, tag: t'),
    'not a commit line',
    '',
  ].join('\n');
  const log = parseUnpushedLog(out);
  assert.deepEqual([...log.commits.keys()], ['c3', 'c2', 'c1', 'd1', 'e1', 'f1']);
  assert.deepEqual(log.commits.get('c3'), ['c2']);
  assert.deepEqual(log.commits.get('c1'), []);
  assert.deepEqual(Object.fromEntries(log.tips), { 'never-pushed': 'c3', 'other-local': 'd1', 'feature/x': 'f1', topic: 'f1' });
  assert.equal(log.headTip, 'f1');
  assert.equal(log.capped, false);
  const only = parseUnpushedLog(logLine('a', ['b'], 'HEAD -> main'));
  assert.equal(only.headTip, 'a');
  assert.equal(parseUnpushedLog('').headTip, undefined);
});

test('parseUnpushedLog: 500 lines means capped', () => {
  const lines = Array.from({ length: 500 }, (_, i) => logLine(`h${i}`, [`h${i + 1}`])).join('\n') + '\n';
  assert.equal(parseUnpushedLog(lines).capped, true);
  assert.equal(parseUnpushedLog(lines.split('\n').slice(0, 499).join('\n')).capped, false);
});

test('countReachable: chains, merges, shared history, unknown tips', () => {
  const commits = new Map<string, string[]>([
    ['m', ['a2', 'b2']], // merge of two lines
    ['a2', ['a1']],
    ['a1', ['pushed']], // `pushed` is not in the set: the walk stops there
    ['b2', ['b1']],
    ['b1', ['a1']], // shares a1 with the other line
    ['solo', ['a1']],
  ]);
  assert.equal(countReachable('m', commits), 5);
  assert.equal(countReachable('a2', commits), 2);
  assert.equal(countReachable('solo', commits), 2);
  assert.equal(countReachable('pushed', commits), 0);
  assert.equal(countReachable(undefined, commits), 0);
  // A cycle (should never happen) must still terminate.
  assert.equal(countReachable('x', new Map([['x', ['y']], ['y', ['x']]])), 2);
});

const branch = (name: string, over: Partial<BranchInfo> = {}): BranchInfo => ({ name, ahead: 0, behind: 0, gone: false, ...over });
const chain = (n: number, prefix: string, refs: string): string => Array.from({ length: n }, (_, i) => logLine(`${prefix}${i}`, [i + 1 < n ? `${prefix}${i + 1}` : 'base'], i === 0 ? refs : '')).join('\n');

test('unpushedSummary: no remote reports nothing', () => {
  const unpushed = parseUnpushedLog(chain(3, 'a', 'HEAD -> main'));
  assert.deepEqual(unpushedSummary({ branches: [branch('main')], unpushed, currentBranch: 'main', hasRemote: false }), { others: [] });
});

test('unpushedSummary: current branch without upstream, with a gone upstream, with a live upstream', () => {
  const unpushed = parseUnpushedLog(chain(3, 'a', 'HEAD -> work'));
  const run = (b: BranchInfo) => unpushedSummary({ branches: [b], unpushed, currentBranch: 'work', hasRemote: true });
  assert.deepEqual(run(branch('work')), { current: 3, others: [] });
  assert.deepEqual(run(branch('work', { upstream: 'origin/work', gone: true })), { current: 3, others: [] });
  // A live upstream keeps using git status' ahead.
  assert.deepEqual(run(branch('work', { upstream: 'origin/work', ahead: 3 })), { others: [] });
  // Nothing unpushed: no current.
  assert.deepEqual(unpushedSummary({ branches: [branch('work')], unpushed: parseUnpushedLog(''), currentBranch: 'work', hasRemote: true }), { others: [] });
});

test('unpushedSummary: other branches, sorted and capped, shared history counted per branch', () => {
  const out = [chain(2, 'p', 'HEAD -> main'), logLine('o0', ['p1'], 'other-local'), logLine('g0', ['x'], 'gone-one')].join('\n');
  const unpushed = parseUnpushedLog(out);
  const branches = [
    branch('main', { upstream: 'origin/main', ahead: 2 }),
    branch('other-local'),
    branch('feature/x', { upstream: 'origin/feature/x', ahead: 4, behind: 1 }),
    branch('in-sync', { upstream: 'origin/in-sync' }),
    branch('gone-one', { upstream: 'origin/gone', gone: true }),
    branch('no-commits'),
  ];
  const s = unpushedSummary({ branches, unpushed, currentBranch: 'main', hasRemote: true });
  assert.equal(s.current, undefined);
  assert.deepEqual(s.others, [
    { name: 'feature/x', count: 4, kind: 'ahead', upstream: 'origin/feature/x' },
    { name: 'other-local', count: 2, kind: 'unpushed' }, // o0 plus p1 (p0 is main's tip, not in its history)
    { name: 'gone-one', count: 1, kind: 'unpushed' },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => branch(`b${i}`, { upstream: `origin/b${i}`, ahead: i + 1 }));
  const capped = unpushedSummary({ branches: many, unpushed: parseUnpushedLog(''), currentBranch: 'zzz', hasRemote: true });
  assert.equal(capped.others.length, 20);
  assert.equal(capped.others[0]!.count, 30);
});

test('branchToPushLabel', () => {
  assert.equal(branchToPushLabel({ name: 'other-local', count: 1, kind: 'unpushed' }), 'other-local · 1 commit not on any remote');
  assert.equal(branchToPushLabel({ name: 'a', count: 2, kind: 'unpushed' }), 'a · 2 commits not on any remote');
  assert.equal(branchToPushLabel({ name: 'feature/x', count: 2, kind: 'ahead', upstream: 'origin/feature/x' }), 'feature/x · 2 ahead of origin/feature/x');
});

test('hasWorkToPush, the "to push" filter, state and attention count', () => {
  assert.equal(hasWorkToPush(null), false);
  assert.equal(hasWorkToPush(git()), false);
  assert.equal(hasWorkToPush(git({ ahead: 1 })), true);
  assert.equal(hasWorkToPush(git({ unpushed: 2 })), true);
  assert.equal(hasWorkToPush(git({ branchesToPush: [{ name: 'x', count: 1, kind: 'unpushed' }] })), true);
  assert.equal(hasWorkToPush(git({ branchesToPush: [] })), false);

  assert.equal(matchesStateFilter('ahead', meta(git({ unpushed: 1 }))), true);
  assert.equal(matchesStateFilter('ahead', meta(git({ branchesToPush: [{ name: 'x', count: 1, kind: 'ahead', upstream: 'o/x' }] }))), true);
  assert.equal(matchesStateFilter('ahead', meta(git({ ahead: 1 }))), true);
  assert.equal(matchesStateFilter('ahead', meta(git())), false);
  assert.equal(matchesStateFilter('ahead', undefined), false);

  assert.equal(repoStateOf(meta(git({ unpushed: 2 }))), 'ahead');
  assert.equal(repoStateOf(meta(git({ branchesToPush: [{ name: 'x', count: 1, kind: 'unpushed' }] }))), 'clean');
  assert.equal(repoStateOf(meta(git({ unpushed: 2, behind: 1 }))), 'behind');

  assert.equal(attentionCount(git({ unpushed: 2, modified: 1 })), 3);
  assert.equal(attentionCount(git({ branchesToPush: [{ name: 'x', count: 9, kind: 'unpushed' }] })), 0);
});
