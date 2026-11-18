# Changelog

## 1.2.0

- **Worktrees stay with their repo.** Linked `git worktree` folders, such as the ones coding agents create, are no
  longer added as projects of their own. Each main repo shows a worktree badge, yellow when one has uncommitted work.
  Its menu lists every worktree with its branch and change count, and opens it, opens a terminal there or reveals it.
  Worktrees whose folder is gone are flagged.
- In the sidebar, worktrees appear as children of their repo, with open, new-window, terminal and reveal actions.
- Searching for a worktree's branch finds its repo, and the switcher shows each repo's worktree count.
- Worktree tiles added by earlier versions are removed on the next scan. Hand-added ones stay.
- New setting `repoBoard.worktrees`: `nested` (default) or `separate` to keep a tile per worktree.

## 1.1.3

- Documentation updates.

## 1.1.2

- Choosing folders to scan now opens the board and shows the scan in progress. The result is always reported:
  repos added, nothing new, repos you removed earlier, or no repos found with an option to search deeper.
- The setup guide's first step completes as soon as the board has repos, including folders that were already scanned.

## 1.1.1

- Documentation updates.

## 1.1.0

- **Setup guide**: a *Get started with Repo Board* walkthrough opens after install. It guides you through choosing the
  folders to scan, opening the board, trying the switcher and, optionally, making Repo Board your start page. Reopen it
  with **Repo Board: Get Started**, from the sidebar menu or from the empty board.
- **Start page**: **Use Repo Board as Start Page** opens the board in every new empty window in place of the Welcome
  page; **Stop Using Repo Board as Start Page** restores your previous `workbench.startupEditor` value. Both are also
  in the board's ⋯ menu.
- Editors that don't open walkthroughs on install, such as some VS Code forks, show a one-time *Get started*
  notification instead.

## 1.0.0

First public release.

- **Dashboard** in an editor tab with grid and list layouts, a status strip with one cell per repo, and filters for
  repos with changes, behind, ahead or unavailable. Filtered and search results show as one ranked grid.
- **Auto-discovery**: add scan folders and every git repo underneath is added. Removed repos stay removed.
- **Project switcher** (`Ctrl+Alt+P` / `Cmd+Alt+P`) with fuzzy search over names, paths, branches, collections and
  `#tags`.
- **Git status per repo** from one `git status --porcelain=v2` call: branch, ahead/behind, staged / modified /
  untracked / conflicted files, stashes, last commit, and a link to the remote (GitHub, GitLab, Bitbucket, Azure
  DevOps), always stripped of credentials.
- **Fetch all** and **pull all** (fast-forward only, four at a time, cancellable), plus per-repo fetch, pull and push.
- **Organise**: pins, tags, coloured collections, icons, drag & drop ordering, and sorting by last opened, name, last
  commit or most changes.
- **Sidebar tree**, **status bar item**, and full keyboard control of the dashboard.
- One board shared by VS Code, Insiders, Cursor, VSCodium and other VS Code-based editors, synced live between windows.
