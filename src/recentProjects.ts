import * as vscode from 'vscode';
import * as path from 'path';

export type ProjectKind = 'folder' | 'workspace';

export interface RecentProject {
    /** Stable identifier: the full URI string. This is all the webview ever sends back. */
    id: string;
    uri: vscode.Uri;
    name: string;
    /** Human-readable location (local path, or "ssh-remote · /path" for remote projects). */
    displayPath: string;
    kind: ProjectKind;
    remote: boolean;
    /** Position in VS Code's own recency list (0 = most recently opened). */
    recencyIndex: number;
    /** true = on disk, false = confirmed missing, undefined = unknown (remote, slow disk, no permission). */
    exists?: boolean;
}

/** Shape stored for pinned projects so they can still be shown after VS Code forgets them. */
export interface ProjectSnapshot {
    name: string;
    displayPath: string;
    kind: ProjectKind;
    remote: boolean;
}

interface RecentlyOpenedItem {
    folderUri?: unknown;
    workspace?: {
        configPath?: unknown;
    };
    fileUri?: unknown;
}

interface RecentlyOpened {
    workspaces: RecentlyOpenedItem[];
}

const EXISTS_TIMEOUT_MS = 1500;
const WORKSPACE_EXT = '.code-workspace';

/** Accepts a real Uri or the plain object form the command may hand back. */
function toUri(value: unknown): vscode.Uri | undefined {
    if (value instanceof vscode.Uri) {
        return value;
    }
    const v = value as { scheme?: unknown; authority?: unknown; path?: unknown; query?: unknown; fragment?: unknown } | undefined;
    if (v && typeof v.scheme === 'string' && typeof v.path === 'string') {
        try {
            return vscode.Uri.from({
                scheme: v.scheme,
                authority: typeof v.authority === 'string' ? v.authority : '',
                path: v.path,
                query: typeof v.query === 'string' ? v.query : '',
                fragment: typeof v.fragment === 'string' ? v.fragment : ''
            });
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function describeLocation(uri: vscode.Uri): { displayPath: string; remote: boolean } {
    if (uri.scheme === 'file') {
        return { displayPath: uri.fsPath, remote: false };
    }
    // e.g. authority "ssh-remote+myhost" or "wsl+Ubuntu" or "dev-container+<long hex>"
    const [kind, ...rest] = uri.authority.split('+');
    let label = kind || uri.scheme;
    if (rest.length > 0 && kind !== 'dev-container' && kind !== 'attached-container') {
        label += ': ' + rest.join('+');
    }
    return { displayPath: `${label} · ${uri.path}`, remote: true };
}

export function snapshotOf(project: RecentProject): ProjectSnapshot {
    return {
        name: project.name,
        displayPath: project.displayPath,
        kind: project.kind,
        remote: project.remote
    };
}

export function projectFromSnapshot(id: string, snap: ProjectSnapshot, recencyIndex: number): RecentProject | undefined {
    try {
        return { id, uri: vscode.Uri.parse(id, true), recencyIndex, ...snap };
    } catch {
        return undefined;
    }
}

/**
 * Returns every recent project VS Code knows about, in recency order.
 * The "maxProjects" display limit is applied by the page, not here, so that
 * search can reach projects beyond the default view.
 */
export async function getRecentProjects(): Promise<RecentProject[]> {
    try {
        // Use the internal VS Code command to get recently opened workspaces
        const recentlyOpened = await vscode.commands.executeCommand<RecentlyOpened>(
            '_workbench.getRecentlyOpened'
        );

        if (!recentlyOpened || !recentlyOpened.workspaces) {
            return [];
        }

        const projects: RecentProject[] = [];
        const seen = new Set<string>();

        for (const item of recentlyOpened.workspaces) {
            const folderUri = toUri(item.folderUri);
            const workspaceUri = toUri(item.workspace?.configPath);
            const uri = folderUri ?? workspaceUri;
            if (!uri) {
                continue;
            }

            const id = uri.toString();
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);

            // A multi-root workspace is opened through its .code-workspace file,
            // not through the folder that happens to contain it.
            const kind: ProjectKind = folderUri ? 'folder' : 'workspace';
            const base = path.posix.basename(uri.path);
            let name = base;
            if (kind === 'workspace') {
                name = base === 'workspace.json'
                    ? 'Untitled Workspace'
                    : base.endsWith(WORKSPACE_EXT) ? base.slice(0, -WORKSPACE_EXT.length) : base;
            }
            const { displayPath, remote } = describeLocation(uri);

            projects.push({
                id,
                uri,
                name: name || displayPath,
                displayPath,
                kind,
                remote,
                recencyIndex: projects.length
            });
        }

        return projects;
    } catch (error) {
        console.error('Failed to get recent projects:', error);
        return [];
    }
}

async function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    try {
        return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Checks, in parallel, whether each local project still exists on disk.
 * Remote projects are never checked (that would mean opening a connection).
 * A slow or unreadable disk gives "unknown", never "missing".
 */
export async function checkExists(projects: RecentProject[]): Promise<void> {
    await Promise.all(projects.map(async (project) => {
        if (project.uri.scheme !== 'file') {
            project.exists = undefined;
            return;
        }
        try {
            await withTimeout(vscode.workspace.fs.stat(project.uri), EXISTS_TIMEOUT_MS);
            project.exists = true;
        } catch (error) {
            const e = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
            const text = `${String(e?.code ?? '')} ${String(e?.name ?? '')} ${String(e?.message ?? '')}`;
            project.exists = /NotFound|ENOENT/i.test(text) ? false : undefined;
        }
    }));
}

/** Asks VS Code to forget a project. Returns true if it is really gone afterwards. */
export async function removeFromRecent(project: RecentProject): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('vscode.removeFromRecentlyOpened', project.uri);
    } catch (error) {
        console.error('Failed to remove from recent projects:', error);
        return false;
    }
    const after = await getRecentProjects();
    return !after.some(p => p.id === project.id);
}

export function getMaxProjects(): number {
    return vscode.workspace.getConfiguration('customWelcome').get<number>('maxProjects', 10);
}
