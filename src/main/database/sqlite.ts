/**
 * SQLite-backed implementation of the `DbService` contract (better-sqlite3).
 *
 * Design notes:
 *  - better-sqlite3 is synchronous; every method here is sync by contract.
 *    The main process calls these on short-lived, small result sets only.
 *  - `init()` may be called more than once (e.g. after a db-path settings
 *    change): the previous handle is closed and the database reopened.
 *  - Editor projects are stored as one JSON blob (`data_json`) — the schema
 *    stays stable while the `EditorProject` shape evolves.
 *  - WAL journaling keeps the UI responsive while recordings stream to disk.
 *
 * NOTE: the instructed `import Database from 'better-sqlite3'` requires
 * esModuleInterop (which the rest of the main process already relies on —
 * e.g. `import path from 'node:path'` in ffmpeg/locate.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import type { DbService } from './index'
import type {
  EditorProject,
  RecordingMeta,
  Rect,
} from '../../shared/types'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  display_id INTEGER NOT NULL DEFAULT 0,
  region_json TEXT,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  fps INTEGER NOT NULL DEFAULT 30,
  video_path TEXT NOT NULL,
  mic_audio_path TEXT,
  system_audio_path TEXT,
  cursor_events_path TEXT,
  annotations_path TEXT,
  thumbnail_path TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  capture_backend TEXT NOT NULL,
  cursor_backend TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_recording ON projects(recording_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

// ---------------------------------------------------------------------------
// Row shapes (snake_case mirror of the tables)
// ---------------------------------------------------------------------------

interface RecordingRow {
  id: string
  title: string
  created_at: string
  duration_ms: number | null
  mode: string | null
  display_id: number | null
  region_json: string | null
  width: number | null
  height: number | null
  fps: number | null
  video_path: string
  mic_audio_path: string | null
  system_audio_path: string | null
  cursor_events_path: string | null
  annotations_path: string | null
  thumbnail_path: string | null
  size_bytes: number | null
  capture_backend: string | null
  cursor_backend: string | null
}

interface ProjectRow {
  id: string
  recording_id: string
  title: string
  created_at: string
  updated_at: string
  data_json: string
}

interface SettingsRow {
  key: string
  value: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}

function isEditorProject(value: unknown): value is EditorProject {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<EditorProject>
  return typeof v.id === 'string' && typeof v.recordingId === 'string' && Array.isArray(v.segments)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SqliteDb implements DbService {
  private sqlite: Database.Database | null = null

  /** Guarded accessor — throws a helpful error when used before init(). */
  private get sql(): Database.Database {
    if (!this.sqlite || !this.sqlite.open) {
      throw new Error('Database not initialized: call db.init(dbPath) first')
    }
    return this.sqlite
  }

  // -- lifecycle -----------------------------------------------------------

  init(dbPath: string): void {
    // Re-init = reopen (close the previous handle first).
    if (this.sqlite) {
      if (this.sqlite.open) {
        try {
          this.sqlite.close()
        } catch {
          /* already closed — ignore */
        }
      }
      this.sqlite = null
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const database = new Database(dbPath, { fileMustExist: false })
    database.pragma('journal_mode = WAL')
    database.exec(SCHEMA_SQL)
    this.sqlite = database
  }

  close(): void {
    if (this.sqlite && this.sqlite.open) {
      try {
        this.sqlite.close()
      } catch {
        /* ignore double-close */
      }
    }
    this.sqlite = null
  }

  // -- recordings library ----------------------------------------------------

  listRecordings(): RecordingMeta[] {
    const rows = this.sql
      .prepare('SELECT * FROM recordings ORDER BY created_at DESC')
      .all() as unknown as RecordingRow[]
    return rows.map((r) => SqliteDb.rowToRecording(r))
  }

  getRecording(id: string): RecordingMeta | null {
    const row = this.sql.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as
      | RecordingRow
      | undefined
    return row ? SqliteDb.rowToRecording(row) : null
  }

  upsertRecording(meta: RecordingMeta): void {
    this.sql
      .prepare(
        `INSERT OR REPLACE INTO recordings (
          id, title, created_at, duration_ms, mode, display_id, region_json,
          width, height, fps, video_path, mic_audio_path, system_audio_path,
          cursor_events_path, annotations_path, thumbnail_path, size_bytes,
          capture_backend, cursor_backend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.id,
        meta.title,
        meta.createdAt,
        Math.max(0, Math.round(meta.durationMs)),
        meta.mode,
        meta.displayId,
        meta.region ? JSON.stringify(meta.region) : null,
        meta.width,
        meta.height,
        meta.fps,
        meta.videoPath,
        meta.micAudioPath ?? null,
        meta.systemAudioPath ?? null,
        meta.cursorEventsPath ?? null,
        meta.annotationsPath ?? null,
        meta.thumbnailPath ?? null,
        meta.sizeBytes,
        meta.captureBackend,
        meta.cursorBackend,
      )
  }

  renameRecording(id: string, title: string): void {
    this.sql.prepare('UPDATE recordings SET title = ? WHERE id = ?').run(title, id)
  }

  deleteRecording(id: string): void {
    // Removes the DB row only — media files are managed by the library service.
    this.sql.prepare('DELETE FROM recordings WHERE id = ?').run(id)
  }

  // -- editor projects -------------------------------------------------------

  listProjects(recordingId?: string): EditorProject[] {
    const rows = (
      recordingId
        ? this.sql
            .prepare('SELECT * FROM projects WHERE recording_id = ? ORDER BY updated_at DESC')
            .all(recordingId)
        : this.sql.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
    ) as unknown as ProjectRow[]
    const out: EditorProject[] = []
    for (const row of rows) {
      const project = safeParse<EditorProject>(row.data_json)
      if (isEditorProject(project)) out.push(project)
    }
    return out
  }

  getProject(id: string): EditorProject | null {
    const row = this.sql.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    if (!row) return null
    const project = safeParse<EditorProject>(row.data_json)
    return isEditorProject(project) ? project : null
  }

  upsertProject(project: EditorProject): EditorProject {
    const dataJson = JSON.stringify(project)
    this.sql
      .prepare(
        `INSERT OR REPLACE INTO projects (id, recording_id, title, created_at, updated_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.recordingId, project.title, project.createdAt, project.updatedAt, dataJson)
    // Return the project exactly as stored (parsed round-trip).
    const stored = safeParse<EditorProject>(dataJson)
    return isEditorProject(stored) ? stored : project
  }

  deleteProject(id: string): void {
    this.sql.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  // -- settings --------------------------------------------------------------

  getSettingsRaw(): Record<string, string> {
    const rows = this.sql.prepare('SELECT key, value FROM settings').all() as unknown as SettingsRow[]
    const out: Record<string, string> = {}
    for (const row of rows) {
      if (row.value !== null && row.value !== undefined) out[row.key] = row.value
    }
    return out
  }

  setSettingRaw(key: string, value: string): void {
    this.sql.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  // -- row mapping -----------------------------------------------------------

  private static rowToRecording(r: RecordingRow): RecordingMeta {
    const region = safeParse<Rect>(r.region_json)
    return {
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      durationMs: r.duration_ms ?? 0,
      mode: (r.mode ?? 'fullscreen') as RecordingMeta['mode'],
      displayId: r.display_id ?? 0,
      region,
      width: r.width ?? 0,
      height: r.height ?? 0,
      fps: r.fps ?? 30,
      videoPath: r.video_path,
      micAudioPath: r.mic_audio_path ?? undefined,
      systemAudioPath: r.system_audio_path ?? undefined,
      cursorEventsPath: r.cursor_events_path ?? undefined,
      annotationsPath: r.annotations_path ?? undefined,
      thumbnailPath: r.thumbnail_path ?? undefined,
      sizeBytes: r.size_bytes ?? 0,
      captureBackend: (r.capture_backend ?? 'desktop-capturer') as RecordingMeta['captureBackend'],
      cursorBackend: (r.cursor_backend ?? 'polling') as RecordingMeta['cursorBackend'],
    }
  }
}

/** Concrete singleton required lazily by `database/index.ts`. */
export const db: DbService = new SqliteDb()
