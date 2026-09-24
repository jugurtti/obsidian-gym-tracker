// ── Template types ──

export interface TemplateSet {
    setNumber: number;
    reps: number;           // "rep template" — baseline reps
    weight: number;         // "kg template" — baseline weight
    restSeconds: number;    // "rest" — baseline rest time
}

export interface TemplateExercise {
    id: string;
    name: string;           // "Barbell Squat"
    note: string;           // optional per-exercise note
    sets: TemplateSet[];
    // Dataset integration (optional)
    datasetId?: string;        // references ExerciseInfo.id from exercises dataset
    category?: string;         // e.g. "chest", "back"
    equipment?: string;        // e.g. "barbell", "body weight"
    target?: string;           // primary target muscle
    muscleGroup?: string;      // primary muscle group
    secondaryMuscles?: string[]; // additional muscles worked
}

export interface WorkoutTemplate {
    id: string;
    name: string;           // "Leg Day", "Push Day", etc.
    exercises: TemplateExercise[];
}

// ── Session types ──

export interface SessionSet {
    setNumber: number;
    reps: number;           // "rep today"
    weight: number;         // "kg today"
}

export interface SessionExercise {
    templateExerciseId: string;
    name: string;
    note: string;
    sets: SessionSet[];
}

export interface WorkoutSession {
    id: string;
    date: string;           // "YYYY-MM-DD"
    templateId: string;
    templateName: string;   // denormalized for display
    note: string;
    exercises: SessionExercise[];
    completedAt: string;    // ISO timestamp
}

// ── Workout table columns ──

/** Identifies a reorderable data column in the workout view's set table.
 *  "Set" is not included here — it is always rendered first and is not
 *  reorderable. */
export type WorkoutColumnId =
    | 'reps'
    | 'kg'
    | 'reps_last'
    | 'kg_last'
    | 'reps_tpl'
    | 'kg_tpl'
    | 'rest';

/** Default column order — matches the plugin's original, unconfigurable
 *  column layout exactly, so installing this feature does not change the
 *  workout table for any existing user. Users who prefer the editable
 *  ("today") columns first (to avoid horizontal scrolling on mobile) can
 *  rearrange this via Settings → Gym Workout Tracker → Workout Table
 *  Columns. */
export const DEFAULT_WORKOUT_COLUMN_ORDER: WorkoutColumnId[] = [
    'reps_tpl',
    'reps_last',
    'reps',
    'kg_tpl',
    'kg_last',
    'kg',
    'rest',
];

// ── Plugin settings ──

export interface GymSettings {
    weekStartDay: 'monday' | 'sunday';
    weightUnit: 'kg' | 'lbs';
    vaultFolder: string;        // e.g. ".gym-tracker" to hide, "gym-tracker" to show
    vaultFileName: string;      // e.g. "data" (no extension)
    showInGraph: boolean;       // true = .md frontmatter, false = .json
    columnOrder: WorkoutColumnId[]; // user-customizable workout table column order
}

// ── Plugin data root ──

export interface GymTrackerData {
    version: number;
    settings: GymSettings;
    templates: WorkoutTemplate[];
    sessions: Record<string, WorkoutSession>; // keyed by "YYYY-MM-DD"
}

// ── Calendar types ──

export interface CalendarDay {
    date: string;           // "YYYY-MM-DD"
    day: number;            // day of month (1-31)
    isCurrentMonth: boolean;
    isToday: boolean;
    hasSession: boolean;
    session?: WorkoutSession;
}

// ── Modal result type ──

export interface LastSetData {
    reps: number;
    weight: number;
}

export interface ExerciseFormData {
    templateExercise: TemplateExercise;
    lastSetData: Map<number, LastSetData>;  // keyed by setNumber
}