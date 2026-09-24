import { GymTrackerData, GymSettings, WorkoutTemplate, WorkoutSession, LastSetData } from "../types";
import { Plugin, normalizePath, Notice } from "obsidian";

const DEFAULT_SETTINGS: GymSettings = {
    weekStartDay: 'monday',
    weightUnit: 'kg',
    vaultFolder: '.gym-tracker',
    vaultFileName: 'data',
    showInGraph: false,
};

const KG_TO_LBS = 2.20462;

const DEFAULT_DATA: GymTrackerData = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    templates: [],
    sessions: {},
};

/**
 * Data access layer supporting two storage backends:
 * - 'plugin': Obsidian's loadData/saveData (.obsidian/plugins/.../data.json)
 * - 'vault': Regular vault file (synced via Obsidian Sync / iCloud / Syncthing)
 *
 * Templates and sessions are persisted to two separate files so that editing
 * one does not need to rewrite the other. This keeps concurrent edits from
 * different synchronized devices (e.g. logging a workout on mobile while
 * editing templates on desktop) from unnecessarily touching the same file.
 */
export class DataStore {
    private plugin: Plugin;
    private data: GymTrackerData;

    // Tracks the exact file contents we last wrote/read for each storage
    // file. Used to detect externally modified files (e.g. synchronized via
    // Syncthing) without reacting to our own writes.
    private lastTemplatesContent: string | null = null;
    private lastSessionsContent: string | null = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.data = { ...DEFAULT_DATA };
    }

    async load(): Promise<void> {
        let raw: Partial<GymTrackerData> | undefined;
        let templatesFromSeparateFile: WorkoutTemplate[] | undefined;

        const bootSettings: GymSettings = { ...DEFAULT_SETTINGS };

        const path = this.getVaultPath(bootSettings);
        if (await this.plugin.app.vault.adapter.exists(path)) {
            const text = await this.plugin.app.vault.adapter.read(path);
            this.lastSessionsContent = text;
            raw = this.parseFile(text, path) ?? undefined;
            if (raw && raw.settings) {
                Object.assign(bootSettings, this.buildSettings(raw.settings));
            }
        }

        const templatesPath = this.getTemplatesVaultPath(bootSettings);
        if (await this.plugin.app.vault.adapter.exists(templatesPath)) {
            const text = await this.plugin.app.vault.adapter.read(templatesPath);
            this.lastTemplatesContent = text;
            const tRaw = this.parseFile(text, templatesPath);
            if (tRaw && tRaw.templates) {
                templatesFromSeparateFile = tRaw.templates;
            }
        }

        if (raw) {
            this.data = {
                ...DEFAULT_DATA,
                ...raw,
                settings: this.buildSettings(raw.settings),
                sessions: { ...(raw.sessions || {}) },
            };
        }

        // If templates were loaded from a separate file, override the ones from data.json
        if (templatesFromSeparateFile) {
            this.data.templates = templatesFromSeparateFile;
        }
    }

    // Build settings with backward compat for old fields
    private buildSettings(saved: Partial<GymSettings> | undefined): GymSettings {
        const s: GymSettings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
        // Migrate old vaultDataPath field (backward compat)
        const legacyVaultPath = saved && 'vaultDataPath' in saved
            ? (saved as Record<string, unknown>).vaultDataPath
            : undefined;
        if (typeof legacyVaultPath === 'string' && !saved?.vaultFolder) {
            const parts = legacyVaultPath.split('/');
            const fileName = parts.pop() || 'data';
            const folder = parts.join('/') || '.gym-tracker';
            s.vaultFolder = folder;
            s.vaultFileName = fileName.replace(/\.(json|md)$/, '');
            s.showInGraph = legacyVaultPath.endsWith('.md');
        }
        return s;
    }

    /** Persist both templates and sessions. Used when both may have changed
     * (e.g. settings changes that convert weight units, or clearing all data). */
    async save(): Promise<void> {
        await this.writeTemplatesFile();
        await this.writeSessionsFile();
    }

    // ── Storage backend ──

    getVaultPath(settings?: GymSettings): string {
        const s = settings || this.data.settings;
        const ext = s.showInGraph ? 'md' : 'json';
        return normalizePath(`${s.vaultFolder}/${s.vaultFileName}.${ext}`);
    }

    getTemplatesVaultPath(settings?: GymSettings): string {
        const s = settings || this.data.settings;
        const ext = s.showInGraph ? 'md' : 'json';
        return normalizePath(`${s.vaultFolder}/templates.${ext}`);
    }

    private parseFile(text: string, path: string): Partial<GymTrackerData> | null {
        if (path.endsWith('.md')) {
            // Extract JSON from YAML frontmatter
            const match = text.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
                const lines = match[1].split('\n');
                for (const line of lines) {
                    const m = line.match(/^gym_data:\s*(.+)$/);
                    if (m) return JSON.parse(m[1]) as Partial<GymTrackerData>;
                }
            }
            return null;
        }
        return JSON.parse(text) as Partial<GymTrackerData>;
    }

    private buildFile(data: GymTrackerData): string {
        const json = JSON.stringify(data, null, 2);
        if (data.settings.showInGraph) {
            return `---\ngym_data: ${JSON.stringify(json)}\n---\n`;
        }
        return json;
    }

    private async ensureFolder(path: string): Promise<void> {
        const vault = this.plugin.app.vault;
        const dir = path.split('/').slice(0, -1).join('/');

        if (!dir) {
            return;
        }

        const parts = dir.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!(await vault.adapter.exists(current))) {
                await vault.adapter.mkdir(current);
            }
        }
    }

    /** Write only the templates file. Does not touch the sessions file. */
    private async writeTemplatesFile(): Promise<void> {
        try {
            const vault = this.plugin.app.vault;
            const templatesPath = this.getTemplatesVaultPath();
            await this.ensureFolder(templatesPath);

            const templatesData: GymTrackerData = { ...this.data, sessions: {} };
            const content = this.buildFile(templatesData);

            await vault.adapter.write(templatesPath, content);
            this.lastTemplatesContent = content;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Gym Tracker: vault write failed (templates):', err);
            new Notice(`Gym Workout Tracker: Failed to save templates. ${message}`, 8000);
        }
    }

    /** Write only the sessions/data file. Does not touch the templates file. */
    private async writeSessionsFile(): Promise<void> {
        try {
            const vault = this.plugin.app.vault;
            const path = this.getVaultPath();
            await this.ensureFolder(path);

            const mainData: GymTrackerData = { ...this.data, templates: [] };
            const content = this.buildFile(mainData);

            await vault.adapter.write(path, content);
            this.lastSessionsContent = content;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Gym Tracker: vault write failed (sessions):', err);
            new Notice(`Gym Workout Tracker: Failed to save data. ${message}`, 8000);
        }
    }

    getData(): GymTrackerData {
        return this.data;
    }

    // ── External change detection ──

    /**
     * Checks the templates and sessions files on disk for changes that were
     * not made by this DataStore instance (e.g. synchronized in from another
     * device via Syncthing/Obsidian Sync). Updates in-memory state for
     * whichever file(s) changed and reports which ones changed so the caller
     * can refresh the relevant views.
     */
    async checkForExternalChanges(): Promise<{ templatesChanged: boolean; sessionsChanged: boolean }> {
        const vault = this.plugin.app.vault;
        let templatesChanged = false;
        let sessionsChanged = false;

        const templatesPath = this.getTemplatesVaultPath();
        if (await vault.adapter.exists(templatesPath)) {
            const text = await vault.adapter.read(templatesPath);
            if (text !== this.lastTemplatesContent) {
                const parsed = this.parseFile(text, templatesPath);
                if (parsed && parsed.templates) {
                    this.data.templates = parsed.templates;
                    templatesChanged = true;
                }
                this.lastTemplatesContent = text;
            }
        }

        const mainPath = this.getVaultPath();
        if (await vault.adapter.exists(mainPath)) {
            const text = await vault.adapter.read(mainPath);
            if (text !== this.lastSessionsContent) {
                const parsed = this.parseFile(text, mainPath);
                if (parsed) {
                    if (parsed.sessions) {
                        this.data.sessions = { ...parsed.sessions };
                        sessionsChanged = true;
                    }
                    // Settings live in both files; pick up changes made
                    // elsewhere (e.g. unit changes) without clobbering
                    // templates/sessions already held in memory.
                    if (parsed.settings) {
                        this.data.settings = this.buildSettings(parsed.settings);
                    }
                }
                this.lastSessionsContent = text;
            }
        }

        return { templatesChanged, sessionsChanged };
    }

    // ── Template CRUD ──

    getTemplates(): WorkoutTemplate[] {
        return this.data.templates;
    }

    getTemplate(id: string): WorkoutTemplate | undefined {
        return this.data.templates.find(t => t.id === id);
    }

    async saveTemplate(template: WorkoutTemplate): Promise<void> {
        const idx = this.data.templates.findIndex(t => t.id === template.id);
        if (idx >= 0) {
            this.data.templates[idx] = template;
        } else {
            this.data.templates.push(template);
        }
        await this.writeTemplatesFile();
    }

    async deleteTemplate(id: string): Promise<void> {
        this.data.templates = this.data.templates.filter(t => t.id !== id);
        await this.writeTemplatesFile();
    }

    // ── Session CRUD ──

    getSession(date: string): WorkoutSession | undefined {
        return this.data.sessions[date];
    }

    getAllSessions(): WorkoutSession[] {
        return Object.values(this.data.sessions).sort(
            (a, b) => b.date.localeCompare(a.date)
        );
    }

    async saveSession(session: WorkoutSession): Promise<void> {
        this.data.sessions[session.date] = session;
        await this.writeSessionsFile();
    }

    async deleteSession(date: string): Promise<void> {
        delete this.data.sessions[date];
        await this.writeSessionsFile();
    }

    // ── "Last time" queries ──

    /**
     * For a given templateExerciseId and setNumber, find the most recent
     * session (before `beforeDate`) where this exercise+set was logged.
     * Returns { reps, weight } or null if never done before.
     */
    getLastSetData(
        templateExerciseId: string,
        setNumber: number,
        beforeDate?: string
    ): LastSetData | null {
        const sessions = Object.values(this.data.sessions)
            .filter(s => !beforeDate || s.date < beforeDate)
            .sort((a, b) => b.date.localeCompare(a.date));

        for (const session of sessions) {
            const ex = session.exercises.find(
                e => e.templateExerciseId === templateExerciseId
            );
            if (ex) {
                const set = ex.sets.find(s => s.setNumber === setNumber);
                if (set) {
                    return { reps: set.reps, weight: set.weight };
                }
            }
        }

        return null;
    }

    /**
     * Get a map of setNumber → LastSetData for all sets in a given exercise.
     */
    getLastSetDataForExercise(
        templateExerciseId: string,
        beforeDate?: string
    ): Map<number, LastSetData> {
        const result = new Map<number, LastSetData>();
        const sessions = Object.values(this.data.sessions)
            .filter(s => !beforeDate || s.date < beforeDate)
            .sort((a, b) => b.date.localeCompare(a.date));

        for (const session of sessions) {
            const ex = session.exercises.find(
                e => e.templateExerciseId === templateExerciseId
            );
            if (ex) {
                for (const set of ex.sets) {
                    if (!result.has(set.setNumber)) {
                        result.set(set.setNumber, {
                            reps: set.reps,
                            weight: set.weight,
                        });
                    }
                }
                // Once we found the most recent session with this exercise,
                // we have all sets from it. Stop looking further back.
                break;
            }
        }

        return result;
    }

    // ── Settings ──

    getSettings(): GymSettings {
        return this.data.settings;
    }

    async saveSettings(settings: GymSettings): Promise<void> {
        const oldUnit = this.data.settings.weightUnit;
        const newUnit = settings.weightUnit;

        if (oldUnit !== newUnit) {
            this.convertWeights(oldUnit, newUnit);
        }

        this.data.settings = settings;
        // Settings are embedded in both files, and a unit change updates
        // weights in both templates and sessions, so persist both.
        await this.save();
    }

    private convertWeights(from: 'kg' | 'lbs', to: 'kg' | 'lbs'): void {
        const factor = to === 'lbs' ? KG_TO_LBS : (1 / KG_TO_LBS);

        // Convert template exercise sets
        for (const tpl of this.data.templates) {
            for (const ex of tpl.exercises) {
                for (const set of ex.sets) {
                    set.weight = Math.round(set.weight * factor * 10) / 10;
                }
            }
        }

        // Convert session exercise sets
        for (const session of Object.values(this.data.sessions)) {
            for (const ex of session.exercises) {
                for (const set of ex.sets) {
                    set.weight = Math.round(set.weight * factor * 10) / 10;
                }
            }
        }
    }

    async clearAllData(): Promise<void> {
        this.data.templates = [];
        this.data.sessions = {};
        await this.save();
    }

    // ── Utility ──

    generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}
