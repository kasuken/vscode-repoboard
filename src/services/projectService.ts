import { EventEmitter } from 'node:events';
import * as C from '../domain/catalog';
import { Catalog, Project, emptyCatalog } from '../domain/model';
import { CatalogStore } from '../storage/catalogStore';

/**
 * In-memory catalog backed by the shared JSON file. Every mutation goes through `update()`,
 * which applies a pure function, saves, and emits `change`. Changes from other windows arrive
 * through the store's file watcher and are emitted the same way.
 */
export class ProjectService extends EventEmitter {
  private catalog: Catalog = emptyCatalog();
  private loading: Promise<void> | undefined;

  constructor(readonly store: CatalogStore) {
    super();
    store.on('change', (catalog: Catalog) => {
      this.catalog = catalog;
      this.emit('change', catalog);
    });
  }

  ensureLoaded(): Promise<void> {
    this.loading ??= this.store.load().then((catalog) => {
      this.catalog = catalog;
      this.store.startWatching();
    });
    return this.loading;
  }

  get current(): Catalog {
    return this.catalog;
  }

  get projects(): readonly Project[] {
    return this.catalog.projects;
  }

  byId(id: string): Project | undefined {
    return this.catalog.projects.find((p) => p.id === id);
  }

  byPath(path: string): Project | undefined {
    return C.findByPath(this.catalog, path);
  }

  async update(fn: (catalog: Catalog) => Catalog): Promise<void> {
    await this.ensureLoaded();
    const next = fn(this.catalog);
    if (next === this.catalog) {
      return;
    }
    this.catalog = next;
    this.emit('change', next);
    await this.store.save(next);
  }

  async add(input: Parameters<typeof C.addProject>[1]): Promise<Project> {
    await this.ensureLoaded();
    let project!: Project;
    await this.update((catalog) => {
      const result = C.addProject(catalog, input);
      project = result.project;
      return result.catalog;
    });
    return project;
  }

  dispose(): void {
    this.store.stopWatching();
    this.removeAllListeners();
  }
}
