import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FETCH_STALE_MS, fetchDue, fetchFreshness, isFetchStale, shortRelativeTime } from '../src/domain/freshness';
import type { GitStatus } from '../src/domain/model';

const NOW = 1_800_000_000_000;
const git = (extra: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, upstream: 'origin/main', ...extra });
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;

test('shortRelativeTime formats and boundaries', () => {
  const f = (ms: number) => shortRelativeTime(ago(ms), NOW);
  assert.equal(f(0), 'just now');
  assert.equal(f(59_000), 'just now');
  assert.equal(f(MIN), '1m ago');
  assert.equal(f(5 * MIN), '5m ago');
  assert.equal(f(59 * MIN), '59m ago');
  assert.equal(f(H), '1h ago');
  assert.equal(f(23 * H), '23h ago');
  assert.equal(f(D), '1d ago');
  assert.equal(f(3 * D), '3d ago');
  assert.equal(f(13 * D), '13d ago');
  assert.equal(f(14 * D), '2w ago');
  assert.equal(f(30 * D), '4w ago');
  assert.equal(f(60 * D), '2mo ago');
  assert.equal(f(120 * D), '4mo ago');
  assert.equal(f(365 * D), '1y ago');
  assert.equal(f(800 * D), '2y ago');
  assert.equal(shortRelativeTime(NOW + 5000, NOW), 'just now');
});

test('fetchFreshness: none without git, upstream or on error', () => {
  assert.equal(fetchFreshness(null, NOW).kind, 'none');
  assert.equal(fetchFreshness(undefined, NOW).kind, 'none');
  const { upstream: _u, ...local } = git();
  assert.equal(fetchFreshness(local as GitStatus, NOW).kind, 'none');
  assert.equal(fetchFreshness(git({ error: 'x', lastFetchAt: ago(D * 9) }), NOW).kind, 'none');
  assert.equal(fetchFreshness(null, NOW).label, '');
  assert.equal(isFetchStale(null, NOW), false);
});

test('fetchFreshness: never, fresh and stale with the 24h boundary', () => {
  const never = fetchFreshness(git(), NOW);
  assert.equal(never.kind, 'never');
  assert.equal(never.label, 'never fetched');
  assert.match(never.title, /never been fetched/);
  assert.equal(isFetchStale(git(), NOW), true);

  const fresh = fetchFreshness(git({ lastFetchAt: ago(2 * H) }), NOW);
  assert.equal(fresh.kind, 'fresh');
  assert.equal(fresh.label, 'fetched 2h ago');
  assert.match(fresh.title, /^Last fetched .+ Ahead\/behind counts are as of then\.$/);
  assert.equal(isFetchStale(git({ lastFetchAt: ago(2 * H) }), NOW), false);

  assert.equal(fetchFreshness(git({ lastFetchAt: ago(FETCH_STALE_MS) }), NOW).kind, 'fresh');
  const stale = fetchFreshness(git({ lastFetchAt: ago(FETCH_STALE_MS + 1) }), NOW);
  assert.equal(stale.kind, 'stale');
  assert.equal(isFetchStale(git({ lastFetchAt: ago(3 * D) }), NOW), true);
  assert.equal(fetchFreshness(git({ lastFetchAt: ago(3 * D) }), NOW).label, 'fetched 3d ago');
});

test('fetchFreshness: failed takes precedence and mentions the last fetch', () => {
  const f = fetchFreshness(git({ fetchError: 'fatal: nope', lastFetchAt: NOW - 1000 }), NOW);
  assert.equal(f.kind, 'failed');
  assert.equal(f.label, 'fetch failed');
  assert.match(f.title, /^Fetch failed: fatal: nope\. Ahead\/behind counts are from .+\.$/);
  assert.match(fetchFreshness(git({ fetchError: 'x' }), NOW).title, /from an unknown time\.$/);
  assert.equal(isFetchStale(git({ fetchError: 'x', lastFetchAt: NOW - 1000 }), NOW), true);
  const { upstream: _u, ...local } = git({ fetchError: 'x' });
  assert.equal(fetchFreshness(local as GitStatus, NOW).kind, 'none');
  assert.equal(fetchFreshness(git({ fetchError: 'x', error: 'dubious' }), NOW).kind, 'none');
});

test('fetchDue', () => {
  assert.equal(fetchDue(null, 30 * MIN, NOW), true);
  assert.equal(fetchDue(undefined, 30 * MIN, NOW), true);
  assert.equal(fetchDue(NOW - 10 * MIN, 30 * MIN, NOW), false);
  assert.equal(fetchDue(NOW - 30 * MIN, 30 * MIN, NOW), true);
  assert.equal(fetchDue(NOW - 29 * MIN - 59_000, 30 * MIN, NOW), false);
  assert.equal(fetchDue(null, 0, NOW), false);
});
