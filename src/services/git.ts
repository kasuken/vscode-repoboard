import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LOG_FORMAT, describeGitError, parseLogLine, parsePorcelainV2, pickRemoteUrl, remoteToWebUrl } from '../domain/gitParse';
import { GitStatus } from '../domain/model';

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

/** True when `folder` has a `.git` directory or `.git` file (worktree / submodule). One stat, no process. */
export async function isRepo(folder: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(folder, '.git'));
    return true;
  } catch {
    return false;
  }
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
    const [st, log, stash, remotes] = await Promise.all([
      read(['status', '--porcelain=v2', '--branch']),
      read(['log', '-1', `--format=${LOG_FORMAT}`]),
      read(['rev-list', '--walk-reflogs', '--count', 'refs/stash']),
      read(['remote', '-v']),
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
      stashes: stash.ok ? Number(stash.stdout.trim()) || 0 : 0,
    };
    if (parsed.upstream) {
      status.upstream = parsed.upstream;
    }
    const commit = log.ok ? parseLogLine(log.stdout) : undefined;
    if (commit) {
      status.lastCommit = commit;
    }
    const webUrl = remotes.ok ? remoteToWebUrl(pickRemoteUrl(remotes.stdout)) : undefined;
    if (webUrl) {
      status.webUrl = webUrl;
    }
    return status;
  }

  /** Background fetch of the current branch's remote. Non-interactive; hooks and fsmonitor off. */
  async fetch(folder: string): Promise<boolean> {
    const result = await run(folder, [...READ_FLAGS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head'], this.fetchTimeoutMs);
    return result.ok;
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
