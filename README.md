<p align="center">
  <img src="images/logo.png" width="128" alt="Repo Board logo">
</p>

<h1 align="center">Repo Board</h1>

<p align="center">
  <b>Every git repo on your machine, on one board in VS Code.</b><br>
  See which repos are dirty, behind or ahead at a glance. Jump into any of them with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard"><b>Install from the Marketplace</b></a>
  &nbsp;·&nbsp;
  <a href="https://kasuken.github.io/repoboard/">Website</a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp;
  <a href="#keyboard-shortcuts">Shortcuts</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/kasuken/vscode-repoboard/issues">Report an issue</a>
</p>

![Repo Board: search, filter by git state, switch between grid and list, light and dark themes](images/demo.gif)

> Want the board outside VS Code too? Repo Board is also a [desktop app](https://kasuken.github.io/repoboard/#download)
> for Windows, macOS and Linux. Both show the same board.

## Why Repo Board

If you have more than a handful of repos, you know the routine. You `cd` around to remember which one has uncommitted
work, forget to pull before starting, and scroll through **File › Open Recent** hoping the project is still there.

Repo Board replaces that with one screen:

- **It finds your repos for you.** Point it at `C:\code` or `~/src` once. Every repository underneath appears, and new
  clones show up by themselves.
- **It tells you where attention is needed.** Uncommitted changes, commits to pull or push, merge conflicts, stashes
  and missing folders, for every repo, without opening any of them.
- **It gets you there fast.** A fuzzy switcher from anywhere in VS Code, a keyboard-driven dashboard, and one click to
  open a repo, a terminal in it, or its page on GitHub, GitLab or Azure DevOps.
- **It keeps everything up to date in one go.** *Fetch all* and *Pull all* run across every repo, four at a time,
  fast-forward only.

## Features

### The whole fleet at a glance

The strip at the top has one cell per repo, coloured by its git state. The chips under it filter the board to what
matters right now: repos **with changes**, **behind**, **ahead** or **unavailable**. Sort by *most changes* and the
repos that need you come first.

![Repos with uncommitted changes, sorted by most changes](images/attention.png)

| Colour | Meaning |
| --- | --- |
| Yellow / tan | Uncommitted changes (staged, modified or untracked) |
| Amber | Behind its upstream: there is something to pull |
| Blue | Ahead of its upstream: there is something to push |
| Red | Merge conflicts |
| Green | Clean and in sync |
| Hatched | Folder deleted, or the drive or share is not connected |

Colours come from your VS Code theme's own git decoration colours, so the board looks native in every theme.

### Real git status on every tile

Each tile shows the branch, ahead/behind counts, how many files are staged, modified, untracked or conflicted, the
stash count, the last commit and when it happened, a GitHub-style language bar, and the project's own logo if it has
one. Fetch, pull and push buttons appear when there is something to do.

Most of this comes from a single `git status --porcelain=v2` call per repo. A board of 80 repos refreshes in a few
seconds and is shown instantly from cache while that happens.

### Auto-discovery

Add one or more **scan folders**, and Repo Board walks them (three levels deep by default). It stops at each `.git`,
never follows symlinks or junctions, and skips `node_modules` and friends. Repos you remove from the board stay
removed, even if they are still on disk.

### Worktrees stay with their repo

Linked `git worktree` folders, such as the ones coding agents create for each task, don't crowd the board.
They appear as a badge on their main repo's tile. The badge turns yellow when one of them has uncommitted
work. Click it to see each worktree's branch and change count, then open it, open a terminal there or reveal
it. Worktrees whose folder is gone are flagged. In the sidebar they show as children of their repo, and
searching for a worktree's branch finds its repo.

![A repo tile with its worktrees listed](images/worktrees.png)

Prefer every worktree as a project of its own? Set `repoBoard.worktrees` to `separate`.

### A switcher that knows your repos

Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> on macOS) anywhere in
VS Code. Type a few letters of a name, a path, a branch, a collection or a `#tag`. Pinned projects come first, then
the ones you opened most recently. Each result has buttons to open it in a new window, open a terminal there, or pin
it.

### Search that understands developers

The dashboard search is fuzzy on names (`chkweb` finds `checkout-web`) and also matches paths, descriptions, branches,
languages and collections. Start a word with `#` to filter by tag, and combine terms: `#acme pay`.

![Search filtered to the #acme tag](images/search.png)

### Organise as much or as little as you like

Pin favourites to the top. Group repos into coloured **collections**. Add **tags**, an emoji or short icon, and a
description. Sort by last opened, name, last commit or most changes, or pick *My order* and drag tiles and collections
wherever you want them. Switch between the grid and a dense list.

![Edit a project: name, description, icon, collection, colour and tags](images/edit.png)

![List view in a light theme](images/list-light.png)

### Everything one right-click away

Open, open in a new window, open a terminal, open the remote in the browser, reveal in the file explorer, copy the
path, fetch, pull, push, pin, edit or remove. The common ones have single-key shortcuts too.

![Context menu on a repo tile](images/menu.png)

### Everywhere in the editor

- **Sidebar tree** with the same groups, inline branch and status, and rich tooltips.
- **Status bar item** showing the current project and its change count. Click it to switch.
- **Last opened** is tracked however you open a folder (Repo Board, File › Open, the recent list or the `code` CLI),
  so *recent* really means recent.
- **One list for every editor.** VS Code, Insiders, Cursor, VSCodium and other VS Code-based editors on the same
  machine share the board, and open windows update each other live.

## Quick start

1. Install **Repo Board** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard),
   or run:

   ```bash
   code --install-extension emanuelebartolesi.vscode-repoboard
   ```

2. The **Get started with Repo Board** guide opens by itself. It takes you through four steps:
   - choose the folders that hold your repos
   - open the board
   - try the switcher
   - optionally make Repo Board your start page

   You can reopen it any time with **Repo Board: Get Started**.
3. From now on, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> to switch projects.

Want a single repo instead of a whole folder? Use **Repo Board: Add Current Folder** or **Add Folder…**.

### Make it your start page

Choose **Use Repo Board as start page** in the setup guide or in the board's **⋯** menu. Every new window that starts
without a folder then opens the board, in place of VS Code's Welcome page: `repoBoard.showOnStartup` is turned on and
`workbench.startupEditor` is set to `none`. **Repo Board: Stop Using Repo Board as Start Page** turns it off and
restores your previous start-up setting.

## Keyboard shortcuts

![Keyboard shortcuts dialog](images/help.png)

| Key | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> | Switch project, from anywhere in VS Code |
| <kbd>/</kbd> | Search the board |
| Arrow keys, <kbd>Home</kbd>, <kbd>End</kbd> | Move between repos |
| <kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Open / open in the other window |
| <kbd>T</kbd> | Open a terminal in the repo |
| <kbd>B</kbd> | Open the remote in the browser |
| <kbd>F</kbd> / <kbd>R</kbd> | Fetch / refresh status |
| <kbd>P</kbd> / <kbd>E</kbd> | Pin / edit details |
| <kbd>Del</kbd> | Remove from the board |
| <kbd>Esc</kbd> | Clear the search |
| <kbd>?</kbd> | Show all shortcuts |

The switcher keybinding is `repoBoard.switch`, so you can rebind it in **Keyboard Shortcuts**.

## Commands

| Command | What it does |
| --- | --- |
| Repo Board: Get Started | Opens the setup guide |
| Repo Board: Open Dashboard | Opens the board in an editor tab |
| Repo Board: Switch Project… | Opens the fuzzy project switcher |
| Repo Board: Add Current Folder | Adds the open folder or `.code-workspace` |
| Repo Board: Add Folder… | Adds one folder |
| Repo Board: Add Folder to Scan… | Adds a scan folder and scans it |
| Repo Board: Scan Folders for Repos | Re-scans all scan folders now |
| Repo Board: Refresh Status | Re-reads git status, and fetches if `fetchOnOpen` is on |
| Repo Board: Fetch All Repos | Fetches every repo that has an upstream |
| Repo Board: Pull All Repos That Are Behind | Fast-forwards every repo that is behind |
| Repo Board: Pin / Unpin Current Project | Toggles the pin on the open project |
| Repo Board: Remove Projects Whose Folder Is Gone | Cleans up deleted folders; unplugged drives are kept |
| Repo Board: Forget Removed Repos | Lets scans add repos you removed earlier |
| Repo Board: Use Repo Board as Start Page | Opens the board in every new empty window |
| Repo Board: Stop Using Repo Board as Start Page | Restores your previous start-up behaviour |
| Repo Board: Open Data File | Opens `catalog.json` for backup or hand editing |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `repoBoard.scanRoots` | `[]` | Folders scanned for git repositories. `~` works. Kept per machine, never synced. |
| `repoBoard.scanDepth` | `3` | Folder levels searched below each scan folder (1–8) |
| `repoBoard.autoScan` | `true` | Re-scan when the dashboard opens, at most every 10 minutes |
| `repoBoard.worktrees` | `nested` | `nested` shows linked worktrees inside their main repo; `separate` gives each its own tile |
| `repoBoard.ignoreDirs` | `node_modules`, `bin`, `obj`, `dist`, … | Folder names skipped by discovery and language detection |
| `repoBoard.openInNewWindow` | `false` | Open projects in a new window by default |
| `repoBoard.showOnStartup` | `false` | Open the dashboard in windows that start without a folder |
| `repoBoard.defaultView` | `grid` | `grid` or `list` |
| `repoBoard.defaultSort` | `recent` | `manual`, `recent`, `name`, `commit` or `changes` |
| `repoBoard.fetchOnOpen` | `true` | Background `git fetch` when the dashboard opens, so ahead/behind is real |
| `repoBoard.cacheMinutes` | `5` | How long git status is reused before it is read again |
| `repoBoard.detectLanguages` | `true` | Show the language bar |
| `repoBoard.maxFilesScanned` | `10000` | File cap per project for language detection |
| `repoBoard.statusBar` | `true` | Show the current project in the status bar |

## Privacy and safety

- **No telemetry, no account, no cloud.** The only network traffic is git talking to your own remotes.
- **Background git never prompts.** Status reads and background fetches disable terminal prompts, Git Credential
  Manager dialogs and askpass helpers. They never take the index lock, and run with repository hooks and
  `core.fsmonitor` turned off. Fetch, pull and push that you start yourself run like your own git, hooks included.
- **Pull never merges.** Every pull is `--ff-only`. Bulk pull skips repos with conflicts. There is no "push all".
- **Credentials never leak into links.** Remote URLs such as `https://user:token@host/…` are always stripped before
  they are shown or opened.
- **Your data is one readable file:** `%APPDATA%\repoboard\catalog.json` on Windows,
  `~/Library/Application Support/repoboard` on macOS, `$XDG_CONFIG_HOME/repoboard` (default `~/.config/repoboard`) on
  Linux. Writes are atomic, and a damaged file is kept as a backup instead of being overwritten.

## FAQ

**Does it work with Cursor, VSCodium or Insiders?**
Yes. It runs in any editor that supports VS Code extensions, and every editor on the same machine shares one board.

**Does it scan my whole disk?**
No. It only walks the scan folders you choose, to the depth you set, and stops at each repository it finds.

**A repo shows "Git refuses this repo (dubious ownership)". What now?**
Git doesn't trust a folder owned by another user. Run the command shown on the tile
(`git config --global --add safe.directory <path>`) and refresh.

**Can I back up or move my board?**
Copy `catalog.json` (see **Repo Board: Open Data File**). It is plain JSON and safe to edit by hand.

## Contributing

Bug reports, ideas and pull requests are welcome on [GitHub](https://github.com/kasuken/vscode-repoboard/issues).

```bash
git clone https://github.com/kasuken/vscode-repoboard.git
cd vscode-repoboard
npm install
npm run watch   # then press F5 to start an Extension Development Host
npm test        # unit tests
```

To work on the dashboard without starting VS Code, run `node dev/serve.mjs` and open
`http://localhost:5178/dev/harness.html`. It accepts parameters such as `?theme=light`, `?view=list`,
`?filter=changes` and `?q=pay`. `dev/showcase.html` wraps the same page in editor chrome; the screenshots in this
README come from it.

## Support

If Repo Board saves you time, [leave a review on the Marketplace](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-repoboard&ssr=false#review-details),
star the [repository](https://github.com/kasuken/vscode-repoboard), or
[sponsor the work](https://github.com/sponsors/kasuken). It really helps.

Released under the [MIT license](https://github.com/kasuken/vscode-repoboard/blob/main/LICENSE).
