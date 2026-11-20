// Stubs the VS Code webview API and plays the extension host with fictional sample repos.
// URL parameters (all optional) script the UI for screenshots:
//   theme=light | empty=1 | view=list | sort=changes | filter=changes|behind|ahead|stashes|stale|missing
//   offline=1 (the 'Offline' note) | q=<search> | tag=<tag> | edit=<project id> | focus=<project id> | help=1 | menu=<project id>
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'light') {
    document.getElementById('theme').href = '/dev/theme-light.css';
    document.body.className = 'vscode-light';
  }
  const now = Date.now();
  const ago = (seconds) => Math.round(now / 1000 - seconds);
  const H = 3600, D = 86400;
  const L = {
    TS: ['TypeScript', '#3178c6'], JS: ['JavaScript', '#f1e05a'], CS: ['C#', '#178600'], PY: ['Python', '#3572a5'],
    GO: ['Go', '#00add8'], RS: ['Rust', '#dea584'], CSS: ['CSS', '#663399'], SCSS: ['SCSS', '#c6538c'], HTML: ['HTML', '#e34c26'],
    HCL: ['HCL', '#844fba'], BICEP: ['Bicep', '#519aba'], SH: ['Shell', '#89e051'], SWIFT: ['Swift', '#f05138'], KT: ['Kotlin', '#a97bff'],
    VUE: ['Vue', '#41b883'], ASTRO: ['Astro', '#ff5a03'], RAZOR: ['Razor', '#512be4'],
  };
  const lang = (...pairs) => pairs.map(([[name, color], percent]) => ({ name, color, percent }));

  const collections = [
    { id: 'acme', name: 'Acme Commerce', color: '#539bf5' },
    { id: 'oss', name: 'Open source', color: '#57ab5a' },
    { id: 'side', name: 'Side projects', color: '#986ee2' },
    { id: 'arch', name: 'Archive', color: '#768390', collapsed: true },
  ];
  const P = (id, name, extra = {}) => ({
    id, name, path: `C:\\code\\${name}`, displayPath: `~\\code\\${name}`, tags: [], source: 'discovered', addedAt: now - 60 * D, isCurrent: false, ...extra,
  });
  const projects = [
    P('storefront', 'storefront', { pinned: true, icon: '🛍️', description: 'Customer-facing web shop, Next.js on the edge', tags: ['acme', 'web'], collectionId: 'acme', lastOpenedAt: now - 1 * H, isCurrent: true, source: 'manual' }),
    P('design', 'design-system', { pinned: true, icon: '🎨', description: 'Tokens, components and docs shared by every app', tags: ['web', 'oss'], collectionId: 'oss', lastOpenedAt: now - 4 * H }),
    P('payments', 'payments-api', { description: 'Payment orchestration service, .NET 10', tags: ['acme', 'dotnet'], collectionId: 'acme', lastOpenedAt: now - 1 * D }),
    P('checkout', 'checkout-web', { description: 'One-page checkout with Apple Pay and Klarna', tags: ['acme', 'web'], collectionId: 'acme', lastOpenedAt: now - 2 * D }),
    P('infra', 'acme-infra', { icon: '☁️', description: 'Terraform and Bicep for every environment', tags: ['acme', 'infra'], collectionId: 'acme', lastOpenedAt: now - 5 * D }),
    P('router', 'tiny-router', { description: 'A 2 kB client-side router', tags: ['oss'], collectionId: 'oss', lastOpenedAt: now - 3 * D }),
    P('theme', 'nightfall-theme', { icon: '🌙', description: 'A calm dark theme for VS Code', tags: ['oss', 'vscode'], collectionId: 'oss', lastOpenedAt: now - 20 * D }),
    P('lint', 'md-lint-action', { description: 'GitHub Action that lints Markdown in pull requests', tags: ['oss'], collectionId: 'oss' }),
    P('ray', 'rust-raytracer', { icon: '🦀', description: 'Weekend ray tracer, slowly becoming a month-long one', tags: ['fun'], collectionId: 'side', lastOpenedAt: now - 6 * H }),
    P('habit', 'habit-tracker-ios', { description: 'SwiftUI habit tracker with widgets', tags: ['mobile', 'fun'], collectionId: 'side', lastOpenedAt: now - 9 * D }),
    P('blog', 'blog', { icon: '✍️', description: 'Personal site and blog, built with Astro', tags: ['web'], lastOpenedAt: now - 2 * D }),
    P('dotfiles', 'dotfiles', { description: 'Shell, git and editor config', lastOpenedAt: now - 30 * D }),
    P('photos', 'photo-archive', { path: 'E:\\backup\\photo-archive', displayPath: 'E:\\backup\\photo-archive', description: 'Scripts for the NAS photo library', lastOpenedAt: now - 70 * D }),
    P('legacy', 'legacy-cms', { description: 'Replaced by storefront', lastOpenedAt: now - 200 * D }),
    P('kotlin', 'android-companion', { collectionId: 'arch', tags: ['mobile'] }),
  ];
  // lastFetchAt (ms) is when anyone last fetched: mostly minutes ago, overridden below for the stale / failed / never cases.
  let fetchSeq = 0;
  const git = (o) => ({ branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, fetchedAt: now - 300000, lastFetchAt: now - (4 + (fetchSeq++ % 7) * 6) * 60000, webUrl: 'https://github.com/acme/repo', ...o });
  const stash = (message, seconds, i) => ({ ref: `stash@{${i}}`, time: ago(seconds), message });
  const c = (subject, seconds) => ({ hash: Math.random().toString(16).slice(2, 9), subject, author: 'you', time: ago(seconds) });
  const meta = (g, languages, extra = {}) => ({ availability: 'ok', git: g, languages, updatedAt: now, languagesAt: now, ...extra });
  const M = {
    storefront: meta(git({ modified: 3, untracked: 1, stashes: 2, stashList: [stash('WIP on main: 9f3b2c1 Cache product pages at the edge', 2 * D, 0), stash('On feature/cart: try new cart drawer', 35 * D, 1)], lastCommit: c('Cache product pages at the edge', 1 * H), worktrees: [
      { path: 'C:/code/worktrees/storefront/agent-fix-checkout-total', branch: 'agent/fix-checkout-total', detached: false, changes: 6, prunable: false, locked: false },
      { path: 'C:/code/worktrees/storefront/agent-a11y-audit', branch: 'agent/a11y-audit', detached: false, changes: 0, prunable: false, locked: false },
      { path: 'C:/code/worktrees/storefront/review-pr-412', branch: 'review/pr-412', detached: false, changes: 0, prunable: true, locked: false },
    ] }), lang([L.TS, 78.4], [L.CSS, 14.1], [L.HTML, 7.5])),
    design: meta(git({ ahead: 2, lastCommit: c('Add Toast and Popover components', 4 * H) }), lang([L.TS, 61.2], [L.SCSS, 32.3], [L.HTML, 6.5])),
    payments: meta(git({ behind: 4, lastFetchAt: now - 3 * D * 1000, lastCommit: c('Retry webhooks with exponential backoff', 1 * D), webUrl: 'https://dev.azure.com/acme/commerce/_git/payments-api' }), lang([L.CS, 88.6], [L.BICEP, 11.4])),
    checkout: meta(git({ branch: 'feature/apple-pay', upstream: 'origin/feature/apple-pay', staged: 2, modified: 5, ahead: 1, behind: 2, stashes: 1, stashList: [stash('WIP on feature/apple-pay: 4e1c9a2 Apple Pay sheet', 3 * D, 0)], lastCommit: c('WIP: Apple Pay sheet', 2 * D) }), lang([L.VUE, 54], [L.TS, 39], [L.CSS, 7])),
    infra: meta(git({ lastFetchAt: now - 14 * D * 1000, fetchError: "fatal: Authentication failed for 'https://dev.azure.com/acme/_git/acme-infra'", lastCommit: c('Scale staging down at night', 5 * D) }), lang([L.HCL, 64], [L.BICEP, 30], [L.SH, 6])),
    router: meta(git({ conflicts: 2, modified: 1, lastCommit: c('Merge branch main into v3', 3 * D) }), lang([L.TS, 100])),
    theme: meta(git({ lastFetchAt: undefined, lastCommit: c('Softer selection background', 20 * D) }), lang([L.JS, 100])),
    lint: meta(git({ upstream: undefined, lastFetchAt: undefined, webUrl: undefined, stashes: 1, stashList: [stash('On main: fix flaky lint rule', 4 * D, 0)], lastCommit: c('Initial commit', 12 * H) }), lang([L.TS, 92], [L.SH, 8])),
    ray: meta(git({ untracked: 6, modified: 2, lastCommit: c('Soft shadows, finally', 6 * H) }), lang([L.RS, 100])),
    habit: meta(git({ behind: 1, lastCommit: c('Lock-screen widget', 9 * D) }), lang([L.SWIFT, 100])),
    blog: meta(git({ lastCommit: c('Post: what I learned shipping a VS Code extension', 2 * D) }), lang([L.ASTRO, 58], [L.TS, 24], [L.CSS, 18])),
    dotfiles: meta(null, lang([L.SH, 100])),
    photos: meta(git({ lastCommit: c('Deduplicate by hash', 70 * D) }), lang([L.PY, 100]), { availability: 'offline' }),
    legacy: meta(git({}), [], { availability: 'missing' }),
    kotlin: meta(git({ lastCommit: c('Archive', 300 * D) }), lang([L.KT, 100])),
  };
  const empty = params.get('empty');
  const state = {
    projects: empty ? [] : projects,
    collections: empty ? [] : collections,
    meta: M,
    busy: params.get('still') ? [] : ['ray'],
    settings: { openInNewWindow: false, defaultView: 'grid', defaultSort: 'recent', hasScanRoots: true, startPage: false, isMac: false },
    canAddCurrent: false,
    scanning: false,
    fetchOffline: !!params.get('offline'),
    gitAvailable: true,
  };
  const initialUi = {
    query: params.get('q') ?? '',
    filter: params.get('filter') ?? 'all',
    collapsed: [],
    ...(params.get('view') ? { view: params.get('view') } : {}),
    ...(params.get('sort') ? { sort: params.get('sort') } : {}),
    ...(params.get('tag') ? { tag: params.get('tag') } : {}),
    ...(params.get('focus') ? { focusedId: params.get('focus') } : {}),
  };
  if (params.get('menu') || params.get('wtmenu')) {
    // Headless capture blurs the iframe, which would close the menu before the screenshot.
    const add = window.addEventListener.bind(window);
    window.addEventListener = (type, ...rest) => (type === 'blur' || type === 'resize' ? undefined : add(type, ...rest));
  }
  const post = (m) => window.postMessage(m, '*');
  const repost = () => post({ type: 'state', state: JSON.parse(JSON.stringify(state)) });
  window.__sent = [];
  window.acquireVsCodeApi = () => ({
    getState: () => initialUi,
    setState: () => {},
    postMessage: (m) => {
      window.__sent.push(m);
      const p = state.projects.find((x) => x.id === m.id);
      if (m.type === 'ready') {
        repost();
        afterReady();
        return;
      }
      if (m.type === 'pin' && p) { p.pinned = m.pinned || undefined; return repost(); }
      if (m.type === 'collapse') { const col = state.collections.find((x) => x.id === m.id); col.collapsed = m.collapsed; return repost(); }
      if (m.type === 'saveProject' && p) { Object.assign(p, { name: m.edit.name, description: m.edit.description, icon: m.edit.icon || undefined, color: m.edit.color || undefined, collectionId: m.edit.collectionId || undefined, tags: m.edit.tags.split(',').map((t) => t.trim()).filter(Boolean) }); return repost(); }
      post({ type: 'toast', text: `host received: ${m.type}`, kind: 'info' });
    },
  });
  function afterReady() {
    setTimeout(() => {
      if (params.get('focus')) document.querySelector(`article.tile[data-id="${params.get('focus')}"]`)?.focus();
      if (params.get('edit')) post({ type: 'edit', id: params.get('edit') });
      if (params.get('help')) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    }, 60);
    setTimeout(() => {
      if (params.get('wtmenu')) document.querySelector(`article.tile[data-id="${params.get('wtmenu')}"] .b-wt`)?.click();
      if (params.get('menu')) {
        const tile = document.querySelector(`article.tile[data-id="${params.get('menu')}"]`);
        const r = tile.getBoundingClientRect();
        tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width * 0.55, clientY: r.top + 40 }));
      }
    }, 600);
  }
})();
