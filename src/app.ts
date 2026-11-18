import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { markOpened, mergeDiscovered, removeProject, togglePin } from './domain/catalog';
import { Project, SortMode, ViewMode, changedFiles } from './domain/model';
import { expandHome, folderOf, pathKey } from './domain/paths';
import { discoverRepos } from './services/discovery';
import { GitClient, RemoteOp } from './services/git';
import { Limiter, MetadataService } from './services/metadata';
import { ProjectService } from './services/projectService';
import { CatalogStore, sharedDataDir } from './storage/catalogStore';

export const config = () => vscode.workspace.getConfiguration('repoBoard');

export function settings() {
  const c = config();
  return {
    scanRoots: c.get<string[]>('scanRoots', []).map((r) => expandHome(r.trim(), os.homedir())).filter(Boolean),
    scanDepth: Math.max(1, Math.min(8, c.get<number>('scanDepth', 3))),
    autoScan: c.get<boolean>('autoScan', true),
    ignoreDirs: c.get<string[]>('ignoreDirs', []),
    openInNewWindow: c.get<boolean>('openInNewWindow', false),
    showOnStartup: c.get<boolean>('showOnStartup', false),
    defaultView: c.get<ViewMode>('defaultView', 'grid'),
    defaultSort: c.get<SortMode>('defaultSort', 'recent'),
    fetchOnOpen: c.get<boolean>('fetchOnOpen', true),
    cacheMinutes: Math.max(0, c.get<number>('cacheMinutes', 5)),
    detectLanguages: c.get<boolean>('detectLanguages', true),
    maxFilesScanned: Math.max(100, c.get<number>('maxFilesScanned', 10000)),
    statusBar: c.get<boolean>('statusBar', true),
  };
}

/** The folder or .code-workspace file open in this window, if any. */
export function currentFolder(): string | undefined {
  const ws = vscode.workspace.workspaceFile;
  if (ws && ws.scheme === 'file') {
    return ws.fsPath;
  }
  const first = vscode.workspace.workspaceFolders?.[0]?.uri;
  return first && first.scheme === 'file' ? first.fsPath : undefined;
}

/**
 * Composition root and shared actions. The dashboard, the tree, the switcher and the commands
 * all go through this one object, so behaviour (open, pin, scan, bulk git) is identical everywhere.
 */
export class App implements vscode.Disposable {
  readonly projects: ProjectService;
  readonly meta: MetadataService;
  readonly git = new GitClient();
  readonly log = vscode.window.createOutputChannel('Repo Board');
  /** UI entry points. Extension tests replace them: VS Code gives every extension its own API object. */
  readonly ui = {
    pickFolders: (options: vscode.OpenDialogOptions) => vscode.window.showOpenDialog(options),
    info: (message: string, ...items: string[]) => vscode.window.showInformationMessage(message, ...items),
    warn: (message: string, ...items: string[]) => vscode.window.showWarningMessage(message, ...items),
    progress: <R>(options: vscode.ProgressOptions, task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>) =>
      vscode.window.withProgress(options, task),
  };
  private scanning = false;
  private lastAutoScan = 0;
  private readonly scanListeners = new Set<(scanning: boolean) => void>();

  constructor(readonly context: vscode.ExtensionContext) {
    this.projects = new ProjectService(new CatalogStore(path.join(sharedDataDir(), 'catalog.json')));
    this.meta = new MetadataService(this.git, path.join(context.globalStorageUri.fsPath, 'meta-cache.json'), {
      cacheMs: () => settings().cacheMinutes * 60_000,
      detectLanguages: () => settings().detectLanguages,
      scanOptions: () => ({ ignoreDirs: settings().ignoreDirs, maxFiles: settings().maxFilesScanned }),
    });
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  onScanning(listener: (scanning: boolean) => void): vscode.Disposable {
    this.scanListeners.add(listener);
    return new vscode.Disposable(() => this.scanListeners.delete(listener));
  }

  get dataFile(): string {
    return this.projects.store.file;
  }

  currentProject(): Project | undefined {
    const folder = currentFolder();
    return folder ? this.projects.byPath(folder) : undefined;
  }

  isCurrent(project: Project): boolean {
    const folder = currentFolder();
    return !!folder && pathKey(folder) === pathKey(project.path);
  }

  // ── Opening ────────────────────────────────────────────────────────────

  /** `newWindow` is absolute; leave it undefined to follow the `openInNewWindow` setting. */
  async open(project: Project, newWindow: boolean = settings().openInNewWindow): Promise<void> {
    if (this.isCurrent(project) && !newWindow) {
      return;
    }
    const availability = this.meta.get(project.path)?.availability;
    if (availability === 'offline' || availability === 'missing') {
      const choice = await this.ui.warn(
        availability === 'offline' ? `The drive holding "${project.name}" is not connected.` : `The folder of "${project.name}" was deleted or moved.`,
        'Open anyway',
        'Remove from board',
      );
      if (choice === 'Remove from board') {
        await this.remove(project);
        return;
      }
      if (choice !== 'Open anyway') {
        return;
      }
    }
    await this.projects.update((c) => markOpened(c, project.id));
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.path), { forceNewWindow: newWindow });
  }

  terminal(project: Project): void {
    vscode.window.createTerminal({ name: project.name, cwd: folderOf(project.path) }).show();
  }

  reveal(project: Project): void {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(project.path));
  }

  async openRemote(project: Project): Promise<void> {
    const url = this.meta.get(project.path)?.git?.webUrl;
    if (!url) {
      void this.ui.info(`"${project.name}" has no remote that can be opened in a browser.`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async remove(project: Project): Promise<void> {
    await this.projects.update((c) => removeProject(c, project.id));
  }

  async setPinned(project: Project, pinned: boolean): Promise<void> {
    await this.projects.update((c) => togglePin(c, project.id, pinned));
  }

  // ── Adding ─────────────────────────────────────────────────────────────

  async addPath(folder: string): Promise<Project> {
    await this.projects.ensureLoaded();
    const existing = this.projects.byPath(folder);
    if (existing) {
      return existing;
    }
    const project = await this.projects.add({ path: folder });
    void this.meta.refreshOne(project.path, { force: true });
    return project;
  }

  async pickFolder(): Promise<string | undefined> {
    const picked = await this.ui.pickFolders({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Add to Repo Board' });
    return picked?.[0]?.fsPath;
  }

  async addScanRoot(): Promise<void> {
    const picked = await this.ui.pickFolders({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Scan for repos' });
    if (!picked?.length) {
      return;
    }
    const current = config().get<string[]>('scanRoots', []);
    const keys = new Set(current.map((r) => pathKey(expandHome(r, os.homedir()))));
    const added = picked.map((u) => u.fsPath).filter((p) => !keys.has(pathKey(p)));
    if (added.length) {
      await config().update('scanRoots', [...current, ...added], vscode.ConfigurationTarget.Global);
    }
    // Show the board right away so the user watches the repos arrive instead of wondering if anything happened.
    await vscode.commands.executeCommand('repoBoard.open');
    await this.scan({ notify: true, picked: picked.map((u) => u.fsPath), alreadyScanned: added.length === 0 });
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /** Re-scans the scan roots when auto-scan is on and the last scan is older than 10 minutes. */
  autoScanIfDue(): void {
    const s = settings();
    if (s.autoScan && s.scanRoots.length && Date.now() - this.lastAutoScan > 10 * 60_000) {
      void this.scan({ notify: false });
    }
  }

  /**
   * Scans every scan root. With `notify`, progress is shown while it runs and the result is always
   * reported, including "nothing new" and repos skipped because the user removed them earlier.
   */
  async scan(options: { notify: boolean; picked?: string[]; alreadyScanned?: boolean }): Promise<number> {
    const s = settings();
    if (!s.scanRoots.length) {
      if (options.notify) {
        const choice = await this.ui.info('No scan folders yet. Pick folders that contain your repos (e.g. C:\\code).', 'Add folder to scan');
        if (choice) {
          await this.addScanRoot();
        }
      }
      return 0;
    }
    if (this.scanning) {
      if (options.notify) {
        void this.ui.info('Repo Board is already scanning. New repos appear on the board as soon as it finishes.');
      }
      return 0;
    }
    this.lastAutoScan = Date.now();
    this.setScanning(true);
    try {
      await this.projects.ensureLoaded();
      const run = () => discoverRepos(s.scanRoots, { maxDepth: s.scanDepth, ignoreDirs: s.ignoreDirs });
      const found = options.notify
        ? await this.ui.progress({ location: vscode.ProgressLocation.Notification, title: `Scanning ${describeRoots(s.scanRoots)} for git repos…` }, run)
        : await run();
      let added: Project[] = [];
      await this.projects.update((c) => {
        const result = mergeDiscovered(c, found);
        added = result.added;
        return result.catalog;
      });
      const ignored = new Set(this.projects.current.ignoredPaths);
      const skipped = found.filter((p) => ignored.has(pathKey(p))).length;
      this.log.appendLine(`[scan] ${found.length} repos under ${s.scanRoots.join(', ')}; ${added.length} new; ${skipped} skipped (removed earlier)`);
      if (added.length) {
        void this.meta.refresh(added.map((p) => p.path), { fetch: false });
      }
      if (options.notify) {
        // Right after picking folders, report on those folders only, not on every scan root.
        const relevant = options.picked ? found.filter((p) => options.picked!.some((root) => isInside(p, root))) : found;
        const relevantSkipped = relevant.filter((p) => ignored.has(pathKey(p))).length;
        void this.reportScan(relevant.length, added.length, relevantSkipped, options);
      }
      return added.length;
    } finally {
      this.setScanning(false);
    }
  }

  private async reportScan(found: number, added: number, skipped: number, options: { picked?: string[]; alreadyScanned?: boolean }): Promise<void> {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (found === 0) {
      const choice = await this.ui.warn(
        `No git repositories found in ${describeRoots(options.picked ?? settings().scanRoots)} (searched ${settings().scanDepth} folder levels deep).`,
        'Search deeper',
        'Pick another folder',
      );
      if (choice === 'Search deeper') {
        await config().update('scanDepth', Math.min(8, settings().scanDepth + 2), vscode.ConfigurationTarget.Global);
        await this.scan({ notify: true });
      } else if (choice === 'Pick another folder') {
        await this.addScanRoot();
      }
      return;
    }
    const skippedNote = skipped ? ` ${plural(skipped, 'repo')} you removed earlier stayed off the board.` : '';
    if (added > 0) {
      void this.ui.info(`Added ${plural(added, 'repo')} to the board (${found} found in total).${skippedNote}`);
      return;
    }
    const prefix = options.alreadyScanned ? 'That folder is already scanned. ' : '';
    const choice = await this.ui.info(
      `${prefix}All ${plural(found - skipped, 'repo')} found are already on the board.${skippedNote}`,
      ...(skipped ? ['Bring removed repos back'] : []),
    );
    if (choice) {
      await vscode.commands.executeCommand('repoBoard.resetIgnored');
      await this.scan({ notify: true });
    }
  }

  private setScanning(scanning: boolean): void {
    this.scanning = scanning;
    for (const listener of this.scanListeners) {
      listener(scanning);
    }
  }

  // ── Git ────────────────────────────────────────────────────────────────

  async gitOp(project: Project, op: RemoteOp): Promise<boolean> {
    const result = await this.ui.progress(
      { location: vscode.ProgressLocation.Window, title: `git ${op} · ${project.name}` },
      () => this.git.remote(folderOf(project.path), op),
    );
    if (!result.ok) {
      this.log.appendLine(`[${op}] ${project.path}\n${result.message}`);
      void vscode.window.showErrorMessage(`git ${op} failed for "${project.name}": ${firstLine(result.message)}`, 'Show log').then((c) => c && this.log.show());
    }
    await this.meta.refreshOne(project.path, { force: true });
    return result.ok;
  }

  /**
   * Fetches every repo with an upstream (4 at a time, cancellable), then optionally fast-forwards
   * the ones that are behind and have no conflicts. There is deliberately no "push all".
   */
  async bulk(op: 'fetch' | 'pull'): Promise<void> {
    await this.projects.ensureLoaded();
    // Read local state first for projects never seen, so non-repos and repos without upstream are skipped.
    await this.meta.refresh(this.projects.projects.filter((p) => !this.meta.get(p.path)).map((p) => p.path));
    const candidates = this.projects.projects.filter((p) => {
      const m = this.meta.get(p.path);
      return m?.availability === 'ok' && !!m.git?.upstream;
    });
    if (!candidates.length) {
      void this.ui.info('No repos with an upstream branch to fetch.');
      return;
    }
    const failures: Array<{ project: Project; message: string }> = [];
    let pulled = 0;
    let skippedDirty = 0;

    await this.ui.progress(
      { location: vscode.ProgressLocation.Notification, title: op === 'fetch' ? 'Fetching repos' : 'Updating repos', cancellable: true },
      async (progress, token) => {
        const limiter = new Limiter(4);
        let done = 0;
        const step = 100 / candidates.length;
        await Promise.all(
          candidates.map((project) =>
            limiter.run(async () => {
              if (token.isCancellationRequested) {
                return;
              }
              const fetched = await this.git.remote(folderOf(project.path), 'fetch');
              if (!fetched.ok) {
                failures.push({ project, message: fetched.message });
              }
              await this.meta.refreshOne(project.path, { force: true });
              const git = this.meta.get(project.path)?.git;
              if (op === 'pull' && fetched.ok && git && git.behind > 0 && !token.isCancellationRequested) {
                if (git.conflicts > 0) {
                  skippedDirty++;
                } else {
                  const res = await this.git.remote(folderOf(project.path), 'pull');
                  if (res.ok) {
                    pulled++;
                  } else {
                    failures.push({ project, message: res.message });
                  }
                  await this.meta.refreshOne(project.path, { force: true });
                }
              }
              done++;
              progress.report({ increment: step, message: `${done}/${candidates.length} · ${project.name}` });
            }),
          ),
        );
      },
    );

    for (const f of failures) {
      this.log.appendLine(`[${op}] ${f.project.path}\n  ${f.message.replace(/\n/g, '\n  ')}`);
    }
    const behind = this.projects.projects.filter((p) => (this.meta.get(p.path)?.git?.behind ?? 0) > 0).length;
    const dirty = this.projects.projects.filter((p) => changedFiles(this.meta.get(p.path)?.git) > 0).length;
    const summary =
      op === 'fetch'
        ? `Fetched ${candidates.length - failures.length}/${candidates.length} repos. ${behind} behind, ${dirty} with local changes.`
        : `Pulled ${pulled} repo${pulled === 1 ? '' : 's'}.${skippedDirty ? ` ${skippedDirty} skipped (conflicts).` : ''} ${behind} still behind.`;
    if (failures.length) {
      void this.ui.warn(`${summary} ${failures.length} failed.`, 'Show log').then((c) => c && this.log.show());
    } else {
      void this.ui.info(summary);
    }
  }

  dispose(): void {
    void this.meta.persist();
    this.projects.dispose();
    this.log.dispose();
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? text;
}

/** "C:\code" or "3 folders", for progress and result messages. */
function describeRoots(roots: readonly string[]): string {
  return roots.length === 1 ? roots[0]! : `${roots.length} folders`;
}

/** True when `child` is `root` itself or somewhere below it. */
function isInside(child: string, root: string): boolean {
  const c = pathKey(child);
  const r = pathKey(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
