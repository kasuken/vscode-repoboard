import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { cleanFetchError, isConcurrentFetchError } from '../domain/gitParse';
import { Availability, GitStatus, ProjectMeta } from '../domain/model';
import { folderOf, pathKey } from '../domain/paths';
import { GitClient } from './git';
import { ScanOptions, findLogo, scanLanguages } from './languageScanner';

/** Runs at most `size` async jobs at once. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface MetadataOptions {
  cacheMs: () => number;
  detectLanguages: () => boolean;
  scanOptions: () => ScanOptions;
}

export interface RefreshOptions {
  /** Ignore the cache TTL. */
  force?: boolean;
  /** Also `git fetch` repos with an upstream (network) before counting ahead/behind. */
  fetch?: boolean;
}

const LANGUAGE_TTL_MS = 24 * 3_600_000;
export const FETCH_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * Derived per-project state (git, languages, logo), cached on disk so the dashboard renders
 * instantly from the last known state while fresh data streams in.
 *
 * Events: `update` (key, meta) and `busy` (key, boolean). Keys are `pathKey(project.path)`.
 */
export class MetadataService extends EventEmitter {
  private cache: Record<string, ProjectMeta> = {};
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly local = new Limiter(6);
  private readonly network = new Limiter(4);
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(readonly git: GitClient, private readonly cacheFile: string, private readonly options: MetadataOptions) {
    super();
  }

  async loadCache(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.cache = parsed;
      }
    } catch {
      this.cache = {};
    }
  }

  get(projectPath: string): ProjectMeta | undefined {
    return this.cache[pathKey(projectPath)];
  }

  isBusy(projectPath: string): boolean {
    return this.busy.has(pathKey(projectPath));
  }

  /** Refreshes many projects; resolves when all are done. Updates stream out as `update` events. */
  async refresh(paths: readonly string[], options: RefreshOptions = {}): Promise<void> {
    await Promise.all(paths.map((p) => this.refreshOne(p, options)));
  }

  refreshOne(projectPath: string, options: RefreshOptions = {}): Promise<void> {
    const key = pathKey(projectPath);
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const job = this.doRefresh(projectPath, key, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async doRefresh(projectPath: string, key: string, options: RefreshOptions): Promise<void> {
    const previous = this.cache[key];
    const now = Date.now();
    const localFresh = previous && now - previous.updatedAt < this.options.cacheMs();
    const wantsFetch =
      options.fetch === true &&
      !!previous?.git?.upstream &&
      (options.force || now - (previous.git.lastFetchAt ?? previous.git.fetchedAt ?? 0) > FETCH_MIN_INTERVAL_MS);

    if (localFresh && !options.force && !wantsFetch) {
      return;
    }
    this.setBusy(key, true);
    try {
      let meta = await this.local.run(() => this.readLocal(projectPath, previous));
      this.store(key, meta);

      if (options.fetch && meta.availability === 'ok' && meta.git?.upstream && (wantsFetch || !previous)) {
        const fetched = await this.network.run(() => this.git.fetch(folderOf(projectPath)));
        if (fetched.ok) {
          const git = await this.local.run(() => this.git.status(folderOf(projectPath)));
          meta = { ...meta, git: git ? withFetchedAt(git, Date.now()) : null };
          this.store(key, meta);
        } else if (isConcurrentFetchError(fetched.message)) {
          // Someone else is fetching this repo right now: not a failure. Show what their fetch has written so far.
          meta = await this.local.run(() => this.readLocal(projectPath, this.cache[key]));
          this.store(key, meta);
        } else {
          this.recordFetch(projectPath, fetched);
        }
      }
    } finally {
      this.setBusy(key, false);
    }
  }

  private async readLocal(projectPath: string, previous: ProjectMeta | undefined): Promise<ProjectMeta> {
    const availability = await availabilityOf(projectPath);
    const now = Date.now();
    if (availability !== 'ok') {
      // Keep the last known details so an unplugged drive still shows something useful.
      return { availability, git: previous?.git ?? null, languages: previous?.languages ?? [], ...(previous?.logo ? { logo: previous.logo } : {}), updatedAt: now, languagesAt: previous?.languagesAt ?? 0 };
    }
    const folder = folderOf(projectPath);

    const scanLangs = this.options.detectLanguages() && (!previous || now - previous.languagesAt > LANGUAGE_TTL_MS);
    const [git, languages, logo] = await Promise.all([
      this.git.status(folder),
      scanLangs ? scanLanguages(folder, this.options.scanOptions()) : Promise.resolve(previous?.languages ?? []),
      findLogo(folder),
    ]);
    if (git && previous?.git?.fetchedAt) {
      git.fetchedAt = previous.git.fetchedAt;
      if (git.upstream) git.lastFetchAt = Math.max(git.lastFetchAt ?? 0, git.fetchedAt);
    }
    // A plain status read says nothing about the network: keep what the last fetch told us.
    if (git && git.upstream && previous?.git?.fetchError) {
      git.fetchError = previous.git.fetchError;
    }
    const meta: ProjectMeta = {
      availability,
      git,
      languages: this.options.detectLanguages() ? languages : [],
      updatedAt: now,
      languagesAt: scanLangs ? now : previous?.languagesAt ?? 0,
    };
    if (logo) {
      meta.logo = logo;
    }
    return meta;
  }

  /**
   * Records the outcome of a fetch that ran elsewhere (the user's fetch / pull, or a failed background fetch) on the
   * cached git status: success clears `fetchError` and stamps `fetchedAt`; failure stores a cleaned `fetchError`.
   * A failure caused by another process fetching the same repo at the same moment is not recorded.
   * `quietFailure` records only successes (the scheduler uses it when a cycle looks like "offline").
   */
  recordFetch(projectPath: string, result: { ok: boolean; message: string }, options: { quietFailure?: boolean } = {}): void {
    const key = pathKey(projectPath);
    const previous = this.cache[key];
    if (!previous?.git) return;
    let git: GitStatus;
    if (!result.ok && isConcurrentFetchError(result.message)) {
      return;
    }
    if (result.ok) {
      git = withFetchedAt(previous.git, Date.now());
    } else if (options.quietFailure) {
      return;
    } else {
      git = { ...previous.git, fetchError: cleanFetchError(result.message) || 'git fetch failed' };
    }
    this.store(key, { ...previous, git });
  }

  /**
   * Scheduled background fetch of one repo: runs through the same network limiter and in-flight map as refreshes, so it
   * never overlaps a manual refresh of the same repo. A success re-reads the status and clears `fetchError`; a failure
   * is recorded unless `quietFailure`.
   *  - `recheck` runs inside the limiter slot, right before git starts: it may have waited behind other fetches, and
   *    another window or tool may have fetched the repo meanwhile. Returning false gives 'skipped'.
   *  - 'skipped' also means the repo is already being refreshed.
   *  - 'concurrent' means another process holds git's locks for this repo (it is being fetched elsewhere): neither a
   *    failure nor offline.
   */
  async fetchInBackground(
    projectPath: string,
    options: { quietFailure?: boolean; recheck?: () => Promise<boolean> } = {},
  ): Promise<{ outcome: 'ok' | 'failed' | 'skipped' | 'concurrent'; message: string }> {
    const key = pathKey(projectPath);
    if (this.inFlight.has(key)) return { outcome: 'skipped', message: '' };
    let result: { outcome: 'ok' | 'failed' | 'skipped' | 'concurrent'; message: string } = { outcome: 'failed', message: '' };
    const job = (async () => {
      try {
        const fetched = await this.network.run(async () => ((await options.recheck?.()) === false ? null : this.git.fetch(folderOf(projectPath))));
        if (!fetched) {
          result = { outcome: 'skipped', message: '' };
          return;
        }
        const concurrent = !fetched.ok && isConcurrentFetchError(fetched.message);
        result = { outcome: fetched.ok ? 'ok' : concurrent ? 'concurrent' : 'failed', message: fetched.message };
        if (fetched.ok) {
          const meta = await this.local.run(() => this.readLocal(projectPath, this.cache[key]));
          this.store(key, meta.git ? { ...meta, git: withFetchedAt(meta.git, Date.now()) } : meta);
        } else if (concurrent) {
          // Another process is fetching this repo: not a failure and not offline. Just show its current state.
          this.store(key, await this.local.run(() => this.readLocal(projectPath, this.cache[key])));
        } else if (!options.quietFailure) {
          this.recordFetch(projectPath, fetched);
        }
      } catch (e) {
        result = { outcome: 'failed', message: e instanceof Error ? e.message : String(e) };
      }
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    await job;
    return result;
  }

  private store(key: string, meta: ProjectMeta): void {
    this.cache[key] = meta;
    this.emit('update', key, meta);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 1500);
  }

  private setBusy(key: string, busy: boolean): void {
    if (busy) {
      this.busy.add(key);
    } else {
      this.busy.delete(key);
    }
    this.emit('busy', key, busy);
  }

  /** Drops cache entries for projects that no longer exist in the catalog. */
  prune(keepPaths: readonly string[]): void {
    const keep = new Set(keepPaths.map((p) => pathKey(p)));
    for (const key of Object.keys(this.cache)) {
      if (!keep.has(key)) {
        delete this.cache[key];
      }
    }
  }

  async persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.writeFile(this.cacheFile, JSON.stringify(this.cache), 'utf8');
    } catch {
      // The cache is disposable.
    }
  }
}

async function availabilityOf(projectPath: string): Promise<Availability> {
  try {
    await fs.stat(projectPath);
    return 'ok';
  } catch {
    // If the drive / share root is gone too, it's unplugged rather than deleted.
    try {
      await fs.stat(path.parse(path.resolve(projectPath)).root);
      return 'missing';
    } catch {
      return 'offline';
    }
  }
}

/** Records our own successful fetch: it counts as "last fetched" and clears any earlier fetch error. */
export function withFetchedAt(git: GitStatus, at: number): GitStatus {
  const { fetchError: _cleared, ...rest } = git;
  return { ...rest, fetchedAt: at, ...(git.upstream ? { lastFetchAt: Math.max(git.lastFetchAt ?? 0, at) } : {}) };
}
