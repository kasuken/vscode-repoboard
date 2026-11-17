/**
 * Pure data model shared by the extension host and the webview.
 * Nothing in src/domain may import `vscode`, so it can be unit-tested with plain Node.
 */

export type ProjectSource = 'manual' | 'discovered';

export interface Project {
  id: string;
  name: string;
  /** Absolute folder (or .code-workspace file) path, as the user gave it. */
  path: string;
  description?: string;
  /** Emoji or up to 3 characters shown instead of the auto logo / initials. */
  icon?: string;
  /** Accent colour (#rrggbb). Falls back to the collection colour. */
  color?: string;
  collectionId?: string;
  tags: string[];
  pinned?: boolean;
  source: ProjectSource;
  addedAt: number;
  lastOpenedAt?: number;
}

export interface Collection {
  id: string;
  name: string;
  color?: string;
  collapsed?: boolean;
}

export interface Catalog {
  version: 1;
  /** Array order is the display order. */
  collections: Collection[];
  /** Array order is the manual display order. */
  projects: Project[];
  /** Normalised paths the user removed; discovery never re-adds them. */
  ignoredPaths: string[];
}

export const emptyCatalog = (): Catalog => ({ version: 1, collections: [], projects: [], ignoredPaths: [] });

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
}

export interface GitStatus {
  /** Branch name, or the short hash when detached. */
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  /** Tracked files changed in the working tree. */
  modified: number;
  untracked: number;
  conflicts: number;
  stashes: number;
  lastCommit?: CommitInfo;
  /** Browser URL of the main remote, credentials stripped. */
  webUrl?: string;
  /** When ahead/behind was last compared against a fresh `git fetch` (ms). */
  fetchedAt?: number;
  /** Human-readable reason git could not read the repo (e.g. dubious ownership). */
  error?: string;
}

export interface LanguageShare {
  name: string;
  color: string;
  /** 0–100, one decimal. */
  percent: number;
}

/** `offline`: the drive / share is not connected. `missing`: the folder was deleted or moved. */
export type Availability = 'ok' | 'offline' | 'missing';

export interface ProjectMeta {
  availability: Availability;
  /** `null` when the folder is not a git repository. */
  git: GitStatus | null;
  languages: LanguageShare[];
  /** Small data: URI of a logo found in the project (logo.png, icon.svg, …). */
  logo?: string;
  /** When the local state was read (ms). */
  updatedAt: number;
  /** When languages were scanned (ms, 0 = never). */
  languagesAt: number;
}

export type SortMode = 'manual' | 'recent' | 'name' | 'commit' | 'changes';
export const SORT_MODES: readonly SortMode[] = ['manual', 'recent', 'name', 'commit', 'changes'];

export type ViewMode = 'grid' | 'list';

/** Total "needs attention" count: uncommitted files plus unsynced commits. */
export function pendingCount(git: GitStatus | null | undefined): number {
  if (!git) {
    return 0;
  }
  return git.staged + git.modified + git.untracked + git.conflicts + git.ahead + git.behind;
}

export function changedFiles(git: GitStatus | null | undefined): number {
  return git ? git.staged + git.modified + git.untracked + git.conflicts : 0;
}

export const ICON_MAX = 3;

/** Trims to `max` grapheme clusters so a flag or skin-toned emoji counts as one. */
export function clampGraphemes(value: string, max: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let out = '';
  let n = 0;
  for (const { segment } of segmenter.segment(value)) {
    if (n++ >= max) {
      break;
    }
    out += segment;
  }
  return out;
}

/** "MyGameStudio" → "MGS", "shop-backend" → "SB", "tools" → "TO". */
export function initialsFor(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return clampGraphemes(words[0]!, 2).toUpperCase();
  }
  return words
    .slice(0, ICON_MAX)
    .map((w) => clampGraphemes(w, 1))
    .join('')
    .toUpperCase();
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHexColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_COLOR.test(withHash) ? withHash.toLowerCase() : undefined;
}

/** Splits "a, b ,a,  c" into unique, trimmed, case-insensitively de-duplicated tags. */
export function parseTags(value: string | readonly string[]): string[] {
  const parts = typeof value === 'string' ? value.split(/[,;]/) : value;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const tag = raw.trim().replace(/^#/, '').slice(0, 32);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/** Stable colour for a tag chip, derived from its name. */
export function tagHue(tag: string): number {
  let hash = 0;
  for (const ch of tag.toLowerCase()) {
    hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  }
  return hash % 360;
}
