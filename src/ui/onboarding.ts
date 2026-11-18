import * as vscode from 'vscode';
import { App, settings } from '../app';

export const WALKTHROUGH = 'repoBoard.setup';
const PREVIOUS_STARTUP_EDITOR = 'repoBoard.previousStartupEditor';
const WELCOMED = 'repoBoard.welcomed';

/**
 * First-run guidance: the "Get started with Repo Board" walkthrough, plus the commands it calls
 * to make the board the start page of new windows (and to undo that).
 */
export function registerOnboarding(context: vscode.ExtensionContext, app: App): void {
  const openWalkthrough = () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#${WALKTHROUGH}`, false);

  context.subscriptions.push(
    vscode.commands.registerCommand('repoBoard.getStarted', openWalkthrough),
    vscode.commands.registerCommand('repoBoard.setStartPage', () => setStartPage(context, true)),
    vscode.commands.registerCommand('repoBoard.unsetStartPage', () => setStartPage(context, false)),
    // Lets the walkthrough step be completed by choosing to keep VS Code's own Welcome page.
    vscode.commands.registerCommand('repoBoard.keepWelcome', () => {
      void vscode.window.showInformationMessage('Keeping the Welcome page. You can make Repo Board your start page later from its ⋯ menu.');
    }),
  );

  void firstRun(context, app, openWalkthrough);
}

/**
 * VS Code opens a new extension's walkthrough by itself. Other editors (or users who turned that
 * off) get one notification instead, the first time Repo Board runs with nothing set up.
 */
async function firstRun(context: vscode.ExtensionContext, app: App, openWalkthrough: () => Thenable<unknown>): Promise<void> {
  if (context.globalState.get<boolean>(WELCOMED)) {
    return;
  }
  await context.globalState.update(WELCOMED, true);
  await app.projects.ensureLoaded();
  if (app.projects.projects.length > 0 || settings().scanRoots.length > 0) {
    return;
  }
  const vscodeOpensIt =
    vscode.env.appName.startsWith('Visual Studio Code') &&
    vscode.workspace.getConfiguration('workbench').get<boolean>('welcomePage.walkthroughs.openOnInstall', true);
  if (vscodeOpensIt) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Repo Board is installed. Choose the folders that hold your repos to fill the board.',
    'Get started',
    'Not now',
  );
  if (choice === 'Get started') {
    await openWalkthrough();
  }
}

/**
 * Turning it on opens the board in every new empty window and, so the two don't compete, sets
 * `workbench.startupEditor` to `none`. The previous value is remembered and restored on undo.
 */
async function setStartPage(context: vscode.ExtensionContext, on: boolean): Promise<void> {
  const board = vscode.workspace.getConfiguration('repoBoard');
  const workbench = vscode.workspace.getConfiguration('workbench');
  if (on) {
    const previous = workbench.inspect<string>('startupEditor')?.globalValue;
    if (context.globalState.get(PREVIOUS_STARTUP_EDITOR) === undefined) {
      await context.globalState.update(PREVIOUS_STARTUP_EDITOR, { value: previous ?? null });
    }
    await board.update('showOnStartup', true, vscode.ConfigurationTarget.Global);
    if (workbench.get<string>('startupEditor') !== 'none') {
      await workbench.update('startupEditor', 'none', vscode.ConfigurationTarget.Global);
    }
    const undo = await vscode.window.showInformationMessage(
      'Repo Board is now your start page: it opens in every new window without a folder.',
      'Undo',
    );
    if (undo) {
      await setStartPage(context, false);
    }
    return;
  }
  await board.update('showOnStartup', false, vscode.ConfigurationTarget.Global);
  const saved = context.globalState.get<{ value: string | null }>(PREVIOUS_STARTUP_EDITOR);
  if (saved && workbench.get<string>('startupEditor') === 'none') {
    await workbench.update('startupEditor', saved.value ?? undefined, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update(PREVIOUS_STARTUP_EDITOR, undefined);
  void vscode.window.showInformationMessage('Repo Board no longer opens on startup. VS Code’s usual start page is back.');
}
