import * as vscode from 'vscode';
import * as path from 'path';
import { getRecentProjects, RecentProject } from './recentProjects';

export class WelcomePanel {
    public static currentPanel: WelcomePanel | undefined;
    public static readonly viewType = 'customWelcome';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (WelcomePanel.currentPanel) {
            WelcomePanel.currentPanel._panel.reveal(column);
            return;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            WelcomePanel.viewType,
            'Welcome',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media')
                ]
            }
        );

        WelcomePanel.currentPanel = new WelcomePanel(panel, context.extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'openProject':
                        const uri = vscode.Uri.file(message.path);
                        await vscode.commands.executeCommand('vscode.openFolder', uri, false);
                        break;
                    case 'newFile':
                        await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
                        break;
                    case 'openFolder':
                        await vscode.commands.executeCommand('workbench.action.files.openFolder');
                        break;
                    case 'cloneRepo':
                        await vscode.commands.executeCommand('git.clone');
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        WelcomePanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = await this._getHtmlForWebview(webview);
    }

    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'welcome.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'welcome.js')
        );

        const nonce = getNonce();
        const projects = await getRecentProjects();

        const projectCards = projects.map(project => `
            <div class="project-card" data-path="${escapeHtml(project.path)}">
                <div class="project-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="project-info">
                    <div class="project-name">${escapeHtml(project.name)}</div>
                    <div class="project-path">${escapeHtml(project.path)}</div>
                </div>
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Welcome</title>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1>Welcome to VS Code</h1>
            <p class="subtitle">Start by opening a project or creating a new file</p>
        </header>

        <section class="actions">
            <button class="action-button" data-action="newFile">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 1H4C3.44772 1 3 1.44772 3 2V14C3 14.5523 3.44772 15 4 15H12C12.5523 15 13 14.5523 13 14V5L9 1Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M9 1V5H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M8 8V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M6 10H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                New File
            </button>
            <button class="action-button" data-action="openFolder">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 5V12C2 12.5523 2.44772 13 3 13H13C13.5523 13 14 12.5523 14 12V6C14 5.44772 13.5523 5 13 5H8L7 3H3C2.44772 3 2 3.44772 2 4V5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Open Folder
            </button>
            <button class="action-button" data-action="cloneRepo">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M5 8C5 6 6 4 8 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M11 8C11 10 10 12 8 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <circle cx="5" cy="8" r="1" fill="currentColor"/>
                    <circle cx="11" cy="8" r="1" fill="currentColor"/>
                </svg>
                Clone Repository
            </button>
        </section>

        ${projects.length > 0 ? `
        <section class="recent-projects">
            <h2>Recent Projects</h2>
            <div class="projects-grid">
                ${projectCards}
            </div>
        </section>
        ` : `
        <section class="recent-projects">
            <h2>Recent Projects</h2>
            <p class="no-projects">No recent projects found</p>
        </section>
        `}
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
