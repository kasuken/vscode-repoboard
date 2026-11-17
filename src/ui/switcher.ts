import * as os from 'node:os';
import * as vscode from 'vscode';
import { App, settings } from '../app';
import { Project, changedFiles } from '../domain/model';
import { displayPath } from '../domain/paths';
import { sortProjects } from '../domain/search';

interface Item extends vscode.QuickPickItem {
  project?: Project;
}

const NEW_WINDOW: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: 'Open in new window' };
const TERMINAL: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'Open terminal here' };
const PIN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pin'), tooltip: 'Pin' };
const UNPIN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pinned'), tooltip: 'Unpin' };

/**
 * Fuzzy project switcher. Pinned first, then most recently opened. Matches name, path, branch,
 * tags and collection. Enter opens (per setting), the item buttons open a new window / terminal.
 */
export async function showSwitcher(app: App): Promise<void> {
  await app.projects.ensureLoaded();
  const pick = vscode.window.createQuickPick<Item>();
  pick.placeholder = 'Switch to a project — type to search names, paths, branches, #tags';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.buttons = [{ iconPath: new vscode.ThemeIcon('layout'), tooltip: 'Open dashboard' }];

  const build = () => {
    const catalog = app.projects.current;
    const collections = new Map(catalog.collections.map((c) => [c.id, c.name]));
    const meta = Object.fromEntries(catalog.projects.map((p) => [p.id, app.meta.get(p.path)]));
    const sorted = sortProjects(catalog.projects, meta, settings().defaultSort === 'manual' ? 'recent' : settings().defaultSort);
    const pinned = sorted.filter((p) => p.pinned);
    const rest = sorted.filter((p) => !p.pinned);
    const home = os.homedir();
    const toItem = (p: Project): Item => {
      const m = meta[p.id];
      const git = m?.git;
      const bits: string[] = [];
      if (git) {
        bits.push(`$(git-branch) ${git.branch}`);
        const changes = changedFiles(git);
        if (changes) bits.push(`$(diff) ${changes}`);
        if (git.behind) bits.push(`$(arrow-down)${git.behind}`);
        if (git.ahead) bits.push(`$(arrow-up)${git.ahead}`);
      }
      if (m?.availability === 'missing') bits.push('$(warning) folder missing');
      if (m?.availability === 'offline') bits.push('$(debug-disconnect) drive not connected');
      if (p.collectionId && collections.has(p.collectionId)) bits.push(`$(folder-library) ${collections.get(p.collectionId)}`);
      if (p.tags.length) bits.push(p.tags.map((t) => `#${t}`).join(' '));
      return {
        label: `${p.pinned ? '$(pinned) ' : ''}${p.icon ? p.icon + ' ' : ''}${p.name}`,
        description: (app.isCurrent(p) ? '● current · ' : '') + displayPath(p.path, home),
        detail: bits.join('  ·  ') || undefined,
        project: p,
        buttons: [NEW_WINDOW, TERMINAL, p.pinned ? UNPIN : PIN],
      } as Item;
    };
    const items: Item[] = [];
    if (pinned.length) {
      items.push({ label: 'Pinned', kind: vscode.QuickPickItemKind.Separator }, ...pinned.map(toItem));
    }
    if (rest.length) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator }, ...rest.map(toItem));
    }
    const active = pick.activeItems[0]?.project?.id;
    pick.items = items;
    if (active) {
      const same = items.find((i) => i.project?.id === active);
      if (same) pick.activeItems = [same];
    }
  };

  build();
  if (pick.items.length === 0) {
    pick.items = [{ label: '$(radio-tower) Scan a folder for repos…' }, { label: '$(add) Add current folder' }];
  }
  const sub = app.projects.on('change', build);
  const subMeta = () => build();
  app.meta.on('update', subMeta);

  pick.onDidTriggerButton(() => {
    pick.hide();
    void vscode.commands.executeCommand('repoBoard.open');
  });
  pick.onDidTriggerItemButton(async ({ item, button }) => {
    if (!item.project) return;
    if (button === NEW_WINDOW) {
      pick.hide();
      await app.open(item.project, true);
    } else if (button === TERMINAL) {
      pick.hide();
      app.terminal(item.project);
    } else {
      await app.setPinned(item.project, !item.project.pinned);
    }
  });
  pick.onDidAccept(async () => {
    const item = pick.selectedItems[0];
    pick.hide();
    if (item?.project) {
      await app.open(item.project);
    } else if (item?.label.includes('Scan')) {
      await app.addScanRoot();
    } else if (item?.label.includes('Add current')) {
      await vscode.commands.executeCommand('repoBoard.addCurrent');
    }
  });
  pick.onDidHide(() => {
    sub.off('change', build);
    app.meta.off('update', subMeta);
    pick.dispose();
  });
  pick.show();
  // Refresh stale local state in the background; results stream into the open picker.
  void app.meta.refresh(app.projects.projects.map((p) => p.path));
}
