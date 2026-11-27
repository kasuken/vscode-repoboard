import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitStatus, ProjectMeta, WorktreeInfo, attentionCount, hasUncommittedWork, pendingCount, worktreeChanges } from '../src/domain/model';
import { matchesStateFilter, repoStateOf, sortProjects } from '../src/domain/search';

const git = (over: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, ...over });
const wt = (changes: number | undefined, prunable = false): WorktreeInfo => ({ path: `/wt/${changes}-${prunable}`, branch: 'agent/x', detached: false, changes, prunable, locked: false });
const meta = (g: GitStatus | null, availability: ProjectMeta['availability'] = 'ok'): ProjectMeta => ({ availability, git: g, languages: [], updatedAt: 0, languagesAt: 0 });

test('worktreeChanges sums live worktrees and ignores prunable / unread ones', () => {
  assert.equal(worktreeChanges(null), 0);
  assert.equal(worktreeChanges(git()), 0);
  assert.equal(worktreeChanges(git({ worktrees: [wt(6), wt(2), wt(9, true), wt(undefined)] })), 8);
});

test('hasUncommittedWork and attentionCount include worktrees; pendingCount does not', () => {
  const clean = git({ worktrees: [wt(6)] });
  assert.equal(hasUncommittedWork(clean), true);
  assert.equal(hasUncommittedWork(git({ worktrees: [wt(0), wt(5, true)] })), false);
  assert.equal(hasUncommittedWork(git({ modified: 1 })), true);
  assert.equal(pendingCount(clean), 0);
  assert.equal(attentionCount(git({ modified: 2, ahead: 1, worktrees: [wt(6)] })), 9);
});

test('matchesStateFilter: "changes" sees a dirty worktree under a clean main tree', () => {
  const m = meta(git({ worktrees: [wt(3)] }));
  assert.equal(matchesStateFilter('changes', m), true);
  assert.equal(matchesStateFilter('changes', meta(git({ worktrees: [wt(0)] }))), false);
  assert.equal(matchesStateFilter('changes', undefined), false);
  assert.equal(matchesStateFilter('all', undefined), true);
  assert.equal(matchesStateFilter('behind', meta(git({ behind: 1 }))), true);
  assert.equal(matchesStateFilter('missing', meta(null, 'missing')), true);
  assert.equal(matchesStateFilter('stashes', meta(git({ stashes: 1 }))), true);
});

test('repoStateOf: worktree edits make a clean repo dirty but never outrank stronger states', () => {
  assert.equal(repoStateOf(meta(git({ worktrees: [wt(3)] }))), 'dirty');
  assert.equal(repoStateOf(meta(git({ behind: 2, worktrees: [wt(3)] }))), 'dirty');
  assert.equal(repoStateOf(meta(git({ conflicts: 1, worktrees: [wt(3)] }))), 'conflict');
  assert.equal(repoStateOf(meta(git({ worktrees: [wt(3)] }), 'missing')), 'missing');
  assert.equal(repoStateOf(meta(git({ worktrees: [wt(3)] }), 'offline')), 'offline');
  assert.equal(repoStateOf(meta(git({ worktrees: [wt(4, true)] }))), 'clean');
  assert.equal(repoStateOf(meta(git({ ahead: 1 }))), 'ahead');
  assert.equal(repoStateOf(undefined), 'unknown');
  assert.equal(repoStateOf(meta(null)), 'nogit');
});

test('"Most changes" sort counts worktree edits and keeps the stash tie-breaker', () => {
  const p = (id: string) => ({ id, name: id, path: `/${id}`, tags: [], source: 'manual' as const, addedAt: 0 });
  const projects = [p('a-clean'), p('b-agent'), p('c-own'), p('d-stash')];
  const metas = {
    'a-clean': meta(git()),
    'b-agent': meta(git({ worktrees: [wt(6)] })),
    'c-own': meta(git({ modified: 2 })),
    'd-stash': meta(git({ stashes: 1 })),
  };
  assert.deepEqual(sortProjects(projects, metas, 'changes').map((x) => x.id), ['b-agent', 'c-own', 'd-stash', 'a-clean']);
  const tie = { 'a-clean': meta(git()), 'b-agent': meta(git({ worktrees: [wt(2)] })), 'c-own': meta(git({ modified: 2 })), 'd-stash': meta(git({ stashes: 3 })) };
  // b-agent and c-own tie on attention; own changes rank first, then stashes.
  assert.deepEqual(sortProjects(projects, tie, 'changes').map((x) => x.id), ['c-own', 'b-agent', 'd-stash', 'a-clean']);
});
