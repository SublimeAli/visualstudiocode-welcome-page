import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
    RecentProject,
    getRecentProjects,
    getMaxProjects,
    checkExists,
    removeFromRecent,
    snapshotOf,
    projectFromSnapshot
} from './recentProjects';
import { ProjectMeta, TAG_COLORS, TagColor, MAX_NOTE_LENGTH, cleanNote, isTagColor } from './projectMeta';

const SORT_KEY = 'sortOrder';
const SORT_ORDERS = ['recent', 'name-asc', 'name-desc', 'path'] as const;
type SortOrder = typeof SORT_ORDERS[number];

/** Pinned projects that VS Code no longer lists sort after every listed one. */
const UNLISTED_RECENCY = 1_000_000_000;

function isSortOrder(value: unknown): value is SortOrder {
    return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

interface ProjectView extends RecentProject {
    pinned: boolean;
    note?: string;
    color?: TagColor;
}

const COLOR_LABELS: Record<TagColor, string> = {
    red: '🔴 Red',
    orange: '🟠 Orange',
    yellow: '🟡 Yellow',
    green: '🟢 Green',
    blue: '🔵 Blue',
    purple: '🟣 Purple'
};

export class WelcomePanel {
    public static currentPanel: WelcomePanel | undefined;
    public static readonly viewType = 'customWelcome';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private readonly _meta: ProjectMeta;
    private _disposables: vscode.Disposable[] = [];
    private _disposed = false;
    private _renderSeq = 0;

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

        WelcomePanel.currentPanel = new WelcomePanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;
        this._extensionUri = context.extensionUri;
        this._meta = new ProjectMeta(context.globalState);

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // When the tab comes back into view, rebuild the page so pins, notes and
        // "folder not found" markers are fresh (a hidden webview is reloaded from stale HTML).
        this._panel.onDidChangeViewState(() => {
            if (this._panel.visible) {
                this._update();
            }
        }, null, this._disposables);

        // Handle messages from the webview. The webview is treated as untrusted:
        // every message is validated and projects are only ever addressed by ID.
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    await this._handleMessage(message);
                } catch (error) {
                    console.error('Custom Welcome Page: failed to handle message', error);
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        WelcomePanel.currentPanel = undefined;
        this._disposed = true;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _post(message: unknown) {
        if (!this._disposed) {
            void this._panel.webview.postMessage(message);
        }
    }

    // ---- Data -------------------------------------------------------------

    /** Recent projects plus any pinned ones VS Code has forgotten, with pins/notes applied. */
    private async _collectProjects(withExists: boolean): Promise<ProjectView[]> {
        const recents = await getRecentProjects();
        const meta = this._meta.all();
        const known = new Set(recents.map(p => p.id));
        const list: RecentProject[] = [...recents];

        for (const [id, entry] of Object.entries(meta)) {
            if (entry.pinned && entry.snapshot && !known.has(id)) {
                const project = projectFromSnapshot(id, entry.snapshot, UNLISTED_RECENCY);
                if (project) {
                    list.push(project);
                }
            }
        }

        if (withExists) {
            await checkExists(list);
        }

        return list.map(p => ({
            ...p,
            pinned: meta[p.id]?.pinned === true,
            note: meta[p.id]?.note,
            color: meta[p.id]?.color
        }));
    }

    private async _resolve(id: unknown): Promise<ProjectView | undefined> {
        if (typeof id !== 'string') {
            return undefined;
        }
        const all = await this._collectProjects(false);
        return all.find(p => p.id === id);
    }

    // ---- Messages from the page ------------------------------------------

    private async _handleMessage(message: any): Promise<void> {
        if (!message || typeof message.command !== 'string') {
            return;
        }

        switch (message.command) {
            case 'openProject': {
                const project = await this._resolve(message.id);
                if (!project) {
                    break;
                }
                await checkExists([project]);
                if (project.exists === false) {
                    const choice = await vscode.window.showWarningMessage(
                        `“${project.name}” can't be found. It may have been moved or deleted.`,
                        'Remove from List'
                    );
                    if (choice === 'Remove from List') {
                        await this._remove(project);
                    }
                    break;
                }
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    project.uri,
                    { forceNewWindow: message.newWindow === true }
                );
                break;
            }
            case 'togglePin': {
                const project = await this._resolve(message.id);
                if (!project || typeof message.pinned !== 'boolean') {
                    break;
                }
                await this._meta.setPinned(project.id, message.pinned, snapshotOf(project));
                break;
            }
            case 'editTag': {
                const project = await this._resolve(message.id);
                if (project) {
                    await this._editTag(project);
                }
                break;
            }
            case 'removeProject': {
                const project = await this._resolve(message.id);
                if (!project) {
                    break;
                }
                await checkExists([project]);
                if (project.exists !== false) {
                    // Only projects confirmed missing can be removed from the page.
                    break;
                }
                await this._remove(project);
                break;
            }
            case 'setSort':
                if (isSortOrder(message.value)) {
                    await this._context.globalState.update(SORT_KEY, message.value);
                }
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
    }

    private async _remove(project: ProjectView): Promise<void> {
        const listed = (await getRecentProjects()).some(p => p.id === project.id);
        const gone = listed ? await removeFromRecent(project) : true;
        if (!gone) {
            vscode.window.showWarningMessage(
                `VS Code wouldn't remove “${project.name}” from its recent list.`
            );
            return;
        }
        // Forget any pin, note or colour too, so it can't come back as a ghost.
        await this._meta.setPinned(project.id, false, undefined);
        await this._meta.setTag(project.id, undefined, undefined);
        this._post({ command: 'removed', id: project.id });
    }

    private async _editTag(project: ProjectView): Promise<void> {
        const items: (vscode.QuickPickItem & { color?: TagColor })[] = [
            { label: 'No colour', description: project.color ? undefined : '(current)', color: undefined },
            ...TAG_COLORS.map(color => ({
                label: COLOR_LABELS[color],
                description: project.color === color ? '(current)' : undefined,
                color
            }))
        ];
        const pick = await vscode.window.showQuickPick(items, {
            title: `Colour tag for “${project.name}”`,
            placeHolder: 'Pick a colour to tell similar projects apart'
        });
        if (!pick) {
            return;
        }

        const typed = await vscode.window.showInputBox({
            title: `Note for “${project.name}”`,
            prompt: `Short note shown on the card (optional, up to ${MAX_NOTE_LENGTH} characters). Leave empty for none.`,
            value: project.note ?? '',
            validateInput: value =>
                value.length > MAX_NOTE_LENGTH ? `Keep it to ${MAX_NOTE_LENGTH} characters or fewer` : undefined
        });
        // Escape on the note step keeps whatever note was there before.
        const note = typed === undefined ? project.note : cleanNote(typed);
        const color = pick.color;

        await this._meta.setTag(project.id, note, color);
        this._post({ command: 'tagUpdated', id: project.id, note: note ?? '', color: color ?? '' });
    }

    // ---- Page -------------------------------------------------------------

    private async _update() {
        const seq = ++this._renderSeq;
        const html = await this._getHtmlForWebview(this._panel.webview);
        // Ignore stale renders (a newer one started) and panels closed meanwhile.
        if (this._disposed || seq !== this._renderSeq) {
            return;
        }
        this._panel.webview.html = html;
    }

    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'welcome.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'welcome.js')
        );

        const nonce = getNonce();
        const projects = await this._collectProjects(true);
        const maxProjects = getMaxProjects();
        const storedSort = this._context.globalState.get<unknown>(SORT_KEY);
        const sortOrder: SortOrder = isSortOrder(storedSort) ? storedSort : 'recent';

        const projectCards = projects.map(renderCard).join('');

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
        <section class="recent-projects" data-max="${maxProjects}" data-sort="${sortOrder}">
            <h2>Recent Projects</h2>
            <div class="toolbar">
                <input type="search" id="project-search" placeholder="Search projects (press / to focus)" aria-label="Search recent projects" autocomplete="off" spellcheck="false">
                <select id="project-sort" aria-label="Sort recent projects">
                    <option value="recent"${sortOrder === 'recent' ? ' selected' : ''}>Recently opened</option>
                    <option value="name-asc"${sortOrder === 'name-asc' ? ' selected' : ''}>Name (A–Z)</option>
                    <option value="name-desc"${sortOrder === 'name-desc' ? ' selected' : ''}>Name (Z–A)</option>
                    <option value="path"${sortOrder === 'path' ? ' selected' : ''}>Location</option>
                </select>
            </div>
            <div class="projects-grid">
                ${projectCards}
            </div>
            <p class="no-projects" id="no-matches" hidden>No projects match your search</p>
            <div class="show-all-row">
                <button type="button" class="show-all-btn" id="toggle-all" aria-expanded="false" hidden></button>
            </div>
            <p class="keys-hint">Arrow keys move · 1–9 open · Shift+1–9 new window · P pin · T note/colour · / search</p>
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

const ICON_FOLDER = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_WORKSPACE = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="8" rx="1" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="1" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1" stroke="currentColor" stroke-width="2"/></svg>`;
const ICON_PIN = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.7 4 13.9l.8-4.5L1.5 6.2 6 5.6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
const ICON_WINDOW = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 6h13" stroke="currentColor" stroke-width="1.3"/><path d="M9 11l2.5-2.5M9.5 8.5h2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_TAG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h5.5l6.5 6.5-5.5 5.5L2 7.5V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>`;
const ICON_REMOVE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderCard(project: ProjectView): string {
    const missing = project.exists === false;
    const classes = [
        'project-card',
        project.pinned ? 'pinned' : '',
        missing ? 'missing' : '',
        // Class names come from a fixed whitelist, never from stored text.
        project.color && isTagColor(project.color) ? `tag-${project.color}` : ''
    ].filter(Boolean).join(' ');

    const badges = [
        project.kind === 'workspace' ? '<span class="badge">Workspace</span>' : '',
        project.remote ? '<span class="badge">Remote</span>' : ''
    ].join('');

    const pinLabel = project.pinned ? 'Unpin project' : 'Pin project to the top';

    return `
            <div class="${classes}" data-id="${escapeHtml(project.id)}" data-name="${escapeHtml(project.name)}" data-path="${escapeHtml(project.displayPath)}" data-note="${escapeHtml(project.note ?? '')}" data-color="${escapeHtml(project.color ?? '')}" data-recency="${project.recencyIndex}" data-pinned="${project.pinned}" data-missing="${missing}">
                <div class="project-main" tabindex="0" role="button" aria-label="Open ${escapeHtml(project.name)}">
                    <div class="project-icon">${project.kind === 'workspace' ? ICON_WORKSPACE : ICON_FOLDER}</div>
                    <div class="project-name"><span class="project-title">${escapeHtml(project.name)}</span>${badges}</div>
                    <div class="project-path">${escapeHtml(project.displayPath)}</div>
                    <div class="project-footer">
                        <span class="tag-dot" aria-hidden="true"></span>
                        ${missing ? '<span class="missing-label">Not found</span>' : ''}
                        <span class="project-note"${project.note ? '' : ' hidden'}>${escapeHtml(project.note ?? '')}</span>
                        <span class="shortcut" aria-hidden="true"></span>
                    </div>
                </div>
                <div class="card-actions">
                    <button type="button" class="icon-btn pin-btn" data-act="pin" tabindex="-1" title="${pinLabel} (P)" aria-label="${pinLabel}" aria-pressed="${project.pinned}">${ICON_PIN}</button>
                    <button type="button" class="icon-btn" data-act="newWindow" tabindex="-1" title="Open in new window&#10;(Ctrl/Cmd+click, or Shift+1–9)" aria-label="Open in new window">${ICON_WINDOW}</button>
                    <button type="button" class="icon-btn" data-act="tag" tabindex="-1" title="Add note or colour (T)" aria-label="Add note or colour tag">${ICON_TAG}</button>
                    ${missing ? `<button type="button" class="icon-btn remove-btn" data-act="remove" tabindex="-1" title="Remove from list (Delete)" aria-label="Remove from list">${ICON_REMOVE}</button>` : ''}
                </div>
            </div>
        `;
}

function getNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
