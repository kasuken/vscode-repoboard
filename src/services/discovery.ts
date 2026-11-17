import { Dirent, promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface DiscoveryOptions {
  /** Levels below each root that are searched (root itself = 0). */
  maxDepth: number;
  ignoreDirs: Iterable<string>;
  /** Safety cap on directories visited per root. */
  maxDirs?: number;
  /** Checked between directories; return true to stop early. */
  cancelled?: () => boolean;
}

/**
 * Finds git repositories under `roots` with a breadth-first walk.
 *  - stops descending at the first `.git` (a directory or a worktree / submodule file);
 *  - never follows symlinks or Windows junctions, so loops and huge mounted trees are skipped;
 *  - skips hidden folders and the ignore list, and is bounded by depth and a directory cap.
 */
export async function discoverRepos(roots: readonly string[], options: DiscoveryOptions): Promise<string[]> {
  const ignore = new Set([...options.ignoreDirs].map((d) => d.toLowerCase()));
  const maxDirs = options.maxDirs ?? 20_000;
  const found: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let rootStat;
    try {
      rootStat = await fs.lstat(root);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory()) {
      continue;
    }
    const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root), depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < maxDirs) {
      if (options.cancelled?.()) {
        return found;
      }
      const { dir, depth } = queue.shift()!;
      visited++;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
        const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
        if (!seen.has(key)) {
          seen.add(key);
          found.push(dir);
        }
        continue;
      }
      if (depth >= options.maxDepth) {
        continue;
      }
      for (const entry of entries) {
        // Dirent.isDirectory() is false for symlinks and junctions, so they are never followed.
        if (!entry.isDirectory() || entry.name.startsWith('.') || ignore.has(entry.name.toLowerCase())) {
          continue;
        }
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}
