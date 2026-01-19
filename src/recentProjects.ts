import * as vscode from 'vscode';
import * as path from 'path';

export interface RecentProject {
    name: string;
    path: string;
}

interface RecentlyOpenedItem {
    folderUri?: vscode.Uri;
    workspace?: {
        configPath: vscode.Uri;
    };
    fileUri?: vscode.Uri;
}

interface RecentlyOpened {
    workspaces: RecentlyOpenedItem[];
}

export async function getRecentProjects(): Promise<RecentProject[]> {
    const config = vscode.workspace.getConfiguration('customWelcome');
    const maxProjects = config.get<number>('maxProjects', 24);

    try {
        // Use the internal VS Code command to get recently opened workspaces
        const recentlyOpened = await vscode.commands.executeCommand<RecentlyOpened>(
            '_workbench.getRecentlyOpened'
        );

        if (!recentlyOpened || !recentlyOpened.workspaces) {
            return [];
        }

        const projects: RecentProject[] = [];

        for (const item of recentlyOpened.workspaces) {
            if (projects.length >= maxProjects) {
                break;
            }

            let folderPath: string | undefined;

            if (item.folderUri) {
                folderPath = item.folderUri.fsPath;
            } else if (item.workspace?.configPath) {
                // For multi-root workspaces, use the workspace config path's directory
                folderPath = path.dirname(item.workspace.configPath.fsPath);
            }

            if (folderPath) {
                projects.push({
                    name: path.basename(folderPath),
                    path: folderPath
                });
            }
        }

        return projects;
    } catch (error) {
        console.error('Failed to get recent projects:', error);
        return [];
    }
}
