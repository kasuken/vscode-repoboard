import { randomUUID } from 'node:crypto';
import * as nodePath from 'node:path';
import { Catalog, Collection, ICON_MAX, Project, clampGraphemes, emptyCatalog, normalizeHexColor, parseTags } from './model';
import { pathKey } from './paths';

/**
 * Pure catalog operations. Each returns a new Catalog and never mutates its input, so the
 * service can diff, persist and broadcast without defensive copies.
 */

export interface ProjectPatch {
  name?: string;
  path?: string;
  description?: string;
  icon?: string;
  color?: string;
  collectionId?: string | null;
  tags?: string[] | string;
  pinned?: boolean;
}

export function findByPath(catalog: Catalog, path: string): Project | undefined {
  const key = pathKey(path);
  return catalog.projects.find((p) => pathKey(p.path) === key);
}

export function addProject(
  catalog: Catalog,
  input: { path: string; name?: string; source?: Project['source'] } & ProjectPatch,
  now = Date.now(),
): { catalog: Catalog; project: Project } {
  const existing = findByPath(catalog, input.path);
  if (existing) {
    return { catalog, project: existing };
  }
  const base: Project = {
    id: randomUUID(),
    name: input.name?.trim() || defaultName(input.path),
    path: nodePath.resolve(input.path),
    tags: [],
    source: input.source ?? 'manual',
    addedAt: now,
  };
  const project = applyPatch(base, input, catalog);
  const key = pathKey(project.path);
  return {
    catalog: {
      ...catalog,
      projects: [...catalog.projects, project],
      // Adding a path by hand un-ignores it.
      ignoredPaths: catalog.ignoredPaths.filter((p) => p !== key),
    },
    project,
  };
}

export function updateProject(catalog: Catalog, id: string, patch: ProjectPatch): Catalog {
  return {
    ...catalog,
    projects: catalog.projects.map((p) => (p.id === id ? applyPatch(p, patch, catalog) : p)),
  };
}

/** Removes a project and remembers its path so the next folder scan does not bring it back. */
export function removeProject(catalog: Catalog, id: string): Catalog {
  const project = catalog.projects.find((p) => p.id === id);
  if (!project) {
    return catalog;
  }
  const key = pathKey(project.path);
  // Every removal is remembered, manual ones too: a hand-added repo under a scan root would otherwise return.
  const ignoredPaths = catalog.ignoredPaths.includes(key) ? catalog.ignoredPaths : [...catalog.ignoredPaths, key];
  return { ...catalog, projects: catalog.projects.filter((p) => p.id !== id), ignoredPaths };
}

export function markOpened(catalog: Catalog, id: string, now = Date.now()): Catalog {
  return { ...catalog, projects: catalog.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: now } : p)) };
}

export function togglePin(catalog: Catalog, id: string, pinned?: boolean): Catalog {
  return {
    ...catalog,
    projects: catalog.projects.map((p) => (p.id === id ? withOptional(p, 'pinned', (pinned ?? !p.pinned) || undefined) : p)),
  };
}

/**
 * Moves a project into `collectionId` (undefined = ungrouped) at `index` among that group's members.
 * The global array keeps its relative order otherwise.
 */
export function moveProject(catalog: Catalog, id: string, collectionId: string | undefined, index: number): Catalog {
  const project = catalog.projects.find((p) => p.id === id);
  if (!project) {
    return catalog;
  }
  const validCollection = collectionId && catalog.collections.some((c) => c.id === collectionId) ? collectionId : undefined;
  const moved = withOptional(project, 'collectionId', validCollection);
  const rest = catalog.projects.filter((p) => p.id !== id);
  const members = rest.filter((p) => p.collectionId === validCollection);
  const clamped = Math.max(0, Math.min(index, members.length));
  let insertAt: number;
  if (members.length === 0) {
    insertAt = rest.length;
  } else if (clamped < members.length) {
    insertAt = rest.indexOf(members[clamped]!);
  } else {
    insertAt = rest.indexOf(members[members.length - 1]!) + 1;
  }
  const projects = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  return { ...catalog, projects };
}

export function saveCollection(
  catalog: Catalog,
  input: { id?: string; name: string; color?: string },
): { catalog: Catalog; collection: Collection } {
  const name = input.name.trim().slice(0, 60) || 'Collection';
  const color = normalizeHexColor(input.color);
  const existing = input.id ? catalog.collections.find((c) => c.id === input.id) : undefined;
  if (existing) {
    const collection = withOptional({ ...existing, name }, 'color', color);
    return { catalog: { ...catalog, collections: catalog.collections.map((c) => (c.id === existing.id ? collection : c)) }, collection };
  }
  const collection = withOptional({ id: randomUUID(), name } as Collection, 'color', color);
  return { catalog: { ...catalog, collections: [...catalog.collections, collection] }, collection };
}

/** Deletes a collection; its projects become ungrouped (never deleted). */
export function removeCollection(catalog: Catalog, id: string): Catalog {
  return {
    ...catalog,
    collections: catalog.collections.filter((c) => c.id !== id),
    projects: catalog.projects.map((p) => (p.collectionId === id ? withOptional(p, 'collectionId', undefined) : p)),
  };
}

export function moveCollection(catalog: Catalog, id: string, index: number): Catalog {
  const collection = catalog.collections.find((c) => c.id === id);
  if (!collection) {
    return catalog;
  }
  const rest = catalog.collections.filter((c) => c.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return { ...catalog, collections: [...rest.slice(0, at), collection, ...rest.slice(at)] };
}

export function setCollapsed(catalog: Catalog, id: string, collapsed: boolean): Catalog {
  return {
    ...catalog,
    collections: catalog.collections.map((c) => (c.id === id ? withOptional(c, 'collapsed', collapsed || undefined) : c)),
  };
}

/** Adds discovered repos that are neither known nor ignored. Returns the catalog and how many were added. */
export function mergeDiscovered(catalog: Catalog, paths: readonly string[], now = Date.now()): { catalog: Catalog; added: Project[] } {
  const known = new Set(catalog.projects.map((p) => pathKey(p.path)));
  const ignored = new Set(catalog.ignoredPaths);
  const added: Project[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (known.has(key) || ignored.has(key)) {
      continue;
    }
    known.add(key);
    added.push({ id: randomUUID(), name: defaultName(path), path: nodePath.resolve(path), tags: [], source: 'discovered', addedAt: now });
  }
  return added.length === 0 ? { catalog, added } : { catalog: { ...catalog, projects: [...catalog.projects, ...added] }, added };
}

export function allTags(catalog: Catalog): Array<{ tag: string; count: number }> {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const project of catalog.projects) {
    for (const tag of project.tags) {
      const entry = counts.get(tag.toLowerCase());
      if (entry) {
        entry.count++;
      } else {
        counts.set(tag.toLowerCase(), { tag, count: 1 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Coerces arbitrary JSON (hand-edited file, older version) into a valid Catalog. */
export function sanitizeCatalog(raw: unknown): Catalog {
  if (!raw || typeof raw !== 'object') {
    return emptyCatalog();
  }
  const data = raw as Record<string, unknown>;
  const collections: Collection[] = [];
  const collectionIds = new Set<string>();
  for (const c of Array.isArray(data['collections']) ? data['collections'] : []) {
    if (c && typeof c === 'object' && typeof c.id === 'string' && typeof c.name === 'string' && !collectionIds.has(c.id)) {
      collectionIds.add(c.id);
      let collection: Collection = { id: c.id, name: c.name };
      collection = withOptional(collection, 'color', normalizeHexColor(typeof c.color === 'string' ? c.color : undefined));
      collection = withOptional(collection, 'collapsed', c.collapsed === true || undefined);
      collections.push(collection);
    }
  }
  const projects: Project[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(data['projects']) ? data['projects'] : []) {
    if (!p || typeof p !== 'object' || typeof p.path !== 'string' || !p.path.trim()) {
      continue;
    }
    const key = pathKey(p.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let project: Project = {
      id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : defaultName(p.path),
      path: p.path,
      tags: parseTags(Array.isArray(p.tags) ? p.tags.filter((t: unknown): t is string => typeof t === 'string') : []),
      source: p.source === 'discovered' ? 'discovered' : 'manual',
      addedAt: typeof p.addedAt === 'number' ? p.addedAt : 0,
    };
    project = withOptional(project, 'description', typeof p.description === 'string' && p.description ? p.description : undefined);
    project = withOptional(project, 'icon', typeof p.icon === 'string' && p.icon ? clampGraphemes(p.icon, ICON_MAX) : undefined);
    project = withOptional(project, 'color', normalizeHexColor(typeof p.color === 'string' ? p.color : undefined));
    project = withOptional(project, 'collectionId', typeof p.collectionId === 'string' && collectionIds.has(p.collectionId) ? p.collectionId : undefined);
    project = withOptional(project, 'pinned', p.pinned === true || undefined);
    project = withOptional(project, 'lastOpenedAt', typeof p.lastOpenedAt === 'number' ? p.lastOpenedAt : undefined);
    projects.push(project);
  }
  const ignoredPaths = Array.isArray(data['ignoredPaths'])
    ? [...new Set(data['ignoredPaths'].filter((x: unknown): x is string => typeof x === 'string').map((x) => pathKey(x)))]
    : [];
  return { version: 1, collections, projects, ignoredPaths };
}

function applyPatch(project: Project, patch: ProjectPatch, catalog: Catalog): Project {
  let next: Project = { ...project };
  if (patch.name !== undefined) {
    next.name = patch.name.trim().slice(0, 80) || next.name;
  }
  if (patch.path !== undefined && patch.path.trim()) {
    next.path = nodePath.resolve(patch.path.trim());
  }
  if (patch.description !== undefined) {
    next = withOptional(next, 'description', patch.description.trim().slice(0, 300) || undefined);
  }
  if (patch.icon !== undefined) {
    next = withOptional(next, 'icon', clampGraphemes(patch.icon.trim(), ICON_MAX) || undefined);
  }
  if (patch.color !== undefined) {
    next = withOptional(next, 'color', normalizeHexColor(patch.color));
  }
  if (patch.collectionId !== undefined) {
    const valid = patch.collectionId && catalog.collections.some((c) => c.id === patch.collectionId) ? patch.collectionId : undefined;
    next = withOptional(next, 'collectionId', valid);
  }
  if (patch.tags !== undefined) {
    next.tags = parseTags(patch.tags);
  }
  if (patch.pinned !== undefined) {
    next = withOptional(next, 'pinned', patch.pinned || undefined);
  }
  return next;
}

function defaultName(path: string): string {
  const base = nodePath.basename(path.replace(/[\\/]+$/, ''));
  return base.replace(/\.code-workspace$/i, '') || path;
}

/** Sets or deletes an optional key, keeping the JSON free of `"x": null` noise. */
function withOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const copy = { ...obj };
  if (value === undefined) {
    delete copy[key];
  } else {
    copy[key] = value;
  }
  return copy;
}
