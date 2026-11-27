import * as os from 'node:os';
import * as vscode from 'vscode';
import { App, settings } from '../app';
import { branchToPushLabel } from '../domain/gitParse';
import { fetchFreshness } from '../domain/freshness';
import { Collection, Project, WorktreeInfo, changedFiles, hasUncommittedWork, worktreeChanges } from '../domain/model';
import { displayPath, pathKey } from '../domain/paths';
import { relativeTime, sortProjects } from '../domain/search';

type Node =
  | { kind: 'group'; id: string; label: string; icon: string; color?: string | undefined; projects: Project[] }
  | { kind: 'project'; project: Project }
  | { kind: 'worktree'; project: Project; worktree: WorktreeInfo };

/** Sidebar tree: Pinned, then each collection, then ungrouped — with branch and status inline. */
export class ProjectTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  private readonly onChange = () => this.schedule();
  private readonly onMeta = () => this.schedule();

  constructor(private readonly app: App) {
    app.projects.on('change', this.onChange);
    app.meta.on('update', this.onMeta);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), 250);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node?.kind === 'group') {
      return node.projects.map((project) => ({ kind: 'project', project }));
    }
    if (node?.kind === 'project') {
      const trees = this.app.meta.get(node.project.path)?.git?.worktrees ?? [];
      return trees.map((worktree) => ({ kind: 'worktree', project: node.project, worktree }));
    }
    if (node) {
      return [];
    }
    // The first call can come before activation has read the catalog.
    await this.app.projects.ensureLoaded();
    const catalog = this.app.projects.current;
    if (catalog.projects.length === 0) {
      return [];
    }
    const meta = Object.fromEntries(catalog.projects.map((p) => [p.id, this.app.meta.get(p.path)]));
    const sorted = sortProjects(catalog.projects, meta, settings().defaultSort);
    const groups: Node[] = [];
    const pinned = sorted.filter((p) => p.pinned);
    if (pinned.length) {
      groups.push({ kind: 'group', id: '__pinned', label: 'Pinned', icon: 'pinned', projects: pinned });
    }
    for (const c of catalog.collections) {
      const members = sorted.filter((p) => !p.pinned && p.collectionId === c.id);
      if (members.length) {
        groups.push(groupFor(c, members));
      }
    }
    const loose = sorted.filter((p) => !p.pinned && !p.collectionId);
    if (loose.length) {
      if (groups.length === 0) {
        return loose.map((project) => ({ kind: 'project', project }));
      }
      groups.push({ kind: 'group', id: '__ungrouped', label: 'Other', icon: 'repo', projects: loose });
    }
    return groups;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.id}`;
      item.description = String(node.projects.length);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = 'group';
      return item;
    }
    const p = node.project;
    const m = this.app.meta.get(p.path);
    const git = m?.git;
    if (node.kind === 'worktree') {
      return worktreeItem(node.project, node.worktree);
    }
    const trees = this.app.meta.get(p.path)?.git?.worktrees ?? [];
    const item = new vscode.TreeItem(p.name, trees.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `project:${pathKey(p.path)}`;
    const bits: string[] = [];
    if (git) {
      bits.push(git.branch);
      const changes = changedFiles(git);
      if (changes) bits.push(`●${changes}`);
      const wtChanges = worktreeChanges(git);
      if (wtChanges) bits.push(changes ? `+${wtChanges} in worktrees` : `●${wtChanges} in worktrees`);
      if (git.behind) bits.push(`↓${git.behind}`);
      if (git.ahead) bits.push(`↑${git.ahead}`);
      if (git.unpushed) bits.push(`↑${git.unpushed}${git.unpushedCapped ? '+' : ''} not pushed`);
      if (git.branchesToPush?.length) bits.push(`${git.branchesToPush.length} branch${git.branchesToPush.length === 1 ? '' : 'es'} to push`);
      if (git.stashes) bits.push(`${git.stashes} stashed`);
    }
    if (m?.availability === 'missing') bits.push('missing');
    if (m?.availability === 'offline') bits.push('offline');
    item.description = bits.join(' ');
    const current = this.app.isCurrent(p);
    item.iconPath = new vscode.ThemeIcon(
      m?.availability && m.availability !== 'ok' ? 'warning' : current ? 'circle-filled' : git ? 'repo' : 'folder',
      current ? new vscode.ThemeColor('charts.green') : hasUncommittedWork(git) ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined,
    );
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${escapeMd(p.name)}**${current ? ' · _current_' : ''}\n\n`);
    if (p.description) tip.appendMarkdown(`${escapeMd(p.description)}\n\n`);
    tip.appendMarkdown(`\`${escapeMd(displayPath(p.path, os.homedir()))}\`\n\n`);
    if (git) {
      tip.appendMarkdown(`$(git-branch) ${escapeMd(git.branch)}${git.upstream ? ` → ${escapeMd(git.upstream)}` : ''}  \n`);
      if (git.lastCommit) {
        tip.appendMarkdown(`$(git-commit) ${escapeMd(git.lastCommit.subject)} · ${relativeTime(git.lastCommit.time * 1000)}  \n`);
      }
      const parts = [
        git.staged && `${git.staged} staged`,
        git.modified && `${git.modified} modified`,
        git.untracked && `${git.untracked} untracked`,
        git.conflicts && `${git.conflicts} conflicts`,
      ].filter(Boolean);
      if (parts.length) tip.appendMarkdown(`$(diff) ${parts.join(', ')}  \n`);
      const wtChanges = worktreeChanges(git);
      if (wtChanges) tip.appendMarkdown(`$(repo-forked) ${wtChanges} change${wtChanges === 1 ? '' : 's'} in worktrees  \n`);
      if (git.unpushed) tip.appendMarkdown(`$(arrow-up) ${git.unpushed}${git.unpushedCapped ? ' or more' : ''} commit${git.unpushed === 1 && !git.unpushedCapped ? '' : 's'} on ${escapeMd(git.branch)} not on any remote  \n`);
      for (const b of git.branchesToPush ?? []) tip.appendMarkdown(`$(git-branch) ${escapeMd(branchToPushLabel(b))}  \n`);
      if (git.stashes) {
        const oldest = git.stashList?.[git.stashList.length - 1];
        const age = oldest && git.stashList!.length === git.stashes ? ` (oldest ${relativeTime(oldest.time * 1000)})` : '';
        tip.appendMarkdown(`$(archive) ${git.stashes} stash${git.stashes === 1 ? '' : 'es'}${escapeMd(age)}  \n`);
      }
      const fresh = fetchFreshness(git);
      if (fresh.kind === 'failed') {
        tip.appendMarkdown(`$(warning) Fetch failed: ${escapeMd(git.fetchError ?? '')}  \n`);
      } else if (fresh.kind === 'never') {
        tip.appendMarkdown(`$(warning) Never fetched  \n`);
      } else if (fresh.kind !== 'none') {
        tip.appendMarkdown(`${fresh.kind === 'stale' ? '$(warning)' : '$(history)'} Last fetched ${escapeMd(fresh.label.replace(/^fetched /, ''))}  \n`);
      }
      if (git.error) tip.appendMarkdown(`$(warning) ${escapeMd(git.error)}  \n`);
      if (git.worktrees?.length) tip.appendMarkdown(`$(repo-forked) ${git.worktrees.length} linked worktree${git.worktrees.length === 1 ? '' : 's'}  \n`);
    }
    if (p.tags.length) tip.appendMarkdown(`\n${p.tags.map((t) => `\`#${escapeMd(t)}\``).join(' ')}`);
    item.tooltip = tip;
    item.contextValue = p.pinned ? 'project.pinned' : 'project';
    item.command = { command: 'repoBoard.item.open', title: 'Open', arguments: [node] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.app.projects.off('change', this.onChange);
    this.app.meta.off('update', this.onMeta);
    this.emitter.dispose();
  }
}

/** A linked worktree under its main repo. Clicking opens it; the inline button opens a new window. */
function worktreeItem(project: Project, wt: WorktreeInfo): vscode.TreeItem {
  const item = new vscode.TreeItem(wt.branch, vscode.TreeItemCollapsibleState.None);
  item.id = `worktree:${pathKey(wt.path)}`;
  item.description = wt.prunable ? 'folder gone' : wt.changes ? `●${wt.changes}` : '';
  item.iconPath = new vscode.ThemeIcon(wt.prunable ? 'warning' : 'repo-forked', wt.changes ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
  item.tooltip = `${wt.path}
Worktree of ${project.name}${wt.locked ? ' (locked)' : ''}`;
  item.contextValue = 'worktree';
  item.command = { command: 'repoBoard.worktree.open', title: 'Open', arguments: [{ kind: 'worktree', project, worktree: wt }] };
  return item;
}

/** Resolves the worktree a tree command was invoked on. */
export function worktreeArg(app: App, arg: unknown): { project: Project; path: string } | undefined {
  const node = arg as Node | undefined;
  if (node && typeof node === 'object' && node.kind === 'worktree') {
    const project = app.projects.byId(node.project.id);
    return project ? { project, path: node.worktree.path } : undefined;
  }
  return undefined;
}

function groupFor(c: Collection, projects: Project[]): Node {
  return { kind: 'group', id: c.id, label: c.name, icon: 'folder-library', color: c.color, projects };
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, '\\$&');
}

/** Resolves the project a tree/menu command was invoked on. */
export function projectArg(app: App, arg: unknown): Project | undefined {
  const node = arg as Node | undefined;
  if (node && typeof node === 'object' && node.kind === 'project') {
    return app.projects.byId(node.project.id);
  }
  return undefined;
}
