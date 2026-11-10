/**
 * Database service contract.
 *
 * Implementation lives in `database/sqlite.ts` (better-sqlite3). The rest of
 * the main process depends only on this interface, so the storage engine can
 * be swapped or mocked without touching callers.
 */
import type { EditorProject, RecordingMeta } from '../../shared/types'

export interface DbService {
  init(dbPath: string): void
  close(): void

  // recordings library
  listRecordings(): RecordingMeta[]
  getRecording(id: string): RecordingMeta | null
  upsertRecording(meta: RecordingMeta): void
  deleteRecording(id: string): void
  renameRecording(id: string, title: string): void

  // editor projects
  listProjects(recordingId?: string): EditorProject[]
  getProject(id: string): EditorProject | null
  upsertProject(project: EditorProject): EditorProject
  deleteProject(id: string): void

  // settings (string map; typed access lives in settings/store.ts)
  getSettingsRaw(): Record<string, string>
  setSettingRaw(key: string, value: string): void
}

/**
 * Lazy proxy so module import order never matters (the DB file path is only
 * known after `app` is ready). The concrete implementation is required at
 * runtime from './sqlite'.
 */
function createLazyDb(): DbService {
  let impl: DbService | null = null
  const get = (): DbService => {
    if (!impl) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./sqlite') as { db: DbService }
      impl = mod.db
    }
    return impl
  }
  return {
    init: (p) => get().init(p),
    close: () => get().close(),
    listRecordings: () => get().listRecordings(),
    getRecording: (id) => get().getRecording(id),
    upsertRecording: (m) => get().upsertRecording(m),
    deleteRecording: (id) => get().deleteRecording(id),
    renameRecording: (id, t) => get().renameRecording(id, t),
    listProjects: (r) => get().listProjects(r),
    getProject: (id) => get().getProject(id),
    upsertProject: (p) => get().upsertProject(p),
    deleteProject: (id) => get().deleteProject(id),
    getSettingsRaw: () => get().getSettingsRaw(),
    setSettingRaw: (k, v) => get().setSettingRaw(k, v),
  }
}

export const db: DbService = createLazyDb()
