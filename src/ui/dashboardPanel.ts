import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { App, currentFolder, settings } from '../app';
import * as C from '../domain/catalog';
import { ProjectMeta } from '../domain/model';
import { displayPath, pathKey } from '../domain/paths';
import { BoardState, HostMessage, WebviewMessage } from '../webview/protocol';

export const VIEW_TYPE = 'repoBoard.dashboard';

/** The dashboard editor tab. One per window; it survives reloads through the serializer. */
export class DashboardPanel implements vscode.Disposable {
  private static instance: DashboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onChange = () => this.postState();
  private readonly onMeta = (key: string, meta: ProjectMeta) => {
    const project = this.app.projects.projects.find((p) => pathKey(p.path) === key);
    if (project) this.post({ type: 'meta', id: project.id, meta });
  };
  private readonly onBusy = (key: string, busy: boolean) => {
    const project = this.app.projects.projects.find((p) => pathKey(p.path) === key);
    if (project) this.post({ type: 'busy', id: project.id, busy });
  };
  private pendingEdit: string | undefined;

  static show(app: App, editId?: string): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      if (editId) DashboardPanel.instance.post({ type: 'edit', id: editId });
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Repo Board', vscode.ViewColumn.Active, DashboardPanel.options(app));
    DashboardPanel.instance = new DashboardPanel(app, panel, editId);
  }

  static revive(app: App, panel: vscode.WebviewPanel): void {
    panel.webview.options = DashboardPanel.options(app);
    DashboardPanel.instance?.dispose();
    DashboardPanel.instance = new DashboardPanel(app, panel);
  }

  static focusSearch(): boolean {
    if (!DashboardPanel.instance) return false;
    DashboardPanel.instance.panel.reveal();
    DashboardPanel.instance.post({ type: 'focusSearch' });
    return true;
  }

  private static options(app: App): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(app.context.extensionUri, 'dist'), vscode.Uri.joinPath(app.context.extensionUri, 'media')] };
  }

  private constructor(private readonly app: App, private readonly panel: vscode.WebviewPanel, editId?: string) {
    this.pendingEdit = editId;
    panel.iconPath = vscode.Uri.joinPath(app.context.extensionUri, 'media', 'activity.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.handle(m).catch((e) => this.toast(String(e?.message ?? e), 'error'))),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) this.refreshVisible(false);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('repoBoard')) this.postState();
      }),
      app.onScanning((scanning) => this.post({ type: 'scanning', scanning })),
    );
    app.projects.on('change', this.onChange);
    app.meta.on('update', this.onMeta);
    app.meta.on('busy', this.onBusy);
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private toast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.post({ type: 'toast', text, kind });
  }

  private state(): BoardState {
    const catalog = this.app.projects.current;
    const home = os.homedir();
    const current = currentFolder();
    const currentKey = current ? pathKey(current) : undefined;
    const meta: Record<string, ProjectMeta> = {};
    const busy: string[] = [];
    for (const p of catalog.projects) {
      const m = this.app.meta.get(p.path);
      if (m) meta[p.id] = m;
      if (this.app.meta.isBusy(p.path)) busy.push(p.id);
    }
    const s = settings();
    return {
      projects: catalog.projects.map((p) => ({ ...p, displayPath: displayPath(p.path, home), isCurrent: pathKey(p.path) === currentKey })),
      collections: catalog.collections,
      meta,
      busy,
      settings: { openInNewWindow: s.openInNewWindow, defaultView: s.defaultView, defaultSort: s.defaultSort, hasScanRoots: s.scanRoots.length > 0, startPage: s.showOnStartup, isMac: process.platform === 'darwin' },
      canAddCurrent: !!current && !this.app.projects.byPath(current),
      scanning: this.app.isScanning,
      gitAvailable: this.app.git.available,
    };
  }

  private postState(): void {
    this.post({ type: 'state', state: this.state() });
  }

  /** Refreshes stale local state; with `fetch`, also fetches remotes (per setting). */
  private refreshVisible(fetch: boolean): void {
    void this.app.meta.refresh(this.app.projects.projects.map((p) => p.path), { fetch });
  }

  private async handle(m: WebviewMessage): Promise<void> {
    const app = this.app;
    const project = 'id' in m && m.id ? app.projects.byId(m.id) : undefined;
    switch (m.type) {
      case 'ready':
        await app.projects.ensureLoaded();
        this.postState();
        if (this.pendingEdit) {
          this.post({ type: 'edit', id: this.pendingEdit });
          this.pendingEdit = undefined;
        }
        this.refreshVisible(settings().fetchOnOpen);
        app.autoScanIfDue();
        return;
      case 'open':
        if (project) await app.open(project, m.newWindow);
        return;
      case 'terminal':
        if (project) app.terminal(project);
        return;
      case 'reveal':
        if (project) app.reveal(project);
        return;
      case 'openRemote':
        if (project) await app.openRemote(project);
        return;
      case 'copyPath':
        if (project) {
          await vscode.env.clipboard.writeText(project.path);
          this.toast('Path copied');
        }
        return;
      case 'pin':
        if (project) await app.setPinned(project, m.pinned);
        return;
      case 'saveProject':
        if (project) {
          await app.projects.update((c) => C.updateProject(c, project.id, { ...m.edit }));
        }
        return;
      case 'removeProject':
        if (project) {
          await app.remove(project);
          this.toast(`Removed "${project.name}" from the board`);
        }
        return;
      case 'moveProject':
        await app.projects.update((c) => C.moveProject(c, m.id, m.collectionId ?? undefined, m.index));
        return;
      case 'saveCollection':
        await app.projects.update((c) => C.saveCollection(c, { ...(m.id ? { id: m.id } : {}), name: m.name, ...(m.color ? { color: m.color } : {}) }).catalog);
        return;
      case 'removeCollection':
        await app.projects.update((c) => C.removeCollection(c, m.id));
        return;
      case 'moveCollection':
        await app.projects.update((c) => C.moveCollection(c, m.id, m.index));
        return;
      case 'collapse':
        await app.projects.update((c) => C.setCollapsed(c, m.id, m.collapsed));
        return;
      case 'git':
        if (project) {
          const ok = await app.gitOp(project, m.op);
          if (ok) this.toast(`git ${m.op} · ${project.name} ✓`);
        }
        return;
      case 'refresh':
        if (project) {
          await app.meta.refreshOne(project.path, { force: true, fetch: true });
        } else {
          void app.meta.refresh(app.projects.projects.map((p) => p.path), { force: true, fetch: settings().fetchOnOpen });
          void app.scan({ notify: false });
        }
        return;
      case 'addCurrent':
        await vscode.commands.executeCommand('repoBoard.addCurrent');
        return;
      case 'addFolder':
        await vscode.commands.executeCommand('repoBoard.addFolder');
        return;
      case 'scan':
        await app.scan({ notify: true });
        return;
      case 'addScanRoot':
        await app.addScanRoot();
        return;
      case 'fetchAll':
        await app.bulk('fetch');
        return;
      case 'pullAll':
        await app.bulk('pull');
        return;
      case 'getStarted':
        await vscode.commands.executeCommand('repoBoard.getStarted');
        return;
      case 'startPage':
        await vscode.commands.executeCommand(m.on ? 'repoBoard.setStartPage' : 'repoBoard.unsetStartPage');
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + app.context.extension.id);
        return;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.app.context.extensionUri, ...p)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('dist', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('media', 'dashboard.css')}">
<title>Repo Board</title>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (DashboardPanel.instance === this) DashboardPanel.instance = undefined;
    this.app.projects.off('change', this.onChange);
    this.app.meta.off('update', this.onMeta);
    this.app.meta.off('busy', this.onBusy);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}
