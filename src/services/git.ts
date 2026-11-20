import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LOG_FORMAT, describeGitError, parseLogLine, parsePorcelainV2, parseStashList, parseWorktreeList, pickRemoteUrl, remoteToWebUrl, worktreeMainFromGitFile } from '../domain/gitParse';
import { GitStatus, WorktreeInfo } from '../domain/model';

export type RemoteOp = 'fetch' | 'pull' | 'push';

/**
 * Flags for every background read:
 *  - `--no-optional-locks` never takes the index lock, so we can't collide with the user's own git;
 *  - `core.fsmonitor=false` stops a repo-level fsmonitor hook (an arbitrary program) from running;
 *  - `core.hooksPath` pointed at nothing disables repo hooks for our calls.
 */
const READ_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off', '-c', 'color.ui=false'];

/** Never prompt: no terminal prompt, no Git Credential Manager dialog, no askpass GUI. */
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  missingGit?: boolean;
}

function run(cwd: string, args: string[], timeout: number, env = NON_INTERACTIVE_ENV): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      const missingGit = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? (error?.message || ''), ...(missingGit ? { missingGit } : {}) });
    });
  });
}

/**
 * When `folder` is a linked worktree, returns its main repository's folder. One small file read;
 * undefined for normal repos, submodules and non-repos.
 */
export async function worktreeMainOf(folder: string): Promise<string | undefined> {
  try {
    const gitPath = path.join(folder, '.git');
    if (!(await fs.lstat(gitPath)).isFile()) return undefined;
    return worktreeMainFromGitFile(await fs.readFile(gitPath, 'utf8'), folder, (from, to) => path.resolve(from, to));
  } catch {
    return undefined;
  }
}

/** True when `folder` has a `.git` directory or `.git` file (worktree / submodule). One stat, no process. */
export async function isRepo(folder: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(folder, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * When the remote was last fetched by anyone (git on the command line, VS Code, the Repo Board desktop app, another
 * window), in ms since the epoch. Read from file times only, no process: the newest of every `FETCH_HEAD` (own, common
 * dir, linked worktrees) and the remote-tracking reflogs, which `git clone` writes so a fresh clone still has a time.
 * null when nothing exists.
 */
export async function gitLastFetch(folder: string): Promise<number | null> {
  const mtime = async (p: string): Promise<number | null> => {
    try {
      return (await fs.stat(p)).mtimeMs;
    } catch {
      return null;
    }
  };
  // A failed fetch truncates FETCH_HEAD to 0 bytes (bumping its mtime); a successful one lists the fetched refs.
  const fetchHead = async (p: string): Promise<number | null> => {
    try {
      const st = await fs.stat(p);
      return st.size > 0 ? st.mtimeMs : null;
    } catch {
      return null;
    }
  };
  let gitdir = path.join(folder, '.git');
  let common = gitdir;
  try {
    if ((await fs.lstat(gitdir)).isFile()) {
      const m = /^gitdir:s*(.+)$/m.exec(await fs.readFile(gitdir, 'utf8'));
      if (!m) return null;
      gitdir = path.resolve(folder, m[1]!.trim());
      common = gitdir;
      try {
        const c = (await fs.readFile(path.join(gitdir, 'commondir'), 'utf8')).trim();
        if (c) common = path.resolve(gitdir, c);
      } catch {
        // no commondir: a plain gitdir
      }
    }
  } catch {
    return null;
  }
  const times: Array<number | null> = [await fetchHead(path.join(gitdir, 'FETCH_HEAD')), await fetchHead(path.join(common, 'FETCH_HEAD'))];
  try {
    for (const w of (await fs.readdir(path.join(common, 'worktrees'))).slice(0, 500)) times.push(await fetchHead(path.join(common, 'worktrees', w, 'FETCH_HEAD')));
  } catch {
    // no linked worktrees
  }
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 2000) return;
      if (e.isDirectory()) {
        if (depth < 6) await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        times.push(await mtime(path.join(dir, e.name)));
      }
    }
  };
  await walk(path.join(common, 'logs', 'refs', 'remotes'), 0);
  const found = times.filter((t): t is number => t !== null);
  return found.length ? Math.max(...found) : null;
}

export class GitClient {
  private gitMissing = false;

  constructor(private readonly timeoutMs = 8000, private readonly fetchTimeoutMs = 30000) {}

  get available(): boolean {
    return !this.gitMissing;
  }

  /** Local state, no network: three or four short processes per repo. `null` when not a repo. */
  async status(folder: string): Promise<GitStatus | null> {
    if (this.gitMissing || !(await isRepo(folder))) {
      return null;
    }
    const read = (args: string[]) => run(folder, [...READ_FLAGS, ...args], this.timeoutMs);
    const [st, log, stash, remotes, lastFetch] = await Promise.all([
      read(['status', '--porcelain=v2', '--branch']),
      read(['log', '-1', `--format=${LOG_FORMAT}`]),
      read(['stash', 'list', '--format=%gd%x1f%ct%x1f%gs']),
      read(['remote', '-v']),
      gitLastFetch(folder).catch(() => null),
    ]);
    if (st.missingGit) {
      this.gitMissing = true;
      return null;
    }
    if (!st.ok) {
      const error = describeGitError(st.stderr);
      if (!error) {
        return null;
      }
      return { branch: '?', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, error };
    }
    const parsed = parsePorcelainV2(st.stdout);
    const status: GitStatus = {
      branch: parsed.branch,
      detached: parsed.detached,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.staged,
      modified: parsed.modified,
      untracked: parsed.untracked,
      conflicts: parsed.conflicts,
      stashes: 0,
    };
    const stashList = stash.ok ? parseStashList(stash.stdout) : [];
    if (parsed.upstream) {
      status.upstream = parsed.upstream;
      if (typeof lastFetch === 'number' && lastFetch > 0) {
        status.lastFetchAt = lastFetch;
      }
    }
    const commit = log.ok ? parseLogLine(log.stdout) : undefined;
    if (commit) {
      status.lastCommit = commit;
    }
    const webUrl = remotes.ok ? remoteToWebUrl(pickRemoteUrl(remotes.stdout)) : undefined;
    if (webUrl) {
      status.webUrl = webUrl;
    }
    const main = await worktreeMainOf(folder);
    if (main) {
      // refs/stash is shared with the main repo, which shows it; repeating it on every worktree tile is noise.
      status.worktreeOf = main;
    } else {
      status.stashes = stashList.length;
      if (stashList.length) {
        status.stashList = stashList.slice(0, 50);
      }
      const worktrees = await this.worktrees(folder);
      if (worktrees.length) {
        status.worktrees = worktrees;
      }
    }
    return status;
  }

  /**
   * Linked worktrees of a main repo, with a change count each. Costs nothing for repos without
   * worktrees: `.git/worktrees` is checked before any process starts.
   */
  async worktrees(folder: string, maxWithStatus = 12): Promise<WorktreeInfo[]> {
    try {
      const entries = await fs.readdir(path.join(folder, '.git', 'worktrees'));
      if (entries.length === 0) return [];
    } catch {
      return [];
    }
    const list = await run(folder, [...READ_FLAGS, 'worktree', 'list', '--porcelain'], this.timeoutMs);
    if (!list.ok) return [];
    // Git always lists the main working tree first. Don't compare paths: git reports canonical ones
    // (macOS /private/var, Windows long names instead of 8.3, resolved symlinks) that may not match ours.
    const linked = parseWorktreeList(list.stdout)
      .slice(1)
      .filter((w) => !w.bare);
    return Promise.all(
      linked.map(async (w, i): Promise<WorktreeInfo> => {
        const info: WorktreeInfo = { path: path.resolve(w.path), branch: w.branch || 'HEAD', detached: w.detached, prunable: w.prunable, locked: w.locked };
        if (!w.prunable && i < maxWithStatus) {
          const st = await run(info.path, [...READ_FLAGS, 'status', '--porcelain=v2'], this.timeoutMs);
          if (st.ok) {
            const p = parsePorcelainV2(st.stdout);
            info.changes = p.staged + p.modified + p.untracked + p.conflicts;
          } else if ((st as { missingGit?: boolean }).missingGit) {
            info.prunable = true;
          }
        }
        return info;
      }),
    );
  }

  /**
   * Background fetch of the current branch's remote. Non-interactive; hooks and fsmonitor off. It writes FETCH_HEAD on
   * purpose: that timestamp is what every other tool (and our own "fetched 3d ago" hint) reads to know when the remote
   * was last contacted. `message` is git's stderr when it failed.
   */
  async fetch(folder: string): Promise<{ ok: boolean; message: string }> {
    const result = await run(folder, [...READ_FLAGS, 'fetch', '--quiet', '--no-tags'], this.fetchTimeoutMs);
    if (result.missingGit) {
      return { ok: false, message: 'git was not found on PATH.' };
    }
    return { ok: result.ok, message: result.ok ? '' : result.stderr.trim() || 'git fetch failed' };
  }

  /**
   * A fetch / pull / push the user asked for. Runs like their own git (their hooks apply, e.g. pre-push),
   * except fsmonitor stays off and nothing may prompt. Pull is fast-forward only: it never creates a merge.
   */
  async remote(folder: string, op: RemoteOp): Promise<{ ok: boolean; message: string }> {
    const args: Record<RemoteOp, string[]> = {
      fetch: ['fetch', '--quiet'],
      pull: ['pull', '--ff-only', '--quiet'],
      push: ['push', '--quiet'],
    };
    // A missing cwd also fails with ENOENT; check it first so it isn't reported as "git not found".
    if (!(await isRepo(folder))) {
      return { ok: false, message: `${folder} is not available or is not a git repository.` };
    }
    const result = await run(folder, ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args[op]], 180_000);
    if (result.missingGit) {
      return { ok: false, message: 'git was not found on PATH.' };
    }
    return { ok: result.ok, message: result.ok ? '' : result.stderr.trim() || `git ${op} failed` };
  }
}
