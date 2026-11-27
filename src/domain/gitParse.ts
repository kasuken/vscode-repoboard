import { BranchToPush, CommitInfo, StashEntry } from './model';

/** Fields of `git status --porcelain=v2 --branch` that Repo Board shows. */
export interface ParsedStatus {
  branch: string;
  detached: boolean;
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
}

/**
 * Parses porcelain v2 output. One `git status` call gives the branch, upstream, ahead/behind and
 * the change counts, which is why Repo Board needs so few processes per repo.
 */
export function parsePorcelainV2(output: string): ParsedStatus {
  const status: ParsedStatus = { branch: 'HEAD', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice(13).trim();
      if (oid !== '(initial)') {
        status.oid = oid;
      }
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      if (head === '(detached)') {
        status.detached = true;
      } else {
        status.branch = head;
      }
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice(18).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') {
        status.staged++;
      }
      if (xy[1] !== '.') {
        status.modified++;
      }
    } else if (line.startsWith('u ')) {
      status.conflicts++;
    } else if (line.startsWith('? ')) {
      status.untracked++;
    }
  }
  if (status.detached) {
    status.branch = status.oid ? status.oid.slice(0, 7) : 'HEAD';
  }
  return status;
}

/** Unit separator between fields: commit subjects may contain anything else. */
export const LOG_FORMAT = '%h%x1f%s%x1f%an%x1f%ct';

export function parseLogLine(output: string): CommitInfo | undefined {
  const line = output.trim();
  if (!line) {
    return undefined;
  }
  const [hash, subject, author, time] = line.split('\x1f');
  if (!hash) {
    return undefined;
  }
  return { hash, subject: subject ?? '', author: author ?? '', time: Number(time) || 0 };
}

/** Picks `origin`'s fetch URL from `git remote -v`, else the first remote's. */
export function pickRemoteUrl(remoteVerbose: string): string | undefined {
  let first: string | undefined;
  for (const line of remoteVerbose.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (!m) {
      continue;
    }
    if (m[1] === 'origin') {
      return m[2];
    }
    first ??= m[2];
  }
  return first;
}

/**
 * Turns a git remote URL into a browser URL, always stripping credentials (https remotes often
 * embed tokens). Handles scp-like SSH, ssh://, https:// and Azure DevOps SSH. Returns undefined
 * for local or unrecognised remotes.
 */
export function remoteToWebUrl(remote: string | undefined): string | undefined {
  if (!remote) {
    return undefined;
  }
  const raw = remote.trim();

  // Azure DevOps SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const ado = raw.match(/^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.)?dev\.azure\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i);
  if (ado) {
    return `https://dev.azure.com/${ado[1]}/${ado[2]}/_git/${ado[3]}`;
  }
  // Old-style Azure DevOps SSH: org@vs-ssh.visualstudio.com:v3/org/project/repo
  const vsts = raw.match(/^[^@\s]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i);
  if (vsts) {
    return `https://dev.azure.com/${vsts[1]}/${vsts[2]}/_git/${vsts[3]}`;
  }

  let host: string;
  let pathPart: string;
  // scp-like: [user@]host:path (no scheme, no leading slash, not a Windows drive)
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    host = scp[1]!;
    pathPart = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) {
      return undefined;
    }
    host = url.hostname;
    // Keep a non-default port only for http(s): SSH ports never match the web UI.
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.port) {
      host += `:${url.port}`;
    }
    pathPart = url.pathname;
  }
  pathPart = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !pathPart) {
    return undefined;
  }
  return `https://${host}/${pathPart}`;
}

/**
 * One short, safe line out of a failed fetch's stderr: the first `fatal:` / `error:` line when there is one,
 * else the first line that is not a hint. Credentials in URLs are removed; at most 200 characters.
 */
export function cleanFetchError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.find((l) => !/^(hint|warning):/i.test(l)) ?? lines[0] ?? '';
  // scheme://user:pass@host and scheme://user@host become scheme://host. Greedy up to the last @ of the authority, so passwords containing @ go too.
  const safe = line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1');
  return safe.length > 200 ? `${safe.slice(0, 199)}…` : safe;
}

/**
 * True when a failed fetch collided with another git process working on the same repo (another Repo Board window, the
 * desktop app, VS Code's autofetch or the CLI): git cannot lock a ref or create a `.lock` file because someone else
 * holds it. That is not a network or credentials problem, so it must not be shown as "fetch failed".
 */
export function isConcurrentFetchError(stderr: string): boolean {
  return /cannot lock ref|unable to create '[^'\n]*\.lock': file exists|unable to update local ref/i.test(stderr);
}

/** Turns git's stderr into a short reason the UI can show. */
export function describeGitError(stderr: string): string | undefined {
  if (/dubious ownership/i.test(stderr)) {
    return 'Git refuses this repo (dubious ownership). Add it with: git config --global --add safe.directory <path>';
  }
  if (/not a git repository/i.test(stderr)) {
    return undefined;
  }
  const first = stderr.split(/\r?\n/).find((l) => l.trim());
  return first?.replace(/^(fatal|error):\s*/i, '').slice(0, 200);
}

export interface ParsedWorktree {
  path: string;
  branch: string;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
  locked: boolean;
}

/**
 * Parses `git worktree list --porcelain`. The first entry is the main working tree.
 * Paths are converted to the platform's separators by the caller if needed.
 */
export function parseWorktreeList(output: string): ParsedWorktree[] {
  const trees: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;
  let head = '';
  const finish = () => {
    if (current) {
      if (current.detached) current.branch = head ? head.slice(0, 7) : 'HEAD';
      trees.push(current);
    }
    current = undefined;
    head = '';
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      finish();
      current = { path: line.slice(9).trim(), branch: '', detached: false, bare: false, prunable: false, locked: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }
  finish();
  return trees;
}

/**
 * Given the contents of a `.git` *file* and the folder it lives in, returns the main repository's
 * folder when it is a linked worktree (`gitdir: <main>/.git/worktrees/<name>`), else undefined
 * (submodules point at `.git/modules/...` and are not worktrees).
 */
export function worktreeMainFromGitFile(contents: string, folder: string, resolve: (from: string, to: string) => string): string | undefined {
  const m = contents.match(/^gitdir:\s*(.+)$/m);
  if (!m) return undefined;
  const gitdir = resolve(folder, m[1]!.trim());
  const parts = gitdir.split(/[\\/]+/);
  const i = parts.lastIndexOf('worktrees');
  if (i < 1 || i !== parts.length - 2) return undefined;
  const commonDir = parts.slice(0, i);
  // <main>/.git/worktrees/x → <main>; a bare repo <repo.git>/worktrees/x → <repo.git>.
  const main = commonDir[commonDir.length - 1]!.toLowerCase() === '.git' ? commonDir.slice(0, -1) : commonDir;
  const joined = main.join(gitdir.includes('\\') ? '\\' : '/');
  return joined || undefined;
}

/**
 * Parses `git stash list --format=%gd%x1f%ct%x1f%gs`. Only lines with exactly three unit-separated fields count:
 * user config (e.g. log.showSignature) can inject other lines.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split('\x1f');
    if (f.length !== 3 || !f[0]) continue;
    out.push({ ref: f[0], time: Number(f[1]) || 0, message: f[2]! });
  }
  return out;
}

/** The branch a stash was made on, from `WIP on <b>: ...` or `On <b>: ...`. */
export function stashBranch(message: string): string | undefined {
  const m = message.match(/^(?:WIP on|On) (.+?): /);
  return m?.[1];
}

/**
 * A short menu label for a stash message: `WIP on main: 1a2b3c3 fix login` → `On main · fix login`,
 * `On feature: my note` → `On feature · my note`. Anything else is shown as git wrote it. At most 80 characters.
 */
export function stashLabel(message: string): string {
  const text = message.trim();
  const wip = text.match(/^WIP on (.+?): [0-9a-f]{4,40}(?: (.*))?$/);
  const on = wip ? undefined : text.match(/^On (.+?): (.*)$/);
  const m = wip ?? on;
  const label = m ? (m[2]?.trim() ? `On ${m[1]} · ${m[2].trim()}` : `On ${m[1]}`) : text;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

export interface BranchInfo {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** The upstream branch no longer exists on the remote. */
  gone: boolean;
}

/**
 * Parses `for-each-ref --format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket) refs/heads`:
 * `main US origin/main US behind 1`, `feature US origin/feature US ahead 2, behind 1`, `x US origin/x US gone`, `local US US`.
 * Lines without exactly three fields are skipped.
 */
export function parseBranchList(stdout: string): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split('\x1f');
    if (f.length !== 3 || !f[0]) continue;
    const track = f[2]!;
    const ahead = track.match(/ahead (\d+)/);
    const behind = track.match(/behind (\d+)/);
    const info: BranchInfo = { name: f[0], ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: /\bgone\b/.test(track) };
    if (f[1]) info.upstream = f[1];
    out.push(info);
  }
  return out;
}

/** The most commits `log --branches --not --remotes` is asked for. */
export const UNPUSHED_LOG_LIMIT = 500;

export interface UnpushedLog {
  /** Every commit on a local branch that no remote-tracking ref contains, with its parents. */
  commits: Map<string, string[]>;
  /** Branch name to the commit it points at, from the decorations. */
  tips: Map<string, string>;
  /** The commit HEAD's branch points at (`HEAD -> x`). */
  headTip?: string;
  /** The read returned its limit, so there may be more commits. */
  capped: boolean;
}

/**
 * Parses `log --branches --not --remotes --format=%H%x1f%P%x1f%D -n 500`. `%D` lists `HEAD -> x`, plain branch names
 * and `tag: t`; tags and a bare `HEAD` (detached) are ignored.
 */
export function parseUnpushedLog(stdout: string): UnpushedLog {
  const commits = new Map<string, string[]>();
  const tips = new Map<string, string>();
  let headTip: string | undefined;
  let lines = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    lines++;
    const f = line.split('\x1f');
    if (f.length < 2 || !f[0]) continue;
    const hash = f[0];
    commits.set(hash, f[1] ? f[1].split(' ').filter(Boolean) : []);
    for (const raw of (f[2] ?? '').split(',')) {
      const token = raw.trim();
      if (!token || token === 'HEAD' || token.startsWith('tag: ')) continue;
      const head = token.match(/^HEAD -> (.+)$/);
      const name = head ? head[1]! : token;
      tips.set(name, hash);
      if (head) headTip = hash;
    }
  }
  const log: UnpushedLog = { commits, tips, capped: lines >= UNPUSHED_LOG_LIMIT };
  if (headTip) log.headTip = headTip;
  return log;
}

/** How many commits of the unpushed set are reachable from `tip`, walking only through parents that are in the set. */
export function countReachable(tip: string | undefined, commits: Map<string, string[]>): number {
  if (!tip || !commits.has(tip)) return 0;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length) {
    const hash = stack.pop()!;
    for (const parent of commits.get(hash) ?? []) {
      if (!seen.has(parent) && commits.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen.size;
}

export interface UnpushedSummary {
  /** Unpushed commits on the current branch; only set for a branch without a live upstream. */
  current?: number;
  others: BranchToPush[];
}

/**
 * What exists only on this machine. Without a remote every commit is "unpushed", which says nothing, so nothing is
 * reported. The current branch counts only when it has no live upstream (otherwise `git status` already gives `ahead`).
 */
export function unpushedSummary(input: { branches: BranchInfo[]; unpushed: UnpushedLog; currentBranch: string | undefined; hasRemote: boolean }): UnpushedSummary {
  const { branches, unpushed, currentBranch, hasRemote } = input;
  if (!hasRemote) return { others: [] };
  const result: UnpushedSummary = { others: [] };
  for (const b of branches) {
    const live = !!b.upstream && !b.gone;
    if (b.name === currentBranch) {
      if (!live) {
        const n = countReachable(unpushed.headTip ?? unpushed.tips.get(b.name), unpushed.commits);
        if (n > 0) result.current = n;
      }
    } else if (live) {
      if (b.ahead > 0) result.others.push({ name: b.name, count: b.ahead, kind: 'ahead', upstream: b.upstream! });
    } else {
      const n = countReachable(unpushed.tips.get(b.name), unpushed.commits);
      if (n > 0) result.others.push({ name: b.name, count: n, kind: 'unpushed' });
    }
  }
  result.others.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).splice(20);
  return result;
}

/** Menu line for one branch with work to push: `other-local · 1 commit not on any remote`, `feature · 2 ahead of origin/feature`. */
export function branchToPushLabel(b: BranchToPush): string {
  return b.kind === 'ahead' ? `${b.name} · ${b.count} ahead of ${b.upstream ?? 'its upstream'}` : `${b.name} · ${b.count} ${b.count === 1 ? 'commit' : 'commits'} not on any remote`;
}
