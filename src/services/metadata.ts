import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Availability, ProjectMeta } from '../domain/model';
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
const FETCH_MIN_INTERVAL_MS = 10 * 60_000;

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
      (options.force || now - (previous.git.fetchedAt ?? 0) > FETCH_MIN_INTERVAL_MS);

    if (localFresh && !options.force && !wantsFetch) {
      return;
    }
    this.setBusy(key, true);
    try {
      let meta = await this.local.run(() => this.readLocal(projectPath, previous));
      this.store(key, meta);

      if (options.fetch && meta.availability === 'ok' && meta.git?.upstream && (wantsFetch || !previous)) {
        const fetched = await this.network.run(() => this.git.fetch(folderOf(projectPath)));
        if (fetched) {
          const git = await this.local.run(() => this.git.status(folderOf(projectPath)));
          meta = { ...meta, git: git ? { ...git, fetchedAt: Date.now() } : null };
          this.store(key, meta);
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
