import { EventEmitter } from 'node:events';
import { FSWatcher, promises as fs, watch } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeCatalog } from '../domain/catalog';
import { Catalog, emptyCatalog } from '../domain/model';

/**
 * Folder shared by every VS Code flavour (Code, Insiders, Cursor, VSCodium…) on this machine,
 * so they all see one project list.
 */
export function sharedDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'), 'repoboard');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'repoboard');
  }
  return path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'repoboard');
}

/**
 * JSON persistence for the catalog with atomic writes and live sync between windows.
 * Emits `change` with the new catalog when another window rewrote the file.
 */
export class CatalogStore extends EventEmitter {
  private lastWritten: string | undefined;
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    super();
  }

  async load(): Promise<Catalog> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.lastWritten = text;
      return sanitizeCatalog(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyCatalog();
      }
      if (error instanceof SyntaxError) {
        // Keep the broken file for the user instead of silently overwriting it.
        await fs.copyFile(this.file, `${this.file}.broken-${Date.now()}`).catch(() => undefined);
        return emptyCatalog();
      }
      throw error;
    }
  }

  /** Writes are serialised so two quick edits can never interleave on disk. */
  save(catalog: Catalog): Promise<void> {
    const text = JSON.stringify(catalog, null, 2) + '\n';
    this.writeChain = this.writeChain.then(() => this.writeAtomic(text)).catch(() => undefined);
    return this.writeChain;
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    fs.mkdir(dir, { recursive: true })
      .then(() => {
        // Watch the directory: an atomic rename replaces the file's inode, which breaks file watches.
        this.watcher = watch(dir, (_event, name) => {
          if (name && name.toString() !== base) {
            return;
          }
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => void this.reloadIfChanged(), 150);
        });
        this.watcher.on('error', () => this.stopWatching());
      })
      .catch(() => undefined);
  }

  stopWatching(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async reloadIfChanged(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    if (text === this.lastWritten) {
      return;
    }
    try {
      const catalog = sanitizeCatalog(JSON.parse(text));
      this.lastWritten = text;
      this.emit('change', catalog);
    } catch {
      // Half-written by an editor; the next event will carry the full file.
    }
  }

  private async writeAtomic(text: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    this.lastWritten = text;
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, this.file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows: antivirus or another window briefly holding the file.
        if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 6) {
          await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
          continue;
        }
        await fs.unlink(tmp).catch(() => undefined);
        throw error;
      }
    }
  }
}
