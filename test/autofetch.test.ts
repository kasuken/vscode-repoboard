import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { cleanFetchError, isConcurrentFetchError } from '../src/domain/gitParse';
import type { GitStatus, Project } from '../src/domain/model';
import { AutoFetcher } from '../src/services/autoFetch';
import { GitClient, gitLastFetch } from '../src/services/git';
import { MetadataService, withFetchedAt } from '../src/services/metadata';

const MIN = 60_000;
const git = (extra: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, upstream: 'origin/main', ...extra });

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-fetch-'));
const metas: MetadataService[] = [];
after(async () => {
  for (const m of metas) await m.persist();
  rmSync(tmp, { recursive: true, force: true });
});

test('cleanFetchError: picks the fatal line, strips credentials, caps the length', () => {
  assert.equal(cleanFetchError(''), '');
  assert.equal(cleanFetchError('remote: Something\nfatal: unable to access\n'), 'fatal: unable to access');
  assert.equal(cleanFetchError('hint: use x\nwarning: y\nfrom somewhere\n'), 'from somewhere');
  assert.equal(
    cleanFetchError("fatal: unable to access 'https://user:s3cret@github.com/a/b.git/': Could not resolve host"),
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host",
  );
  assert.equal(cleanFetchError("fatal: Authentication failed for 'https://token123@dev.azure.com/acme/_git/x'"), "fatal: Authentication failed for 'https://dev.azure.com/acme/_git/x'");
  // A password that itself contains "@".
  const tricky = cleanFetchError('fatal: bad https://me:p@ss@host.example/x.git here');
  assert.ok(!tricky.includes('p@ss') && !tricky.includes('ss@') && !tricky.includes('me:'), tricky);
  assert.equal(tricky, 'fatal: bad https://host.example/x.git here');
  assert.equal(cleanFetchError('ssh://git:pw@host/x'), 'ssh://host/x');
  const long = cleanFetchError(`fatal: ${'x'.repeat(500)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('isConcurrentFetchError: lock collisions are recognised, network and credential failures are not', () => {
  assert.equal(isConcurrentFetchError("error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d"), true);
  assert.equal(isConcurrentFetchError("fatal: Unable to create '/r/a/.git/refs/remotes/origin/main.lock': File exists.\n\nAnother git process seems to be running"), true);
  assert.equal(isConcurrentFetchError("error: unable to update local ref 'refs/remotes/origin/main'"), true);
  assert.equal(isConcurrentFetchError("FATAL: UNABLE TO CREATE '/r/a/.git/FETCH_HEAD.lock': FILE EXISTS."), true);
  assert.equal(isConcurrentFetchError(''), false);
  assert.equal(isConcurrentFetchError('fatal: unable to access: Could not resolve host'), false);
  assert.equal(isConcurrentFetchError("fatal: Authentication failed for 'https://h.example/x'"), false);
  assert.equal(isConcurrentFetchError("fatal: Unable to create '/r/a/.git/index.lock': Permission denied"), false);
});

test('withFetchedAt keeps the newest of FETCH_HEAD time and our own fetch, and clears the error', () => {
  assert.equal(withFetchedAt(git({ lastFetchAt: 100 }), 500).lastFetchAt, 500);
  assert.equal(withFetchedAt(git({ lastFetchAt: 900 }), 500).lastFetchAt, 900);
  assert.equal(withFetchedAt(git(), 500).lastFetchAt, 500);
  assert.equal(withFetchedAt(git(), 500).fetchedAt, 500);
  assert.equal(withFetchedAt(git({ fetchError: 'fatal: x' }), 500).fetchError, undefined);
  const { upstream: _u, ...local } = git();
  assert.equal(withFetchedAt(local as GitStatus, 500).lastFetchAt, undefined);
});

// ── gitLastFetch against real files ────────────────────────────────────────

const touch = (file: string, minutesAgo: number) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  const t = (Date.now() - minutesAgo * MIN) / 1000;
  utimesSync(file, t, t);
};
const ageMin = (ms: number | null) => Math.round((Date.now() - ms!) / MIN);

test('gitLastFetch: FETCH_HEAD of a normal repo; nothing when never fetched', async () => {
  const repo = path.join(tmp, 'normal');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.equal(await gitLastFetch(repo), null);
  touch(path.join(repo, '.git', 'FETCH_HEAD'), 60);
  assert.equal(ageMin(await gitLastFetch(repo)), 60);
  assert.equal(await gitLastFetch(path.join(tmp, 'missing')), null);
});

test('gitLastFetch: an empty FETCH_HEAD (left by a failed fetch) is not a fetch', async () => {
  const repo = path.join(tmp, 'failed');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeFileSync(path.join(repo, '.git', 'FETCH_HEAD'), '');
  assert.equal(await gitLastFetch(repo), null);
});

test('gitLastFetch: a linked worktree sees the common dir and its sibling worktrees', async () => {
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(path.join(main, '.git', 'worktrees', 'other'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(await gitLastFetch(wt), null);
  touch(path.join(main, '.git', 'FETCH_HEAD'), 120);
  touch(path.join(main, '.git', 'worktrees', 'other', 'FETCH_HEAD'), 10);
  touch(path.join(main, '.git', 'worktrees', 'wt', 'FETCH_HEAD'), 1440);
  assert.equal(ageMin(await gitLastFetch(wt)), 10);
  assert.equal(ageMin(await gitLastFetch(main)), 10);
});

test('gitLastFetch: falls back to the remote-tracking reflogs, which a fresh clone has', async () => {
  const repo = path.join(tmp, 'clone');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  touch(path.join(repo, '.git', 'logs', 'refs', 'remotes', 'origin', 'HEAD'), 20);
  touch(path.join(repo, '.git', 'logs', 'refs', 'remotes', 'origin', 'feature', 'deep', 'topic'), 8);
  touch(path.join(repo, '.git', 'logs', 'HEAD'), 1);
  assert.equal(ageMin(await gitLastFetch(repo)), 8);
});

// ── The scheduler, with a scripted git ─────────────────────────────────────

interface FakeRepo {
  lastFetch?: number | null;
  /** `git fetch` fails with this message. */
  fetchError?: string;
  upstream?: string;
}

/** Git replaced by a map: status reads what the repo "says", fetch obeys `fetchError` and can be held open. */
class FakeGit extends GitClient {
  readonly fetches: string[] = [];
  hold: Map<string, () => void> | undefined;
  constructor(readonly repos: Map<string, FakeRepo>) {
    super();
  }
  override async status(folder: string): Promise<GitStatus | null> {
    const r = this.repos.get(folder);
    if (!r) return null;
    const upstream = 'upstream' in r ? r.upstream : 'origin/main';
    const status = git({ ...(upstream && r.lastFetch ? { lastFetchAt: r.lastFetch } : {}) });
    if (!upstream) delete status.upstream;
    return status;
  }
  override async fetch(folder: string): Promise<{ ok: boolean; message: string }> {
    this.fetches.push(folder);
    if (this.hold) await new Promise<void>((resolve) => this.hold!.set(folder, resolve));
    const r = this.repos.get(folder);
    if (r?.fetchError) return { ok: false, message: r.fetchError };
    if (r) r.lastFetch = Date.now();
    return { ok: true, message: '' };
  }
}

let seq = 0;
function setup(repos: Record<string, FakeRepo>, options: { minutes?: number; busy?: () => boolean; tickMs?: number; jitterMs?: () => number } = {}) {
  const base = path.join(tmp, `sched${seq++}`);
  const map = new Map<string, FakeRepo>();
  for (const [name, repo] of Object.entries(repos)) {
    const folder = path.join(base, name);
    mkdirSync(folder, { recursive: true });
    map.set(folder, repo);
  }
  const fake = new FakeGit(map);
  const meta = new MetadataService(fake, path.join(base, 'meta.json'), { cacheMs: () => 0, detectLanguages: () => false, scanOptions: () => ({ ignoreDirs: [], maxFiles: 100 }) });
  metas.push(meta);
  const projects = [...map.keys()].map((p, i) => ({ id: `p${i}`, name: path.basename(p), path: p }) as unknown as Project);
  const offline: boolean[] = [];
  const fetcher = new AutoFetcher({
    meta,
    projects: () => projects,
    intervalMinutes: () => options.minutes ?? 30,
    busy: options.busy ?? (() => false),
    onOffline: (o) => offline.push(o),
    lastFetch: async (folder) => map.get(folder)?.lastFetch ?? null,
    ...(options.tickMs ? { tickMs: options.tickMs } : {}),
    ...(options.jitterMs ? { jitterMs: options.jitterMs } : {}),
  });
  const f = (name: string) => path.join(base, name);
  return { map, fake, meta, projects, fetcher, offline, f, all: () => [...map.keys()] };
}

test('metadata stores, preserves and clears fetchError', async () => {
  const { fake, meta, f, all } = setup({ a: { fetchError: "fatal: Authentication failed for 'https://u:p@h.example/x'" } });
  await meta.refresh(all(), { force: true });
  assert.equal(meta.get(f('a'))?.git?.fetchError, undefined);

  // A failed fetch through refresh stores the cleaned error.
  await meta.refresh(all(), { force: true, fetch: true });
  assert.equal(meta.get(f('a'))?.git?.fetchError, "fatal: Authentication failed for 'https://h.example/x'");
  assert.equal(fake.fetches.length, 1);

  // Plain status re-reads keep it.
  await meta.refresh(all(), { force: true });
  assert.equal(meta.get(f('a'))?.git?.fetchError, "fatal: Authentication failed for 'https://h.example/x'");

  // The user's own successful fetch clears it and stamps fetchedAt.
  meta.recordFetch(f('a'), { ok: true, message: '' });
  assert.equal(meta.get(f('a'))?.git?.fetchError, undefined);
  assert.ok((meta.get(f('a'))?.git?.fetchedAt ?? 0) > 0);
  await meta.refresh(all(), { force: true });
  assert.equal(meta.get(f('a'))?.git?.fetchError, undefined);

  // The user's failed fetch stores it again; a later background success clears it.
  meta.recordFetch(f('a'), { ok: false, message: 'fatal: nope' });
  assert.equal(meta.get(f('a'))?.git?.fetchError, 'fatal: nope');
  fake.repos.get(f('a'))!.fetchError = undefined;
  assert.equal((await meta.fetchInBackground(f('a'))).outcome, 'ok');
  assert.equal(meta.get(f('a'))?.git?.fetchError, undefined);
});

test('wantsFetch uses the newest of lastFetchAt and fetchedAt', async () => {
  const { fake, meta, all } = setup({ a: { lastFetch: Date.now() - MIN } });
  await meta.refresh(all(), { force: true });
  await meta.refresh(all(), { fetch: true });
  assert.equal(fake.fetches.length, 0, 'fetched one minute ago by another tool: no fetch');
});

test('scheduler: skips repos fetched recently (re-read from disk), fetches due ones', async () => {
  const { map, fake, meta, fetcher, f, all } = setup({
    fresh: { lastFetch: Date.now() - 5 * MIN },
    due: { lastFetch: Date.now() - 120 * MIN },
    never: {},
    local: { upstream: '' },
  });
  await meta.refresh(all(), { force: true });
  // Another tool fetches "due" between our status read and the cycle.
  map.get(f('due'))!.lastFetch = Date.now() - MIN;
  const r = await fetcher.runCycle();
  assert.deepEqual(fake.fetches, [f('never')]);
  assert.equal(r?.fetched, 1);
  assert.equal(r?.failed, 0);
  assert.equal(r?.skipped, 2);
  assert.ok((meta.get(f('never'))?.git?.fetchedAt ?? 0) > 0);

  // The next cycle has nothing to do.
  fake.fetches.length = 0;
  assert.equal((await fetcher.runCycle())?.fetched, 0);
  assert.deepEqual(fake.fetches, []);
});

test('scheduler: re-reads the on-disk time inside the limiter slot, right before git starts', async () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const { map, fake, meta, fetcher, f, all } = setup(Object.fromEntries(names.map((n) => [n, {}])));
  await meta.refresh(all(), { force: true });
  fake.hold = new Map(); // every fetch stays open until released: the network limiter has 4 slots, so one repo waits
  const cycle = fetcher.runCycle();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fake.fetches.length, 4);
  const waiting = names.map(f).find((p) => !fake.fetches.includes(p))!;
  // While it waits for a slot, another window fetches it.
  map.get(waiting)!.lastFetch = Date.now();
  for (const release of fake.hold.values()) release();
  fake.hold = undefined;
  const r = await cycle;
  assert.equal(fake.fetches.length, 4, 'the waiting repo was not fetched a second time');
  assert.ok(!fake.fetches.includes(waiting));
  assert.equal(r?.fetched, 4);
  assert.equal(r?.skipped, 1);
  assert.ok((meta.get(waiting)?.git?.lastFetchAt ?? 0) > Date.now() - 5000, 'its status was re-read, so the tile shows the new time');
});

test('scheduler: a lone failure is stored per repo and retried once per interval', async () => {
  const { fake, meta, fetcher, offline, f, all } = setup({ bad: { fetchError: 'fatal: Authentication failed' }, ok: { lastFetch: Date.now() - 5 * MIN } });
  await meta.refresh(all(), { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.failed, 1);
  assert.equal(r?.offline, false);
  assert.equal(meta.get(f('bad'))?.git?.fetchError, 'fatal: Authentication failed');
  assert.deepEqual(offline, []);
  fake.fetches.length = 0;
  await fetcher.runCycle();
  assert.deepEqual(fake.fetches, [], 'not retried a minute later');
});

test('scheduler: every fetch failing means offline, with no per-repo errors; a success clears it', async () => {
  const msg = 'fatal: unable to access: Could not resolve host';
  const { map, meta, fetcher, offline, f, all } = setup({ a: { fetchError: msg }, b: { fetchError: msg }, c: { fetchError: msg } });
  await meta.refresh(all(), { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.offline, true);
  assert.equal(r?.failed, 3);
  assert.equal(fetcher.isOffline, true);
  assert.deepEqual(offline, [true]);
  for (const n of ['a', 'b', 'c']) assert.equal(meta.get(f(n))?.git?.fetchError, undefined);

  // Offline repos are retried on the next cycle; once the network is back the flag clears.
  for (const repo of map.values()) repo.fetchError = undefined;
  const again = await fetcher.runCycle();
  assert.equal(again?.fetched, 3);
  assert.equal(fetcher.isOffline, false);
  assert.deepEqual(offline, [true, false]);
});

test('scheduler: a mix of success and failure is not offline', async () => {
  const { meta, fetcher, f, all } = setup({ a: { fetchError: 'fatal: x' }, b: { fetchError: 'fatal: y' }, c: {} });
  await meta.refresh(all(), { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.offline, false);
  assert.equal(meta.get(f('a'))?.git?.fetchError, 'fatal: x');
  assert.equal(meta.get(f('b'))?.git?.fetchError, 'fatal: y');
});

test('a fetch that collided with another process is not a failure and not offline', async () => {
  const lock = "error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d";
  const { meta, fetcher, offline, f, all } = setup({ a: { fetchError: lock }, b: { fetchError: lock }, c: { fetchError: lock } });
  await meta.refresh(all(), { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.failed, 0);
  assert.equal(r?.fetched, 0);
  assert.equal(r?.skipped, 3);
  assert.equal(r?.offline, false);
  assert.deepEqual(offline, []);
  for (const n of ['a', 'b', 'c']) assert.equal(meta.get(f(n))?.git?.fetchError, undefined);

  // The same through the metadata service's other paths.
  assert.equal((await meta.fetchInBackground(f('a'))).outcome, 'concurrent');
  await meta.refresh([f('a')], { force: true, fetch: true });
  meta.recordFetch(f('a'), { ok: false, message: lock });
  assert.equal(meta.get(f('a'))?.git?.fetchError, undefined);
  // A genuine failure afterwards is still recorded.
  meta.recordFetch(f('a'), { ok: false, message: 'fatal: nope' });
  assert.equal(meta.get(f('a'))?.git?.fetchError, 'fatal: nope');
});

test('scheduler: interval 0, a busy bulk operation or an overlapping cycle means no cycle', async () => {
  const off = setup({ a: {} }, { minutes: 0 });
  await off.meta.refresh(off.all(), { force: true });
  assert.equal(await off.fetcher.runCycle(), undefined);
  off.fetcher.start();
  assert.equal(off.fetcher.timerActive, false);
  assert.equal(off.fake.fetches.length, 0);

  let bulk = true;
  const busy = setup({ a: {} }, { busy: () => bulk });
  await busy.meta.refresh(busy.all(), { force: true });
  assert.equal(await busy.fetcher.runCycle(), undefined);
  bulk = false;
  const first = busy.fetcher.runCycle();
  assert.equal(await busy.fetcher.runCycle(), undefined, 'a second cycle while the first runs');
  assert.equal((await first)?.fetched, 1);
});

test('scheduler: a one-off pass (open / refresh) runs with the schedule off and still treats an outage as offline', async () => {
  const msg = 'fatal: unable to access: Could not resolve host';
  const { meta, fetcher, offline, f, all } = setup({ a: { fetchError: msg }, b: { fetchError: msg } }, { minutes: 0 });
  await meta.refresh(all(), { force: true });
  assert.equal(await fetcher.runCycle(), undefined, 'the schedule itself is off');
  const r = await fetcher.runCycle({ minAgeMs: 0 });
  assert.equal(r?.failed, 2);
  assert.equal(r?.offline, true);
  assert.deepEqual(offline, [true]);
  for (const n of ['a', 'b']) assert.equal(meta.get(f(n))?.git?.fetchError, undefined);
});

test('scheduler: a repo fetched by another tool is skipped but its status is re-read', async () => {
  const { map, fake, meta, fetcher, f, all } = setup({ a: { lastFetch: Date.now() - 120 * MIN } });
  await meta.refresh(all(), { force: true });
  const shownBefore = meta.get(f('a'))?.git?.lastFetchAt;
  map.get(f('a'))!.lastFetch = Date.now() - 1000; // e.g. `git fetch` in a terminal
  const r = await fetcher.runCycle();
  assert.equal(r?.skipped, 1);
  assert.equal(fake.fetches.length, 0);
  assert.ok((meta.get(f('a'))?.git?.lastFetchAt ?? 0) > (shownBefore ?? 0));
});

test('scheduler: the timer follows the setting; the first tick waits for the random offset', async () => {
  let minutes = 30;
  const { fake, meta, fetcher, projects, all } = setup({ a: {} }, { tickMs: 20, jitterMs: () => 60 });
  await meta.refresh(all(), { force: true });
  void projects;
  const f2 = new AutoFetcher({ meta, projects: () => projects, intervalMinutes: () => minutes, busy: () => false, onOffline: () => {}, lastFetch: async () => null, tickMs: 20, jitterMs: () => 10_000 });
  f2.start();
  assert.equal(f2.timerActive, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.fetches.length, 0, 'the offset (10 s here) has not elapsed');
  minutes = 0;
  f2.sync();
  assert.equal(f2.timerActive, false);
  minutes = 15;
  f2.sync();
  assert.equal(f2.timerActive, true);
  f2.stop();
  assert.equal(f2.timerActive, false);

  // With a short offset the first cycle runs, then the schedule keeps ticking.
  fetcher.start();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fake.fetches.length, 1, 'fetched once, then the repo is fresh');
  fetcher.stop();
});
