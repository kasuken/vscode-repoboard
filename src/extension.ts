import * as os from 'node:os';
import * as vscode from 'vscode';
import { App, currentFolder, settings } from './app';
import { markOpened } from './domain/catalog';
import { changedFiles } from './domain/model';
import { pathKey } from './domain/paths';
import { DashboardPanel, VIEW_TYPE } from './ui/dashboardPanel';
import { showSwitcher } from './ui/switcher';
import { registerOnboarding } from './ui/onboarding';
import { ProjectTree, projectArg, worktreeArg } from './ui/tree';

/**
 * Activation is cheap: it registers commands, reads the small catalog JSON (to stamp "last opened"
 * for this window's folder and fill the status bar) and never runs git until something asks for it.
 */
export function activate(context: vscode.ExtensionContext): { app: App } | undefined {
  const app = new App(context);
  context.subscriptions.push(app);
  registerOnboarding(context, app);

  // Background fetch while this window is open. It acts only once the catalog and the status cache are loaded.
  app.autoFetch.start();

  const tree = new ProjectTree(app);
  const treeView = vscode.window.createTreeView('repoBoard.projects', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(tree, treeView);
  treeView.onDidChangeVisibility((e) => {
    if (e.visible) void app.meta.refresh(app.projects.projects.map((p) => p.path));
  });

  const status = vscode.window.createStatusBarItem('repoBoard.current', vscode.StatusBarAlignment.Left, 100);
  status.name = 'Repo Board';
  status.command = 'repoBoard.switch';
  context.subscriptions.push(status);
  const updateStatus = () => {
    // Lets the setup guide tick its first step as soon as the board has repos, however they got there.
    void vscode.commands.executeCommand('setContext', 'repoBoard.hasProjects', app.projects.projects.length > 0);
    if (!settings().statusBar) {
      status.hide();
      return;
    }
    const project = app.currentProject();
    const git = project ? app.meta.get(project.path)?.git : undefined;
    const changes = changedFiles(git);
    status.text = project ? `$(repo) ${project.name}${changes ? ` ●${changes}` : ''}` : '$(repo) Repo Board';
    status.tooltip = project ? `${project.name} — click to switch project (${os.platform() === 'darwin' ? '⌘⌥P' : 'Ctrl+Alt+P'})` : 'Switch project';
    status.show();
  };

  const command = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const withItem = (fn: (p: NonNullable<ReturnType<typeof projectArg>>) => unknown) => (arg: unknown) => {
    const project = projectArg(app, arg);
    if (project) return fn(project);
    return undefined;
  };

  command('repoBoard.open', async () => {
    await app.projects.ensureLoaded();
    DashboardPanel.show(app);
  });
  command('repoBoard.switch', () => showSwitcher(app));
  command('repoBoard.addCurrent', async () => {
    const folder = currentFolder();
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder first, then add it to Repo Board.');
      return;
    }
    const project = await app.addPath(folder);
    DashboardPanel.show(app, project.id);
  });
  command('repoBoard.addFolder', async () => {
    const folder = await app.pickFolder();
    if (folder) {
      const project = await app.addPath(folder);
      DashboardPanel.show(app, project.id);
    }
  });
  command('repoBoard.scan', () => app.scan({ notify: true }));
  command('repoBoard.addScanRoot', () => app.addScanRoot());
  command('repoBoard.refresh', async () => {
    await app.projects.ensureLoaded();
    await app.refreshAll({ force: true, fetchMinAgeMs: 0 });
  });
  command('repoBoard.fetchAll', () => app.bulk('fetch'));
  command('repoBoard.pullAll', () => app.bulk('pull'));
  command('repoBoard.togglePinCurrent', async () => {
    await app.projects.ensureLoaded();
    const project = app.currentProject();
    if (!project) {
      void vscode.window.showInformationMessage('The current folder is not on the board yet. Use "Repo Board: Add Current Folder".');
      return;
    }
    await app.setPinned(project, !project.pinned);
    void vscode.window.setStatusBarMessage(`${project.pinned ? 'Unpinned' : 'Pinned'} ${project.name}`, 2500);
  });
  command('repoBoard.removeMissing', async () => {
    await app.projects.ensureLoaded();
    await app.meta.refresh(app.projects.projects.map((p) => p.path), { force: true });
    const missing = app.projects.projects.filter((p) => app.meta.get(p.path)?.availability === 'missing');
    if (!missing.length) {
      void vscode.window.showInformationMessage('Every project folder still exists. (Projects on disconnected drives are kept.)');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Remove ${missing.length} project${missing.length === 1 ? '' : 's'} whose folder no longer exists?`,
      { modal: true, detail: missing.map((p) => `• ${p.name} — ${p.path}`).join('\n') },
      'Remove',
    );
    if (ok) {
      const ids = new Set(missing.map((p) => p.id));
      await app.projects.update((c) => ({ ...c, projects: c.projects.filter((p) => !ids.has(p.id)) }));
    }
  });
  command('repoBoard.resetIgnored', async () => {
    await app.projects.ensureLoaded();
    const count = app.projects.current.ignoredPaths.length;
    await app.projects.update((c) => ({ ...c, ignoredPaths: [] }));
    void vscode.window.showInformationMessage(`Forgot ${count} removed repo${count === 1 ? '' : 's'}; the next scan may add them again.`);
  });
  command('repoBoard.openDataFile', async () => {
    await app.projects.ensureLoaded();
    if (!app.projects.projects.length) await app.projects.store.save(app.projects.current);
    await vscode.window.showTextDocument(vscode.Uri.file(app.dataFile));
  });

  const withWorktree = (action: 'open' | 'newWindow' | 'terminal' | 'reveal') => (arg: unknown) => {
    const wt = worktreeArg(app, arg);
    return wt ? app.openWorktree(wt.project, wt.path, action) : undefined;
  };
  command('repoBoard.worktree.open', withWorktree('open'));
  command('repoBoard.worktree.openNewWindow', withWorktree('newWindow'));
  command('repoBoard.worktree.terminal', withWorktree('terminal'));
  command('repoBoard.worktree.reveal', withWorktree('reveal'));
  command('repoBoard.item.open', withItem((p) => app.open(p)));
  command('repoBoard.item.openNewWindow', withItem((p) => app.open(p, true)));
  command('repoBoard.item.terminal', withItem((p) => app.terminal(p)));
  command('repoBoard.item.reveal', withItem((p) => app.reveal(p)));
  command('repoBoard.item.remote', withItem((p) => app.openRemote(p)));
  command('repoBoard.item.pin', withItem((p) => app.setPinned(p, true)));
  command('repoBoard.item.unpin', withItem((p) => app.setPinned(p, false)));
  command(
    'repoBoard.item.remove',
    withItem(async (p) => {
      const ok = await vscode.window.showWarningMessage(`Remove "${p.name}" from Repo Board? The folder on disk is not touched.`, { modal: true }, 'Remove');
      if (ok) await app.remove(p);
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        await app.projects.ensureLoaded();
        DashboardPanel.revive(app, panel);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('repoBoard')) {
        updateStatus();
        app.onConfigChanged();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatus()),
  );

  app.projects.on('change', updateStatus);
  app.meta.on('update', (key: string) => {
    const folder = currentFolder();
    if (folder && pathKey(folder) === key) updateStatus();
  });

  void app.meta.loadCache().then(async () => {
    await app.projects.ensureLoaded();
    // Count opens that didn't go through Repo Board (File > Open, recent list, CLI) too.
    const project = app.currentProject();
    if (project && Date.now() - (project.lastOpenedAt ?? 0) > 60_000) {
      await app.projects.update((c) => markOpened(c, project.id));
    }
    if (project) void app.meta.refreshOne(project.path);
    updateStatus();
    if (!currentFolder() && settings().showOnStartup) {
      DashboardPanel.show(app);
    }
  });

  // Only extension tests get a handle on the internals.
  return context.extensionMode === vscode.ExtensionMode.Test ? { app } : undefined;
}

export function deactivate(): void {
  // Disposables registered on the context clean everything up.
}
