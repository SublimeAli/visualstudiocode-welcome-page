import * as vscode from 'vscode';
import { ProjectKind, ProjectSnapshot } from './recentProjects';

export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type TagColor = typeof TAG_COLORS[number];

export const MAX_NOTE_LENGTH = 40;
const MAX_ENTRIES = 300;
const META_KEY = 'projectMeta';

export interface ProjectMetaEntry {
    pinned?: boolean;
    note?: string;
    color?: TagColor;
    /** Only kept while pinned, so a pin survives VS Code dropping the project from its recent list. */
    snapshot?: ProjectSnapshot;
}

export function isTagColor(value: unknown): value is TagColor {
    return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

export function cleanNote(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    // Drop control characters and collapse whitespace; the note is shown verbatim (HTML-escaped).
    // eslint-disable-next-line no-control-regex
    const note = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
    return note || undefined;
}

function cleanSnapshot(value: unknown): ProjectSnapshot | undefined {
    const v = value as Partial<ProjectSnapshot> | undefined;
    if (!v || typeof v.name !== 'string' || typeof v.displayPath !== 'string') {
        return undefined;
    }
    const kind: ProjectKind = v.kind === 'workspace' ? 'workspace' : 'folder';
    return { name: v.name, displayPath: v.displayPath, kind, remote: v.remote === true };
}

/** Pins, notes and colour tags, kept in the extension's own storage on this machine. */
export class ProjectMeta {
    constructor(private readonly state: vscode.Memento) {}

    /** Reads defensively: whatever is in storage, only well-formed entries come out. */
    all(): Record<string, ProjectMetaEntry> {
        const raw = this.state.get<unknown>(META_KEY);
        const result: Record<string, ProjectMetaEntry> = {};
        if (!raw || typeof raw !== 'object') {
            return result;
        }
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
            const v = value as Partial<ProjectMetaEntry> | undefined;
            if (!v || typeof v !== 'object') {
                continue;
            }
            const entry: ProjectMetaEntry = {};
            if (v.pinned === true) {
                entry.pinned = true;
                const snapshot = cleanSnapshot(v.snapshot);
                if (snapshot) {
                    entry.snapshot = snapshot;
                }
            }
            const note = cleanNote(v.note);
            if (note) {
                entry.note = note;
            }
            if (isTagColor(v.color)) {
                entry.color = v.color;
            }
            if (entry.pinned || entry.note || entry.color) {
                result[id] = entry;
            }
        }
        return result;
    }

    async setPinned(id: string, pinned: boolean, snapshot: ProjectSnapshot | undefined): Promise<void> {
        const all = this.all();
        const entry = all[id] ?? {};
        if (pinned) {
            entry.pinned = true;
            if (snapshot) {
                entry.snapshot = snapshot;
            }
        } else {
            delete entry.pinned;
            delete entry.snapshot;
        }
        await this.write(all, id, entry);
    }

    async setTag(id: string, note: string | undefined, color: TagColor | undefined): Promise<void> {
        const all = this.all();
        const entry = all[id] ?? {};
        if (note) { entry.note = note; } else { delete entry.note; }
        if (color) { entry.color = color; } else { delete entry.color; }
        await this.write(all, id, entry);
    }

    private async write(all: Record<string, ProjectMetaEntry>, id: string, entry: ProjectMetaEntry): Promise<void> {
        if (entry.pinned || entry.note || entry.color) {
            all[id] = entry;
        } else {
            delete all[id];
        }
        // Keep storage bounded: if it ever grows past the cap, drop the oldest unpinned entries.
        const ids = Object.keys(all);
        if (ids.length > MAX_ENTRIES) {
            for (const key of ids) {
                if (Object.keys(all).length <= MAX_ENTRIES) { break; }
                if (key !== id && !all[key].pinned) { delete all[key]; }
            }
        }
        await this.state.update(META_KEY, all);
    }
}
