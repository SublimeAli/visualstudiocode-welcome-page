import * as vscode from 'vscode';
import { WelcomePanel } from './welcomePanel';

export function activate(context: vscode.ExtensionContext) {
    // Register the command to show the welcome page manually
    const showCommand = vscode.commands.registerCommand('customWelcome.show', () => {
        WelcomePanel.createOrShow(context);
    });
    context.subscriptions.push(showCommand);

    // Auto-disable the default welcome page on first run
    initializeWelcomeSettings(context);

    // Show the custom welcome page if no workspace is open
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        WelcomePanel.createOrShow(context);
    }
}

async function initializeWelcomeSettings(context: vscode.ExtensionContext): Promise<void> {
    const hasInitialized = context.globalState.get<boolean>('welcomeInitialized');

    if (!hasInitialized) {
        const config = vscode.workspace.getConfiguration();
        await config.update('workbench.startupEditor', 'none', vscode.ConfigurationTarget.Global);
        await context.globalState.update('welcomeInitialized', true);
    }
}

export function deactivate() {}
