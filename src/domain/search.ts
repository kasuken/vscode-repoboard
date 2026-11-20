import { GitStatus, Project, ProjectMeta, SortMode, changedFiles, pendingCount, stashCount } from './model';

/**
 * Browser-safe search and sort, shared by the webview and the extension host.
 * No Node imports in this file.
 */

/**
 * Fuzzy score of `query` against `text`; 0 means no match. Characters must appear in order.
 * Consecutive runs and word-start hits score higher, so "rb" ranks "repo-board" above "rubber".
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) {
    return 1;
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    // Substring hits always beat scattered ones; earlier and word-start hits beat later ones.
    return 1000 - Math.min(direct, 200) + (isWordStart(text, direct) ? 100 : 0) + q.length * 10;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
      run = 0;
    }
    if (found < 0) {
      return 0;
    }
    run++;
    score += 1 + run * 2 + (isWordStart(text, found) ? 8 : 0);
    ti++;
  }
  return score;
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  const prev = text[i - 1]!;
  const cur = text[i]!;
  return /[\s\-_./\\:]/.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
}

export interface SearchFields {
  name: string;
  path: string;
  description?: string | undefined;
  tags: readonly string[];
  branch?: string | undefined;
  languages: readonly string[];
  collection?: string | undefined;
  /** Branches checked out in linked worktrees, so an agent's branch finds its repo. */
  worktreeBranches?: readonly string[];
}

export function fieldsOf(project: Project, meta: ProjectMeta | undefined, collectionName?: string): SearchFields {
  return {
    name: project.name,
    path: project.path,
    description: project.description,
    tags: project.tags,
    branch: meta?.git?.branch,
    languages: meta?.languages.map((l) => l.name) ?? [],
    collection: collectionName,
    worktreeBranches: meta?.git?.worktrees?.map((w) => w.branch) ?? [],
  };
}

/**
 * Every whitespace-separated token must match some field. `#tag` tokens match tags only.
 * The name is weighted highest. Returns 0 when any token misses.
 */
export function matchScore(query: string, fields: SearchFields): number {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return 1;
  }
  let total = 0;
  for (const token of tokens) {
    if (token.startsWith('#') && token.length > 1) {
      const wanted = token.slice(1).toLowerCase();
      const hit = fields.tags.some((t) => t.toLowerCase().startsWith(wanted));
      if (!hit) {
        return 0;
      }
      total += 500;
      continue;
    }
    const best = Math.max(
      fuzzyScore(token, fields.name) * 3,
      substringOnly(token, fields.path),
      substringOnly(token, fields.description ?? ''),
      ...fields.tags.map((t) => substringOnly(token, t) * 2),
      substringOnly(token, fields.branch ?? ''),
      ...fields.languages.map((l) => substringOnly(token, l)),
      substringOnly(token, fields.collection ?? ''),
      ...(fields.worktreeBranches ?? []).map((b) => substringOnly(token, b) / 2),
    );
    if (best <= 0) {
      return 0;
    }
    total += best;
  }
  return total;
}

/** Long fields (paths, descriptions) only match as substrings: fuzzy over them is noise. */
function substringOnly(token: string, text: string): number {
  return text && text.toLowerCase().includes(token.toLowerCase()) ? 300 : 0;
}

function commitTime(git: GitStatus | null | undefined): number {
  return git?.lastCommit?.time ?? 0;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Returns a sorted copy. `manual` keeps catalog order. Ties fall back to name. */
export function sortProjects(projects: readonly Project[], meta: Readonly<Record<string, ProjectMeta | undefined>>, mode: SortMode): Project[] {
  const byName = (a: Project, b: Project) => collator.compare(a.name, b.name);
  const copy = [...projects];
  switch (mode) {
    case 'manual':
      return copy;
    case 'name':
      return copy.sort(byName);
    case 'recent':
      return copy.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || byName(a, b));
    case 'commit':
      return copy.sort((a, b) => commitTime(meta[b.id]?.git) - commitTime(meta[a.id]?.git) || byName(a, b));
    case 'changes':
      return copy.sort(
        (a, b) =>
          pendingCount(meta[b.id]?.git) - pendingCount(meta[a.id]?.git) ||
          changedFiles(meta[b.id]?.git) - changedFiles(meta[a.id]?.git) ||
          stashCount(meta[b.id]?.git) - stashCount(meta[a.id]?.git) ||
          byName(a, b),
      );
  }
}

/** "3 min ago", "2 days ago", from a unix-ms timestamp. */
export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  const units: Array<[number, string]> = [
    [60, 'min'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let chosen: [number, string] = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[0] * 0.9) {
      chosen = unit;
    }
  }
  const value = Math.max(1, Math.round(seconds / chosen[0]));
  return `${value} ${chosen[1]}${value === 1 ? '' : 's'} ago`;
}
