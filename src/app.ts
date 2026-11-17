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
      const choice = await vscode.window.showWarningMessage(
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
      void vscode.window.showInformationMessage(`"${project.name}" has no remote that can be opened in a browser.`);
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
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Add to Repo Board' });
    return picked?.[0]?.fsPath;
  }

  async addScanRoot(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Scan for repos' });
    if (!picked?.length) {
      return;
    }
    const current = config().get<string[]>('scanRoots', []);
    const keys = new Set(current.map((r) => pathKey(expandHome(r, os.homedir()))));
    const added = picked.map((u) => u.fsPath).filter((p) => !keys.has(pathKey(p)));
    if (added.length) {
      await config().update('scanRoots', [...current, ...added], vscode.ConfigurationTarget.Global);
    }
    await this.scan({ notify: true });
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /** Re-scans the scan roots when auto-scan is on and the last scan is older than 10 minutes. */
  autoScanIfDue(): void {
    const s = settings();
    if (s.autoScan && s.scanRoots.length && Date.now() - this.lastAutoScan > 10 * 60_000) {
      void this.scan({ notify: false });
    }
  }

  async scan(options: { notify: boolean }): Promise<number> {
    const s = settings();
    if (!s.scanRoots.length) {
      if (options.notify) {
        const choice = await vscode.window.showInformationMessage('No scan folders yet. Pick folders that contain your repos (e.g. C:\\code).', 'Add folder to scan');
        if (choice) {
          await this.addScanRoot();
        }
      }
      return 0;
    }
    if (this.scanning) {
      return 0;
    }
    this.lastAutoScan = Date.now();
    this.setScanning(true);
    try {
      await this.projects.ensureLoaded();
      const found = await discoverRepos(s.scanRoots, { maxDepth: s.scanDepth, ignoreDirs: s.ignoreDirs });
      let added: Project[] = [];
      await this.projects.update((c) => {
        const result = mergeDiscovered(c, found);
        added = result.added;
        return result.catalog;
      });
      this.log.appendLine(`[scan] ${found.length} repos under ${s.scanRoots.join(', ')}; ${added.length} new`);
      if (added.length) {
        void this.meta.refresh(added.map((p) => p.path), { fetch: false });
      }
      if (options.notify) {
        void vscode.window.showInformationMessage(
          added.length ? `Repo Board found ${added.length} new repo${added.length === 1 ? '' : 's'} (${found.length} in total).` : `No new repos (${found.length} already on the board).`,
        );
      }
      return added.length;
    } finally {
      this.setScanning(false);
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
    const result = await vscode.window.withProgress(
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
      void vscode.window.showInformationMessage('No repos with an upstream branch to fetch.');
      return;
    }
    const failures: Array<{ project: Project; message: string }> = [];
    let pulled = 0;
    let skippedDirty = 0;

    await vscode.window.withProgress(
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
      void vscode.window.showWarningMessage(`${summary} ${failures.length} failed.`, 'Show log').then((c) => c && this.log.show());
    } else {
      void vscode.window.showInformationMessage(summary);
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
