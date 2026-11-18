import { Collection, GitStatus, ProjectMeta, SORT_MODES, SortMode, ViewMode, changedFiles, initialsFor, tagHue } from '../domain/model';
import { fieldsOf, matchScore, relativeTime, sortProjects } from '../domain/search';
import type { BoardState, HostMessage, ProjectEdit, ProjectView, WebviewMessage } from './protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

// ── UI state (persisted per panel) ─────────────────────────────────────────

type Filter = 'all' | 'changes' | 'behind' | 'ahead' | 'missing';
interface UiState {
  query: string;
  sort?: SortMode;
  view?: ViewMode;
  filter: Filter;
  tag?: string | undefined;
  focusedId?: string | undefined;
  collapsed: string[];
}
const ui: UiState = { query: '', filter: 'all', collapsed: [], ...((vscode.getState() as Partial<UiState> | undefined) ?? {}) };
const saveUi = () => vscode.setState(ui);

let board: BoardState | undefined;
let busy = new Set<string>();
let pendingEdit: string | undefined;

const sortMode = (): SortMode => ui.sort ?? board?.settings.defaultSort ?? 'recent';
const viewMode = (): ViewMode => ui.view ?? board?.settings.defaultView ?? 'grid';

// ── DOM helpers (textContent only — every string from git or the user is untrusted) ──

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) if (v !== undefined) el.style.setProperty(prop, v);
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const icon = (name: string, extra = '') => h('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });

function iconButton(name: string, label: string, onclick: (e: MouseEvent) => void, extra: Props = {}): HTMLButtonElement {
  return h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(name));
}

const mod = () => (board?.settings.isMac ? '⌘' : 'Ctrl');

// ── Derived data ───────────────────────────────────────────────────────────

type RepoState = 'conflict' | 'missing' | 'offline' | 'dirty' | 'behind' | 'ahead' | 'clean' | 'nogit' | 'unknown';

function stateOf(meta: ProjectMeta | undefined): RepoState {
  if (!meta) return 'unknown';
  if (meta.availability === 'missing') return 'missing';
  if (meta.availability === 'offline') return 'offline';
  const git = meta.git;
  if (!git) return 'nogit';
  if (git.conflicts) return 'conflict';
  if (changedFiles(git)) return 'dirty';
  if (git.behind) return 'behind';
  if (git.ahead) return 'ahead';
  return 'clean';
}

const STATE_LABEL: Record<RepoState, string> = {
  conflict: 'has merge conflicts',
  missing: 'folder missing',
  offline: 'drive not connected',
  dirty: 'has uncommitted changes',
  behind: 'behind its upstream',
  ahead: 'ahead of its upstream',
  clean: 'clean',
  nogit: 'not a git repo',
  unknown: 'not checked yet',
};

function matchesFilter(p: ProjectView, filter: Filter): boolean {
  const meta = board!.meta[p.id];
  const git = meta?.git;
  switch (filter) {
    case 'all':
      return true;
    case 'changes':
      return changedFiles(git) > 0;
    case 'behind':
      return (git?.behind ?? 0) > 0;
    case 'ahead':
      return (git?.ahead ?? 0) > 0;
    case 'missing':
      return !!meta && meta.availability !== 'ok';
  }
}

function collectionName(id: string | undefined): string | undefined {
  return id ? board!.collections.find((c) => c.id === id)?.name : undefined;
}

/** Projects after search, filter chip and tag — in display order. */
function visibleProjects(): ProjectView[] {
  const b = board!;
  let list = b.projects.filter((p) => matchesFilter(p, ui.filter) && (!ui.tag || p.tags.some((t) => t.toLowerCase() === ui.tag!.toLowerCase())));
  if (ui.query.trim()) {
    const scored = list
      .map((p) => ({ p, score: matchScore(ui.query, fieldsOf(p, b.meta[p.id], collectionName(p.collectionId))) }))
      .filter((x) => x.score > 0)
      .sort((a, b2) => b2.score - a.score);
    return scored.map((x) => x.p);
  }
  list = sortProjects(list, b.meta, sortMode()) as ProjectView[];
  return list;
}

interface Section {
  key: string;
  title: string;
  collection?: Collection;
  color?: string | undefined;
  projects: ProjectView[];
  pinned?: boolean;
}

function sections(list: ProjectView[]): Section[] {
  const b = board!;
  const narrowed = !!ui.query.trim() || ui.filter !== 'all' || !!ui.tag;
  // Search and filter results read best as one ranked grid; groups would leave one tile per row.
  if (narrowed) return [{ key: '__results', title: '', projects: list }];
  const out: Section[] = [];
  const pinned = list.filter((p) => p.pinned);
  if (pinned.length) out.push({ key: '__pinned', title: 'Pinned', projects: pinned, pinned: true });
  for (const c of b.collections) {
    const members = list.filter((p) => !p.pinned && p.collectionId === c.id);
    if (members.length || !narrowed) out.push({ key: c.id, title: c.name, collection: c, color: c.color, projects: members });
  }
  const loose = list.filter((p) => !p.pinned && !p.collectionId);
  if (loose.length || (!narrowed && b.collections.length)) {
    out.push({ key: '__loose', title: out.length ? 'Ungrouped' : '', projects: loose });
  }
  return out;
}

const dragEnabled = () => sortMode() === 'manual' && !ui.query.trim() && ui.filter === 'all' && !ui.tag;

// ── Shell (built once) ─────────────────────────────────────────────────────

const SORT_LABEL: Record<SortMode, string> = {
  manual: 'My order',
  recent: 'Last opened',
  name: 'Name',
  commit: 'Last commit',
  changes: 'Most changes',
};

const root = document.getElementById('app')!;
const search = h('input', {
  class: 'search',
  type: 'search',
  placeholder: 'Search repos, paths, branches, #tags',
  'aria-label': 'Search repos',
  spellcheck: 'false',
  value: ui.query,
  oninput: () => {
    ui.query = search.value;
    saveUi();
    render();
  },
  onkeydown: (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (search.value) {
        search.value = '';
        ui.query = '';
        saveUi();
        render();
      } else focusTile(ui.focusedId);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      const first = main.querySelector<HTMLElement>('.tile');
      if (first) {
        if (e.key === 'Enter' && ui.query.trim()) openProject(first.dataset['id']!, e.ctrlKey || e.metaKey);
        else focusTile(first.dataset['id']);
      }
    }
  },
});
const sortSelect = h(
  'select',
  {
    class: 'select',
    'aria-label': 'Sort projects',
    onchange: () => {
      ui.sort = sortSelect.value as SortMode;
      saveUi();
      render();
    },
  },
  ...SORT_MODES.map((m) => h('option', { value: m, text: SORT_LABEL[m] })),
);
const viewToggle = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Layout' });
const scanButton = h('button', { class: 'btn', type: 'button', onclick: () => send({ type: board?.settings.hasScanRoots ? 'scan' : 'addScanRoot' }) });
const addButton = h('button', { class: 'btn primary', type: 'button', onclick: (e: MouseEvent) => openAddMenu(e.currentTarget as HTMLElement) }, icon('add'), 'Add');
const moreButton = iconButton('ellipsis', 'More actions', (e) => openBoardMenu(e.currentTarget as HTMLElement));
const refreshButton = iconButton('refresh', 'Refresh status and fetch', () => send({ type: 'refresh' }));
const strip = h('div', { class: 'pulse', 'aria-hidden': 'true' });
const filters = h('div', { class: 'filters', role: 'toolbar', 'aria-label': 'Filters' });
const main = h('main', { class: 'board', onkeydown: onBoardKey });
const toastBox = h('div', { class: 'toasts', role: 'status' });

root.append(
  h(
    'header',
    { class: 'top' },
    h('div', { class: 'search-wrap' }, icon('search', 'search-icon'), search, h('kbd', { class: 'search-key', text: '/' })),
    h('div', { class: 'controls' }, sortSelect, viewToggle, refreshButton, scanButton, addButton, moreButton),
  ),
  strip,
  filters,
  main,
  toastBox,
);

// ── Render ─────────────────────────────────────────────────────────────────

/** Coalesces bursts of status updates (dozens of repos reporting at once) into one render. */
let frame = 0;
function scheduleRender(): void {
  if (!frame) frame = window.setTimeout(() => render(), 40);
}

function render(): void {
  clearTimeout(frame);
  frame = 0;
  if (!board) return;
  const hadFocus = main.contains(document.activeElement);
  sortSelect.value = sortMode();
  sortSelect.title = dragEnabled() || sortMode() !== 'manual' ? '' : 'Drag & drop works when no search or filter is active';
  renderViewToggle();
  scanButton.replaceChildren(icon(board.scanning ? 'loading' : 'radio-tower', board.scanning ? 'codicon-modifier-spin' : ''), board.settings.hasScanRoots ? 'Scan' : 'Scan folder…');
  scanButton.disabled = board.scanning;
  scanButton.title = board.settings.hasScanRoots ? 'Find new repos in your scan folders' : 'Pick a folder that contains your repos';

  if (board.projects.length === 0) {
    strip.replaceChildren();
    filters.replaceChildren();
    main.replaceChildren(emptyBoard());
    return;
  }
  const list = visibleProjects();
  renderStrip(list);
  renderFilters();
  main.className = `board view-${viewMode()}`;
  const secs = sections(list);
  if (list.length === 0) {
    main.replaceChildren(noResults());
  } else {
    main.replaceChildren(...secs.map(renderSection));
  }
  if (!list.some((p) => p.id === ui.focusedId)) ui.focusedId = list[0]?.id;
  syncTabStops();
  if (hadFocus) focusTile(ui.focusedId);
}

function renderViewToggle(): void {
  const mk = (mode: ViewMode, name: string, label: string) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(viewMode() === mode),
        'aria-label': label,
        title: label,
        class: viewMode() === mode ? 'on' : '',
        onclick: () => {
          ui.view = mode;
          saveUi();
          render();
        },
      },
      icon(name),
    );
  viewToggle.replaceChildren(mk('grid', 'layout', 'Grid'), mk('list', 'list-flat', 'List'));
}

/** The signature element: every visible repo as one cell, coloured by state. */
function renderStrip(list: ProjectView[]): void {
  const cells = list.map((p) => {
    const st = stateOf(board!.meta[p.id]);
    return h('span', {
      class: `cell s-${st}${busy.has(p.id) ? ' busy' : ''}${p.id === ui.focusedId ? ' focused' : ''}`,
      'data-id': p.id,
      title: `${p.name} — ${STATE_LABEL[st]}`,
      onclick: () => {
        focusTile(p.id);
        document.querySelector(`.tile[data-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    });
  });
  strip.replaceChildren(...cells);
  strip.style.setProperty('--cells', String(Math.max(cells.length, 1)));
}

function renderFilters(): void {
  const b = board!;
  const count = (f: Filter) => b.projects.filter((p) => matchesFilter(p, f)).length;
  const chip = (f: Filter, label: string, cls: string) => {
    const n = count(f);
    if (f !== 'all' && n === 0 && ui.filter !== f) return null;
    return h(
      'button',
      {
        type: 'button',
        class: `chip ${cls}${ui.filter === f ? ' on' : ''}`,
        'aria-pressed': String(ui.filter === f),
        onclick: () => {
          ui.filter = ui.filter === f && f !== 'all' ? 'all' : f;
          saveUi();
          render();
        },
      },
      h('span', { class: 'chip-n', text: String(n) }),
      label,
    );
  };
  const tags = new Map<string, { tag: string; n: number }>();
  for (const p of b.projects) for (const t of p.tags) {
    const e = tags.get(t.toLowerCase());
    if (e) e.n++;
    else tags.set(t.toLowerCase(), { tag: t, n: 1 });
  }
  const tagChips = [...tags.values()]
    .sort((x, y) => y.n - x.n || x.tag.localeCompare(y.tag))
    .slice(0, 14)
    .map(({ tag, n }) => {
      const on = ui.tag?.toLowerCase() === tag.toLowerCase();
      return h(
        'button',
        {
          type: 'button',
          class: `chip tag${on ? ' on' : ''}`,
          'aria-pressed': String(on),
          style: { '--hue': String(tagHue(tag)) },
          title: `${n} project${n === 1 ? '' : 's'}`,
          onclick: () => {
            ui.tag = on ? undefined : tag;
            saveUi();
            render();
          },
        },
        `#${tag}`,
      );
    });
  const items: Child[] = [
    chip('all', 'repos', 'f-all'),
    chip('changes', 'with changes', 'f-dirty'),
    chip('behind', 'behind', 'f-behind'),
    chip('ahead', 'ahead', 'f-ahead'),
    chip('missing', 'unavailable', 'f-missing'),
    tagChips.length ? h('span', { class: 'filters-gap' }) : null,
    ...tagChips,
  ];
  filters.replaceChildren(...items.filter((x): x is Node => !!x));
  if (!b.gitAvailable) filters.append(h('span', { class: 'warn-inline' }, icon('warning'), 'git was not found on PATH, so status is unavailable'));
}

function isCollapsed(s: Section): boolean {
  return s.collection ? !!s.collection.collapsed : ui.collapsed.includes(s.key);
}

function renderSection(s: Section): HTMLElement {
  const collapsed = isCollapsed(s) && !ui.query.trim();
  const listEl = h('div', { class: 'tiles', role: 'list', 'aria-label': s.title || 'Projects' }, ...(collapsed ? [] : s.projects.map((p) => (viewMode() === 'grid' ? tile(p) : row(p)))));
  if (!collapsed && s.projects.length === 0) {
    listEl.append(h('div', { class: 'drop-hint', text: dragEnabled() ? 'Drag repos here' : 'No repos in this collection' }));
  }
  const section = h('section', { class: `section${collapsed ? ' collapsed' : ''}`, 'data-key': s.key, style: s.color ? { '--accent': s.color } : {} });
  if (s.title) {
    const toggle = () => {
      if (s.collection) send({ type: 'collapse', id: s.collection.id, collapsed: !collapsed });
      else {
        ui.collapsed = collapsed ? ui.collapsed.filter((k) => k !== s.key) : [...ui.collapsed, s.key];
        saveUi();
        render();
      }
    };
    const head = h(
      'div',
      { class: 'section-head' },
      h(
        'button',
        { type: 'button', class: 'section-toggle', 'aria-expanded': String(!collapsed), onclick: toggle },
        icon(collapsed ? 'chevron-right' : 'chevron-down'),
        s.pinned ? icon('pinned', 'section-glyph') : s.collection ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
        h('h2', { text: s.title }),
        h('span', { class: 'count', text: String(s.projects.length) }),
      ),
      s.collection ? iconButton('edit', `Edit collection ${s.title}`, () => openCollectionDialog(s.collection)) : null,
    );
    if (s.collection && dragEnabled()) {
      head.draggable = true;
      head.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('application/x-repoboard-collection', s.collection!.id);
        e.dataTransfer!.effectAllowed = 'move';
      });
    }
    section.append(head);
  }
  section.append(listEl);
  wireDrop(section, s);
  return section;
}

function avatar(p: ProjectView, meta: ProjectMeta | undefined): HTMLElement {
  const color = p.color ?? board!.collections.find((c) => c.id === p.collectionId)?.color;
  if (!p.icon && meta?.logo) {
    return h('span', { class: 'avatar img', 'aria-hidden': 'true' }, h('img', { src: meta.logo, alt: '' }));
  }
  return h('span', { class: `avatar${p.icon ? ' emoji' : ''}`, 'aria-hidden': 'true', style: color ? { '--accent': color } : {}, text: p.icon || initialsFor(p.name) });
}

function gitLine(git: GitStatus, compact = false, project?: ProjectView): HTMLElement {
  const changes = changedFiles(git);
  const parts: Child[] = [
    h('span', { class: 'branch', title: git.upstream ? `${git.branch} → ${git.upstream}` : `${git.branch} (no upstream)` }, icon(git.detached ? 'git-commit' : 'git-branch'), h('span', { text: git.branch })),
  ];
  if (git.conflicts) parts.push(h('span', { class: 'badge b-conflict', title: `${git.conflicts} conflicted file(s)` }, icon('warning'), String(git.conflicts)));
  if (changes) {
    const detail = [git.staged && `${git.staged} staged`, git.modified && `${git.modified} modified`, git.untracked && `${git.untracked} untracked`].filter(Boolean).join(', ');
    parts.push(h('span', { class: 'badge b-dirty', title: detail }, h('span', { class: 'pip', 'aria-hidden': 'true' }), compact ? String(changes) : `${changes} changed`));
  }
  if (git.behind) parts.push(h('span', { class: 'badge b-behind', title: `${git.behind} commit(s) to pull from ${git.upstream}` }, icon('arrow-down'), String(git.behind)));
  if (git.ahead) parts.push(h('span', { class: 'badge b-ahead', title: `${git.ahead} commit(s) to push to ${git.upstream}` }, icon('arrow-up'), String(git.ahead)));
  if (git.stashes) parts.push(h('span', { class: 'badge b-stash', title: `${git.stashes} stash entr${git.stashes === 1 ? 'y' : 'ies'}` }, icon('archive'), String(git.stashes)));
  const trees = git.worktrees ?? [];
  if (trees.length && project) {
    const dirty = trees.filter((w) => (w.changes ?? 0) > 0).length;
    parts.push(
      h(
        'button',
        {
          type: 'button',
          class: `badge b-wt${dirty ? ' has-changes' : ''}`,
          title: `${trees.length} linked worktree${trees.length === 1 ? '' : 's'}${dirty ? `, ${dirty} with changes` : ''}. Click to open one.`,
          'aria-label': `${trees.length} worktrees of ${project.name}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            openWorktreeMenu(project, e.currentTarget as HTMLElement);
          },
        },
        icon('repo-forked'),
        compact ? String(trees.length) : `${trees.length} worktree${trees.length === 1 ? '' : 's'}`,
      ),
    );
  }
  if (!changes && !git.behind && !git.ahead && !git.conflicts && git.upstream && !compact) {
    parts.push(h('span', { class: 'badge b-clean', title: `In sync with ${git.upstream}${git.fetchedAt ? `, fetched ${relativeTime(git.fetchedAt)}` : ''}` }, icon('check'), 'in sync'));
  }
  if (!git.upstream && !compact) parts.push(h('span', { class: 'muted small', text: 'local only' }));
  return h('div', { class: 'git' }, ...parts);
}

function langBar(meta: ProjectMeta | undefined): HTMLElement | null {
  const langs = meta?.languages ?? [];
  if (!langs.length) return null;
  const label = langs.map((l) => `${l.name} ${l.percent}%`).join(', ');
  return h('div', { class: 'langbar', role: 'img', 'aria-label': `Languages: ${label}`, title: label }, ...langs.map((l) => h('span', { style: { width: `${l.percent}%`, background: l.color } })));
}

function tile(p: ProjectView): HTMLElement {
  const meta = board!.meta[p.id];
  const st = stateOf(meta);
  const git = meta?.git;
  const isBusy = busy.has(p.id);
  const unavailable = st === 'missing' || st === 'offline';

  const title = h(
    'div',
    { class: 'title' },
    avatar(p, meta),
    h(
      'div',
      { class: 'title-text' },
      h('h3', { class: 'name' }, h('span', { text: p.name }), p.isCurrent ? h('span', { class: 'here', text: 'open here' }) : null, p.source === 'discovered' && !p.lastOpenedAt ? h('span', { class: 'new', text: 'new' }) : null),
      h('div', { class: 'path', title: p.path, text: p.displayPath }),
    ),
    h(
      'button',
      {
        type: 'button',
        class: `icon-btn pin${p.pinned ? ' on' : ''}`,
        title: p.pinned ? 'Unpin' : 'Pin to top',
        'aria-label': p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`,
        'aria-pressed': String(!!p.pinned),
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          send({ type: 'pin', id: p.id, pinned: !p.pinned });
        },
      },
      icon(p.pinned ? 'pinned' : 'pin'),
    ),
  );

  const body: Child[] = [];
  if (p.description) body.push(h('p', { class: 'desc', text: p.description }));
  if (unavailable) {
    body.push(h('div', { class: `notice n-${st}` }, icon(st === 'offline' ? 'debug-disconnect' : 'warning'), st === 'offline' ? 'Drive not connected — showing last known state' : 'Folder deleted or moved'));
  }
  if (git?.error) body.push(h('div', { class: 'notice n-missing', title: git.error }, icon('warning'), git.error));
  if (git && !git.error) {
    body.push(gitLine(git, false, p));
    if (git.lastCommit) {
      body.push(
        h(
          'div',
          { class: 'commit', title: `${git.lastCommit.hash} by ${git.lastCommit.author}` },
          h('span', { class: 'subject', text: git.lastCommit.subject }),
          h('time', { class: 'when', text: relativeTime(git.lastCommit.time * 1000) }),
        ),
      );
    }
  } else if (meta && !git && !unavailable) {
    body.push(h('div', { class: 'git muted small' }, icon('folder'), 'Not a git repository'));
  } else if (!meta) {
    body.push(h('div', { class: 'git muted small' }, icon('loading', 'codicon-modifier-spin'), 'Reading status…'));
  }
  if (p.tags.length) body.push(h('div', { class: 'tags' }, ...p.tags.map((t) => h('span', { class: 'tag', style: { '--hue': String(tagHue(t)) }, text: `#${t}` }))));

  const actions = h(
    'div',
    { class: 'actions' },
    h('button', { type: 'button', class: 'btn small open', title: `Open (${mod()}+click: other window)`, onclick: (e: MouseEvent) => { e.stopPropagation(); openProject(p.id, e.ctrlKey || e.metaKey); } }, icon('folder-opened'), 'Open'),
    iconButton('empty-window', 'Open in new window', (e) => { e.stopPropagation(); send({ type: 'open', id: p.id, newWindow: true }); }),
    iconButton('terminal', 'Open terminal here', (e) => { e.stopPropagation(); send({ type: 'terminal', id: p.id }); }),
    git?.webUrl ? iconButton('globe', `Open ${hostOf(git.webUrl)} in browser`, (e) => { e.stopPropagation(); send({ type: 'openRemote', id: p.id }); }) : null,
    h('span', { class: 'spacer' }),
    git?.upstream && !unavailable ? iconButton('cloud-download', git.behind ? `Pull ${git.behind} commit(s) (fast-forward)` : 'Fetch', (e) => { e.stopPropagation(); send({ type: 'git', id: p.id, op: git.behind ? 'pull' : 'fetch' }); }, { class: `icon-btn${git.behind ? ' attn-behind' : ''}` }) : null,
    git?.upstream && git.ahead && !unavailable ? iconButton('cloud-upload', `Push ${git.ahead} commit(s)`, (e) => { e.stopPropagation(); send({ type: 'git', id: p.id, op: 'push' }); }, { class: 'icon-btn attn-ahead' }) : null,
    iconButton(isBusy ? 'loading' : 'refresh', 'Refresh', (e) => { e.stopPropagation(); send({ type: 'refresh', id: p.id }); }, { class: `icon-btn${isBusy ? ' spinning' : ''}`, disabled: isBusy }),
    iconButton('kebab-vertical', 'More', (e) => { e.stopPropagation(); openTileMenu(p, e.currentTarget as HTMLElement); }),
  );

  const el = h(
    'article',
    {
      class: `tile s-${st}${p.isCurrent ? ' current' : ''}${unavailable ? ' dim' : ''}`,
      role: 'listitem',
      tabindex: '-1',
      'data-id': p.id,
      'aria-label': `${p.name}, ${STATE_LABEL[st]}${p.pinned ? ', pinned' : ''}`,
      style: p.color || board!.collections.find((c) => c.id === p.collectionId)?.color ? { '--accent': p.color ?? board!.collections.find((c) => c.id === p.collectionId)!.color! } : {},
      onfocus: () => setFocused(p.id),
      onclick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        openProject(p.id, e.ctrlKey || e.metaKey);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openTileMenu(p, e.currentTarget as HTMLElement, e);
      },
    },
    title,
    ...body,
    actions,
    langBar(meta),
  );
  wireDrag(el, p);
  return el;
}

function row(p: ProjectView): HTMLElement {
  const meta = board!.meta[p.id];
  const st = stateOf(meta);
  const git = meta?.git;
  const el = h(
    'article',
    {
      class: `tile rowtile s-${st}${p.isCurrent ? ' current' : ''}${st === 'missing' || st === 'offline' ? ' dim' : ''}`,
      role: 'listitem',
      tabindex: '-1',
      'data-id': p.id,
      'aria-label': `${p.name}, ${STATE_LABEL[st]}${p.pinned ? ', pinned' : ''}`,
      style: p.color ? { '--accent': p.color } : {},
      onfocus: () => setFocused(p.id),
      onclick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        openProject(p.id, e.ctrlKey || e.metaKey);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openTileMenu(p, e.currentTarget as HTMLElement, e);
      },
    },
    h('span', { class: `state-pip s-${st}`, title: STATE_LABEL[st], 'aria-hidden': 'true' }),
    avatar(p, meta),
    h('div', { class: 'row-name' }, h('span', { class: 'name', text: p.name }), p.isCurrent ? h('span', { class: 'here', text: 'open here' }) : null, h('span', { class: 'path', text: p.displayPath, title: p.path })),
    git && !git.error && st !== 'missing' && st !== 'offline'
      ? gitLine(git, true, p)
      : h('span', { class: `muted small${st === 'missing' ? ' n-missing' : ''}`, text: git?.error ?? (st === 'nogit' ? 'no git' : STATE_LABEL[st]) }),
    h('span', { class: 'when', text: git?.lastCommit ? relativeTime(git.lastCommit.time * 1000) : '' }),
    h('span', { class: 'row-lang', text: meta?.languages[0]?.name ?? '' }),
    h(
      'div',
      { class: 'actions' },
      iconButton('empty-window', 'Open in new window', () => send({ type: 'open', id: p.id, newWindow: true })),
      iconButton('terminal', 'Open terminal here', () => send({ type: 'terminal', id: p.id })),
      iconButton(p.pinned ? 'pinned' : 'pin', p.pinned ? 'Unpin' : 'Pin to top', () => send({ type: 'pin', id: p.id, pinned: !p.pinned }), { class: `icon-btn pin${p.pinned ? ' on' : ''}` }),
      iconButton('kebab-vertical', 'More', (e) => openTileMenu(p, e.currentTarget as HTMLElement)),
    ),
  );
  wireDrag(el, p);
  return el;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'remote';
  }
}

function emptyBoard(): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-strip', 'aria-hidden': 'true' }, ...Array.from({ length: 24 }, (_, i) => h('span', { style: { '--i': String(i) } }))),
    h('h1', { text: 'No repos on the board yet' }),
    h('p', { text: 'Pick a folder that holds your projects, such as C:\\code or ~/src. Every git repo inside it is added, and new ones show up the next time the board opens.' }),
    h(
      'div',
      { class: 'empty-actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => send({ type: 'addScanRoot' }) }, icon('radio-tower'), 'Scan a folder for repos'),
      board?.canAddCurrent ? h('button', { type: 'button', class: 'btn', onclick: () => send({ type: 'addCurrent' }) }, icon('add'), 'Add current folder') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => send({ type: 'addFolder' }) }, icon('folder'), 'Add one folder'),
    ),
    h('p', { class: 'empty-guide' }, 'First time here? ', h('button', { type: 'button', class: 'link', onclick: () => send({ type: 'getStarted' }) }, 'Open the setup guide'), ' to scan your folders and choose whether Repo Board opens in new windows.'),
  );
}

function noResults(): HTMLElement {
  const what = ui.query.trim() ? `match “${ui.query.trim()}”` : 'match these filters';
  return h(
    'div',
    { class: 'empty small' },
    h('p', { text: `No repos ${what}.` }),
    h('button', { type: 'button', class: 'btn', onclick: () => { ui.query = ''; search.value = ''; ui.filter = 'all'; ui.tag = undefined; saveUi(); render(); search.focus(); } }, 'Clear search and filters'),
  );
}

// ── Focus & keyboard ───────────────────────────────────────────────────────

function tiles(): HTMLElement[] {
  return [...main.querySelectorAll<HTMLElement>('.tile')];
}

/** Roving tabindex: one tile is in the tab order; its own buttons follow it, the rest are skipped. */
function syncTabStops(): void {
  for (const t of tiles()) {
    const on = t.dataset['id'] === ui.focusedId;
    t.tabIndex = on ? 0 : -1;
    for (const b of t.querySelectorAll<HTMLElement>('button')) b.tabIndex = on ? 0 : -1;
  }
  for (const c of strip.children) c.classList.toggle('focused', (c as HTMLElement).dataset['id'] === ui.focusedId);
}

function setFocused(id: string): void {
  if (ui.focusedId === id) return;
  ui.focusedId = id;
  saveUi();
  syncTabStops();
}

function focusTile(id: string | undefined): void {
  const el = id ? main.querySelector<HTMLElement>(`.tile[data-id="${CSS.escape(id)}"]`) : main.querySelector<HTMLElement>('.tile');
  if (!el) return;
  setFocused(el.dataset['id']!);
  el.focus({ preventScroll: false });
}

function moveFocus(dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'): void {
  const all = tiles();
  const cur = all.findIndex((t) => t.dataset['id'] === ui.focusedId);
  if (cur < 0) return focusTile(all[0]?.dataset['id']);
  let next = cur;
  if (dir === 'left') next = Math.max(0, cur - 1);
  else if (dir === 'right') next = Math.min(all.length - 1, cur + 1);
  else if (dir === 'home') next = 0;
  else if (dir === 'end') next = all.length - 1;
  else {
    const r = all[cur]!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const candidates = all
      .map((t, i) => ({ i, r: t.getBoundingClientRect() }))
      .filter(({ r: o }) => (dir === 'down' ? o.top > r.top + 4 : o.top < r.top - 4));
    if (candidates.length) {
      const rowTop = dir === 'down' ? Math.min(...candidates.map((c) => c.r.top)) : Math.max(...candidates.map((c) => c.r.top));
      const rowItems = candidates.filter((c) => Math.abs(c.r.top - rowTop) < 4);
      next = rowItems.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0]!.i;
    }
  }
  focusTile(all[next]?.dataset['id']);
}

function onBoardKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  const tileEl = target.closest<HTMLElement>('.tile');
  if (!tileEl) return;
  const onTile = target === tileEl;
  const id = tileEl.dataset['id']!;
  const p = board?.projects.find((x) => x.id === id);
  if (!p) return;
  const keys: Record<string, () => void> = {
    ArrowLeft: () => moveFocus('left'),
    ArrowRight: () => moveFocus('right'),
    ArrowUp: () => moveFocus('up'),
    ArrowDown: () => moveFocus('down'),
    Home: () => moveFocus('home'),
    End: () => moveFocus('end'),
  };
  if (onTile && keys[e.key]) {
    e.preventDefault();
    keys[e.key]!();
    return;
  }
  if (!onTile || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Enter') {
    e.preventDefault();
    openProject(id, e.ctrlKey || e.metaKey);
  } else if (e.ctrlKey || e.metaKey) {
    return;
  } else if (k === 'p') send({ type: 'pin', id, pinned: !p.pinned });
  else if (k === 'e') openEditDialog(id);
  else if (k === 't') send({ type: 'terminal', id });
  else if (k === 'r') send({ type: 'refresh', id });
  else if (k === 'f') send({ type: 'git', id, op: 'fetch' });
  else if (k === 'b') send({ type: 'openRemote', id });
  else if (e.key === 'Delete') confirmRemove(p);
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    openTileMenu(p, tileEl);
  } else return;
}

document.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).closest?.('input, textarea, select, dialog');
  if (typing) return;
  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
    e.preventDefault();
    search.focus();
    search.select();
  } else if (e.key === '?') {
    e.preventDefault();
    openHelp();
  } else if (e.key === 'g' && !main.contains(document.activeElement)) {
    focusTile(ui.focusedId);
  }
});

function openProject(id: string, invert: boolean): void {
  send({ type: 'open', id, newWindow: invert ? !board!.settings.openInNewWindow : board!.settings.openInNewWindow });
}

// ── Drag & drop (manual order only) ────────────────────────────────────────

let dragId: string | undefined;

function wireDrag(el: HTMLElement, p: ProjectView): void {
  if (!dragEnabled()) return;
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragId = p.id;
    e.dataTransfer!.setData('application/x-repoboard-project', p.id);
    e.dataTransfer!.effectAllowed = 'move';
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    dragId = undefined;
    el.classList.remove('dragging');
    clearDropMarks();
  });
}

function clearDropMarks(): void {
  for (const m of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) m.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function wireDrop(section: HTMLElement, s: Section): void {
  if (!dragEnabled()) return;
  section.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes('application/x-repoboard-project') && !(types.includes('application/x-repoboard-collection') && s.collection)) return;
    e.preventDefault();
    clearDropMarks();
    if (types.includes('application/x-repoboard-collection')) {
      section.classList.add('drop-before');
      return;
    }
    const over = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (over && over.dataset['id'] !== dragId) {
      const r = over.getBoundingClientRect();
      const after = viewMode() === 'list' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      over.classList.add(after ? 'drop-after' : 'drop-before');
    } else if (!over) section.classList.add('drop-into');
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget as Node)) clearDropMarks();
  });
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    const colId = e.dataTransfer!.getData('application/x-repoboard-collection');
    if (colId && s.collection) {
      const rest = board!.collections.filter((c) => c.id !== colId);
      send({ type: 'moveCollection', id: colId, index: rest.findIndex((c) => c.id === s.collection!.id) });
      clearDropMarks();
      return;
    }
    const id = e.dataTransfer!.getData('application/x-repoboard-project');
    const dragged = board!.projects.find((p) => p.id === id);
    if (!dragged) return;
    const marked = section.querySelector<HTMLElement>('.drop-before, .drop-after');
    const after = marked?.classList.contains('drop-after');
    clearDropMarks();
    if (s.pinned) {
      if (!dragged.pinned) send({ type: 'pin', id, pinned: true });
      return;
    }
    if (dragged.pinned) send({ type: 'pin', id, pinned: false });
    const collectionId = s.collection?.id ?? null;
    // Index among *all* catalog members of the target collection (pinned ones included), as the host expects.
    const members = board!.projects.filter((p) => (p.collectionId ?? null) === collectionId && p.id !== id);
    let index = members.length;
    if (marked?.dataset['id']) {
      const at = members.findIndex((p) => p.id === marked.dataset['id']);
      if (at >= 0) index = at + (after ? 1 : 0);
    }
    send({ type: 'moveProject', id, collectionId, index });
  });
}

// ── Menus ──────────────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  icon: string;
  run: () => void;
  danger?: boolean;
  hint?: string;
  /** Run instead of `run` on Ctrl/Cmd+click or Ctrl/Cmd+Enter. */
  alt?: () => void;
  /** Tooltip, e.g. a full path. */
  title?: string;
}

let openMenuEl: HTMLElement | undefined;

function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = undefined;
}

function showMenu(anchor: HTMLElement, items: Array<MenuItem | 'sep'>, at?: MouseEvent): void {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'sep') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const b = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: `menu-item${item.danger ? ' danger' : ''}`,
        title: item.title,
        onclick: (e: MouseEvent) => {
          closeMenu();
          (item.alt && (e.ctrlKey || e.metaKey) ? item.alt : item.run)();
          anchor.focus();
        },
      },
      icon(item.icon),
      h('span', { text: item.label }),
      item.hint ? h('kbd', { text: item.hint }) : null,
    );
    buttons.push(b);
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]!.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]!.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      anchor.focus();
    }
  });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = at ? at.clientX : r.right - mw;
  let y = at ? at.clientY : r.bottom + 4;
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  if (y + mh > window.innerHeight - 8) y = Math.max(8, (at ? at.clientY : r.top) - mh - 4);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  openMenuEl = menu;
  buttons[0]?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target as Node)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

function openTileMenu(p: ProjectView, anchor: HTMLElement, at?: MouseEvent): void {
  const git = board!.meta[p.id]?.git;
  showMenu(
    anchor,
    [
      { label: 'Open', icon: 'folder-opened', hint: 'Enter', run: () => openProject(p.id, false) },
      { label: 'Open in new window', icon: 'empty-window', hint: `${mod()}+Enter`, run: () => send({ type: 'open', id: p.id, newWindow: true }) },
      { label: 'Open terminal here', icon: 'terminal', hint: 'T', run: () => send({ type: 'terminal', id: p.id }) },
      ...(git?.webUrl ? [{ label: `Open on ${hostOf(git.webUrl)}`, icon: 'globe', hint: 'B', run: () => send({ type: 'openRemote', id: p.id }) }] : []),
      { label: 'Reveal in file explorer', icon: 'folder', run: () => send({ type: 'reveal', id: p.id }) },
      { label: 'Copy path', icon: 'copy', run: () => send({ type: 'copyPath', id: p.id }) },
      'sep',
      ...(git?.upstream
        ? [
            { label: 'Fetch', icon: 'sync', hint: 'F', run: () => send({ type: 'git', id: p.id, op: 'fetch' as const }) },
            { label: 'Pull (fast-forward only)', icon: 'cloud-download', run: () => send({ type: 'git', id: p.id, op: 'pull' as const }) },
            { label: 'Push', icon: 'cloud-upload', run: () => send({ type: 'git', id: p.id, op: 'push' as const }) },
            'sep' as const,
          ]
        : []),
      { label: p.pinned ? 'Unpin' : 'Pin to top', icon: p.pinned ? 'pinned' : 'pin', hint: 'P', run: () => send({ type: 'pin', id: p.id, pinned: !p.pinned }) },
      { label: 'Edit details…', icon: 'edit', hint: 'E', run: () => openEditDialog(p.id) },
      { label: 'Remove from board…', icon: 'trash', hint: 'Del', danger: true, run: () => confirmRemove(p) },
    ],
    at,
  );
}

/** Lists a repo's linked worktrees; picking one opens it (Ctrl/Cmd+click: the other window). */
function openWorktreeMenu(p: ProjectView, anchor: HTMLElement): void {
  const trees = board!.meta[p.id]?.git?.worktrees ?? [];
  const home = p.path.length ? p.path : '';
  const items: Array<MenuItem | 'sep'> = trees.map((w) => ({
    label: w.branch + (w.prunable ? ' (folder gone)' : ''),
    icon: w.prunable ? 'warning' : w.detached ? 'git-commit' : 'git-branch',
    hint: w.changes ? `●${w.changes}` : shortPath(w.path, home),
    run: () => send({ type: 'worktree', id: p.id, path: w.path, action: 'open' }),
    alt: () => send({ type: 'worktree', id: p.id, path: w.path, action: 'newWindow' }),
    title: w.path,
  }));
  if (trees.length) {
    items.push('sep');
    items.push({ label: 'Open a terminal in…', icon: 'terminal', run: () => openWorktreeSubmenu(p, anchor, 'terminal') });
    items.push({ label: 'Reveal in file explorer…', icon: 'folder', run: () => openWorktreeSubmenu(p, anchor, 'reveal') });
  }
  showMenu(anchor, items);
}

function openWorktreeSubmenu(p: ProjectView, anchor: HTMLElement, action: 'terminal' | 'reveal'): void {
  const trees = (board!.meta[p.id]?.git?.worktrees ?? []).filter((w) => !w.prunable);
  showMenu(anchor, trees.map((w) => ({ label: w.branch, icon: action === 'terminal' ? 'terminal' : 'folder', title: w.path, run: () => send({ type: 'worktree', id: p.id, path: w.path, action }) })));
}

/** The part of a worktree path that differs from its main repo, for menu hints. */
function shortPath(full: string, main: string): string {
  const parts = full.split(/[\/]/);
  return parts.slice(-2).join('/') || main;
}

function openAddMenu(anchor: HTMLElement): void {
  showMenu(anchor, [
    ...(board?.canAddCurrent ? [{ label: 'Add current folder', icon: 'add', run: () => send({ type: 'addCurrent' }) }] : []),
    { label: 'Add a folder…', icon: 'folder', run: () => send({ type: 'addFolder' }) },
    { label: 'Scan another folder for repos…', icon: 'radio-tower', run: () => send({ type: 'addScanRoot' }) },
    'sep',
    { label: 'New collection…', icon: 'folder-library', run: () => openCollectionDialog() },
  ]);
}

function openBoardMenu(anchor: HTMLElement): void {
  showMenu(anchor, [
    { label: 'Fetch all repos', icon: 'cloud-download', run: () => send({ type: 'fetchAll' }) },
    { label: 'Pull all repos that are behind', icon: 'repo-pull', run: () => send({ type: 'pullAll' }) },
    'sep',
    board?.settings.startPage
      ? { label: 'Stop opening on startup', icon: 'home', run: () => send({ type: 'startPage', on: false }) }
      : { label: 'Use as start page', icon: 'home', run: () => send({ type: 'startPage', on: true }) },
    { label: 'Setup guide', icon: 'rocket', run: () => send({ type: 'getStarted' }) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: openHelp },
    { label: 'Settings', icon: 'settings-gear', run: () => send({ type: 'openSettings' }) },
  ]);
}

// ── Dialogs ────────────────────────────────────────────────────────────────

const SWATCHES = ['#e5534b', '#f69d50', '#daaa3f', '#57ab5a', '#39c5cf', '#539bf5', '#986ee2', '#e275ad', '#768390'];

function dialog(title: string, content: HTMLElement[], buttons: HTMLElement[], onSubmit?: () => void): HTMLDialogElement {
  const form = h('form', { method: 'dialog', class: 'dialog-form' }, h('h2', { class: 'dialog-title', text: title }), ...content, h('div', { class: 'dialog-buttons' }, ...buttons));
  const d = h('dialog', { class: 'dialog', 'aria-label': title }, form);
  form.addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === 'ok' && onSubmit) onSubmit();
  });
  d.addEventListener('close', () => {
    d.remove();
    focusTile(ui.focusedId);
  });
  document.body.append(d);
  d.showModal();
  return d;
}

/** Not a submit button: Enter in a field must submit the dialog's primary action, never Cancel. */
function cancelButton(): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: (e: MouseEvent) => (e.currentTarget as HTMLElement).closest('dialog')?.close() });
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'field-hint', text: hint }) : null);
}

function swatchPicker(initial: string | undefined): { el: HTMLElement; value: () => string } {
  let value = initial ?? '';
  const custom = h('input', { type: 'color', class: 'swatch-custom', 'aria-label': 'Custom colour', value: initial && !SWATCHES.includes(initial) ? initial : '#539bf5' });
  const group = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' });
  const paint = () => {
    for (const b of group.querySelectorAll<HTMLElement>('[role=radio]')) b.setAttribute('aria-checked', String(b.dataset['value'] === value));
  };
  const mk = (v: string, label: string) =>
    h('button', {
      type: 'button',
      role: 'radio',
      class: `swatch${v ? '' : ' none'}`,
      'data-value': v,
      'aria-label': label,
      title: label,
      style: v ? { '--c': v } : {},
      onclick: () => {
        value = v;
        paint();
      },
    });
  group.append(mk('', 'No colour'), ...SWATCHES.map((c) => mk(c, c)), custom);
  custom.addEventListener('input', () => {
    value = custom.value;
    paint();
  });
  paint();
  return { el: group, value: () => value };
}

function openEditDialog(id: string): void {
  if (!board) {
    pendingEdit = id;
    return;
  }
  const p = board.projects.find((x) => x.id === id);
  if (!p) return;
  const name = h('input', { class: 'input', value: p.name, required: true, maxlength: '80' });
  const desc = h('textarea', { class: 'input', rows: '2', maxlength: '300', placeholder: 'What is this repo for?' });
  desc.value = p.description ?? '';
  const iconInput = h('input', { class: 'input icon-input', value: p.icon ?? '', maxlength: '16', placeholder: initialsFor(p.name) });
  const color = swatchPicker(p.color);
  const NEW = '__new';
  const collection = h(
    'select',
    { class: 'input' },
    h('option', { value: '', text: 'None' }),
    ...board.collections.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === p.collectionId })),
    h('option', { value: NEW, text: 'New collection…' }),
  );
  const newCollection = h('input', { class: 'input', placeholder: 'Collection name', hidden: true });
  collection.addEventListener('change', () => {
    newCollection.hidden = collection.value !== NEW;
    if (!newCollection.hidden) newCollection.focus();
  });
  const allTags = [...new Set(board.projects.flatMap((x) => x.tags))];
  const tagsInput = h('input', { class: 'input', value: p.tags.join(', '), placeholder: 'work, client-x, demo', list: 'rb-tags' });
  const datalist = h('datalist', { id: 'rb-tags' }, ...allTags.map((t) => h('option', { value: t })));

  const d = dialog(
    'Edit project',
    [
      field('Name', name),
      field('Description', desc),
      h('div', { class: 'field-row' }, field('Icon', iconInput, 'Emoji or up to 3 letters'), field('Collection', h('div', { class: 'stack' }, collection, newCollection))),
      field('Colour', color.el),
      field('Tags', tagsInput, 'Separate with commas'),
      datalist,
      h('p', { class: 'field-hint path-hint', text: p.path }),
    ],
    [
      h('button', { type: 'button', class: 'btn danger-ghost', onclick: () => { d.close(); confirmRemove(p); } }, icon('trash'), 'Remove from board'),
      h('span', { class: 'spacer' }),
      cancelButton(),
      h('button', { type: 'submit', class: 'btn primary', value: 'ok', text: 'Save' }),
    ],
    () => {
      const edit: ProjectEdit = {
        name: name.value,
        description: desc.value,
        icon: iconInput.value,
        color: color.value(),
        collectionId: collection.value && collection.value !== NEW ? collection.value : null,
        tags: tagsInput.value,
      };
      if (collection.value === NEW && newCollection.value.trim()) {
        pendingCollectionAssign = { projectId: p.id, name: newCollection.value.trim() };
        send({ type: 'saveCollection', name: newCollection.value.trim() });
      }
      send({ type: 'saveProject', id: p.id, edit });
    },
  );
  name.focus();
  name.select();
}

/** After "New collection…" in the edit form, the project joins it once the host has created it. */
let pendingCollectionAssign: { projectId: string; name: string } | undefined;

function openCollectionDialog(c?: Collection): void {
  const name = h('input', { class: 'input', value: c?.name ?? '', required: true, maxlength: '60', placeholder: 'Work, Side projects, Client X…' });
  const color = swatchPicker(c?.color);
  const d = dialog(
    c ? 'Edit collection' : 'New collection',
    [field('Name', name), field('Colour', color.el)],
    [
      c
        ? h('button', { type: 'button', class: 'btn danger-ghost', onclick: () => { d.close(); send({ type: 'removeCollection', id: c.id }); toast(`Deleted collection “${c.name}”. Its repos are now ungrouped.`); } }, icon('trash'), 'Delete collection')
        : h('span', { class: 'spacer' }),
      h('span', { class: 'spacer' }),
      cancelButton(),
      h('button', { type: 'submit', class: 'btn primary', value: 'ok', text: c ? 'Save' : 'Create collection' }),
    ],
    () => send({ type: 'saveCollection', ...(c ? { id: c.id } : {}), name: name.value, ...(color.value() ? { color: color.value() } : {}) }),
  );
  name.focus();
}

function confirmRemove(p: ProjectView): void {
  dialog(
    `Remove “${p.name}”?`,
    [
      h('p', { class: 'dialog-text', text: 'It is removed from Repo Board only. The folder and its files stay on disk.' }),
      h('p', { class: 'dialog-text muted', text: 'Folder scans will skip it from now on. Adding the folder again by hand undoes that.' }),
    ],
    [h('span', { class: 'spacer' }), cancelButton(), h('button', { type: 'submit', class: 'btn danger', value: 'ok', text: 'Remove' })],
    () => send({ type: 'removeProject', id: p.id }),
  );
}

function openHelp(): void {
  const rows: Array<[string, string]> = [
    ['/', 'Search'],
    ['↑ ↓ ← →', 'Move between repos'],
    ['Enter', 'Open'],
    [`${mod()}+Enter`, 'Open in the other window'],
    ['T', 'Terminal here'],
    ['B', 'Open remote in browser'],
    ['F', 'Fetch'],
    ['R', 'Refresh status'],
    ['P', 'Pin / unpin'],
    ['E', 'Edit details'],
    ['Del', 'Remove from board'],
    ['Esc', 'Clear search'],
    [board?.settings.isMac ? '⌘⌥P' : 'Ctrl+Alt+P', 'Switch project from anywhere in VS Code'],
  ];
  dialog(
    'Keyboard shortcuts',
    [h('dl', { class: 'keys' }, ...rows.flatMap(([k, v]) => [h('dt', {}, ...k.split(' ').map((part) => h('kbd', { text: part }))), h('dd', { text: v })]))],
    [h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn primary', value: 'cancel', text: 'Done' })],
  );
}

let toastTimer = 0;
function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'error' : 'check'), h('span', { text }));
  toastBox.replaceChildren(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2600);
}

// ── Host messages ──────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'state': {
      board = m.state;
      busy = new Set(m.state.busy);
      if (pendingCollectionAssign) {
        const col = board.collections.find((c) => c.name === pendingCollectionAssign!.name);
        if (col) {
          send({ type: 'moveProject', id: pendingCollectionAssign.projectId, collectionId: col.id, index: Number.MAX_SAFE_INTEGER });
          pendingCollectionAssign = undefined;
        }
      }
      render();
      if (pendingEdit) {
        const id = pendingEdit;
        pendingEdit = undefined;
        openEditDialog(id);
      }
      break;
    }
    case 'meta':
      if (board) {
        board.meta[m.id] = m.meta;
        scheduleRender();
      }
      break;
    case 'busy':
      if (m.busy) busy.add(m.id);
      else busy.delete(m.id);
      scheduleRender();
      break;
    case 'scanning':
      if (board) {
        board.scanning = m.scanning;
        scheduleRender();
      }
      break;
    case 'edit':
      openEditDialog(m.id);
      break;
    case 'focusSearch':
      search.focus();
      search.select();
      break;
    case 'toast':
      toast(m.text, m.kind);
      break;
  }
});

send({ type: 'ready' });
