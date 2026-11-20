import { fetchDue } from '../domain/freshness';
import { Project } from '../domain/model';
import { folderOf } from '../domain/paths';
import { gitLastFetch } from './git';
import { MetadataService } from './metadata';

/** How often the scheduler wakes up. Each wake-up only fetches the repos that are actually due. */
export const AUTO_FETCH_TICK_MS = 60_000;
/** Every window has its own extension host; a random delay before the first tick keeps them from firing together. */
export const AUTO_FETCH_MAX_JITTER_MS = 30_000;

export interface AutoFetchDeps {
  meta: MetadataService;
  projects: () => readonly Project[];
  /** Minutes between fetches of each repo; 0 = off. */
  intervalMinutes: () => number;
  /** True while Fetch all / Pull all runs: a cycle must not start then. */
  busy: () => boolean;
  /** Called when the "every attempted fetch failed" condition appears or clears. */
  onOffline: (offline: boolean) => void;
  /** Writes a line to the log; defaults to nothing. */
  log?: (line: string) => void;
  /** When the remote was last fetched by anyone, read from disk (defaults to the real thing). */
  lastFetch?: (folder: string) => Promise<number | null>;
  now?: () => number;
  /** Tests shrink these. */
  tickMs?: number;
  jitterMs?: () => number;
}

export interface CycleResult {
  fetched: number;
  failed: number;
  skipped: number;
  offline: boolean;
}

/**
 * Keeps ahead/behind counts current: every minute it looks for repos whose last fetch (by ANY tool: the timestamp is
 * read from disk, so other VS Code windows, the desktop app and the CLI all count) is older than the configured
 * interval and fetches them through the metadata service. The decision is made twice: when the cycle is planned and
 * again inside the network slot right before git starts, because the slot may have waited behind other fetches.
 */
export class AutoFetcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private running = false;
  private offline = false;
  /** When we last tried each repo, so a repo that keeps failing is retried once per interval, not once a minute. */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: AutoFetchDeps) {}

  get isOffline(): boolean {
    return this.offline;
  }

  get timerActive(): boolean {
    return this.timer !== undefined;
  }

  /** Begins scheduling. The first cycle runs one tick plus a random 0-30 s from now. */
  start(): void {
    this.active = true;
    this.sync();
  }

  /** Applies the current setting: timer on when started and the interval is > 0, otherwise off (and "offline" forgotten). */
  sync(): void {
    if (!this.active || this.deps.intervalMinutes() <= 0) {
      this.clear();
      this.setOffline(false);
      return;
    }
    if (this.timer) return; // already ticking; the next cycle reads the new interval
    const tick = this.deps.tickMs ?? AUTO_FETCH_TICK_MS;
    const jitter = (this.deps.jitterMs ?? (() => Math.random() * AUTO_FETCH_MAX_JITTER_MS))();
    const schedule = (delay: number): void => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.active) return;
        schedule(tick);
        void this.runCycle().catch((e) => this.deps.log?.(`[auto-fetch] ${e instanceof Error ? e.message : String(e)}`));
      }, delay);
      // Never keep a Node process (tests) alive for this timer.
      (this.timer as { unref?: () => void }).unref?.();
    };
    schedule(tick + jitter);
  }

  stop(): void {
    this.active = false;
    this.sync();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A fetch the user ran succeeded, so the network works. */
  noteOnline(): void {
    this.setOffline(false);
  }

  private setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    this.deps.onOffline(offline);
  }

  /**
   * One scheduler pass. Returns undefined when it did not run (off, or another cycle / bulk operation is running).
   * `minAgeMs` overrides the interval setting for one pass (fetch on open, the board's refresh button), so those
   * fetches get the same dedupe and the same offline handling even when the scheduled fetch is turned off.
   */
  async runCycle(options: { minAgeMs?: number } = {}): Promise<CycleResult | undefined> {
    const minutes = this.deps.intervalMinutes();
    const scheduled = options.minAgeMs === undefined;
    if ((scheduled && minutes <= 0) || this.running || this.deps.busy()) return undefined;
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const intervalMs = scheduled ? minutes * 60_000 : options.minAgeMs!;
      const { meta } = this.deps;
      const lastFetch = this.deps.lastFetch ?? gitLastFetch;
      // fetchDue treats 0 as "off"; a one-off pass with minAgeMs 0 means "fetch everything now".
      const due = (last: number) => intervalMs <= 0 || fetchDue(last, intervalMs, now);
      const known = (path: string, onDisk: number | null) => {
        const cached = meta.get(path)?.git;
        return Math.max(onDisk ?? 0, cached?.lastFetchAt ?? 0, cached?.fetchedAt ?? 0);
      };
      const candidates = this.deps.projects().filter((p) => {
        const m = meta.get(p.path);
        return m?.availability === 'ok' && !!m.git?.upstream && !m.git.error && !meta.isBusy(p.path);
      });
      let fetched = 0;
      let skipped = 0;
      const failures: Array<{ path: string; message: string }> = [];
      await Promise.all(
        candidates.map(async (p) => {
          const folder = folderOf(p.path);
          // Another window, the desktop app or the CLI may have fetched since our last status read.
          const onDisk = await lastFetch(folder).catch(() => null);
          const shownLastFetch = meta.get(p.path)?.git?.lastFetchAt ?? 0;
          // Someone else fetched since we last looked: their fetch may have moved ahead/behind, so re-read the status
          // (local only, no network) and the tile shows the new counts and time.
          const rereadIfNewer = async (disk: number | null) => {
            if ((disk ?? 0) > shownLastFetch) await meta.refreshOne(p.path, { force: true });
          };
          if (!due(Math.max(known(p.path, onDisk), this.attempts.get(p.path) ?? 0))) {
            skipped++;
            await rereadIfNewer(onDisk);
            return;
          }
          this.attempts.set(p.path, now);
          let recheckedDisk: number | null = onDisk;
          const r = await meta.fetchInBackground(p.path, {
            quietFailure: true,
            // Inside the limiter slot, right before git starts: the time we planned on may be minutes old by now.
            recheck: async () => {
              recheckedDisk = await lastFetch(folder).catch(() => null);
              return due(known(p.path, recheckedDisk));
            },
          });
          if (r.outcome === 'ok') {
            fetched++;
          } else if (r.outcome === 'skipped' || r.outcome === 'concurrent') {
            // skipped: already refreshing, or fetched elsewhere while we waited. concurrent: someone else is fetching it right now.
            skipped++;
            if (r.outcome === 'skipped') await rereadIfNewer(recheckedDisk);
          } else {
            failures.push({ path: p.path, message: r.message });
          }
        }),
      );
      const offline = failures.length >= 2 && fetched === 0;
      if (offline) {
        // One condition, not N errors; try again on the next tick.
        for (const f of failures) this.attempts.delete(f.path);
        this.setOffline(true);
      } else {
        for (const f of failures) meta.recordFetch(f.path, { ok: false, message: f.message });
        if (fetched > 0) this.setOffline(false);
      }
      this.deps.log?.(`[auto-fetch] fetched ${fetched}, failed ${failures.length}, skipped ${skipped} (fresh)`);
      return { fetched, failed: failures.length, skipped, offline };
    } finally {
      this.running = false;
    }
  }
}
