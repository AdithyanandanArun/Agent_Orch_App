import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, is_example INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    effort TEXT NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL, isolated INTEGER NOT NULL, worktree_path TEXT NOT NULL, branch TEXT,
    provider_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, archived_at TEXT
  );
  CREATE INDEX sessions_project ON sessions(project_id);
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT NOT NULL, kind TEXT, created_at TEXT NOT NULL, consumed_at TEXT
  );
  CREATE INDEX messages_session ON messages(session_id, seq);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL, session_id TEXT REFERENCES sessions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id);
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, session_id TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX events_project ON events(project_id, id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), tool TEXT NOT NULL, description TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
  );
  CREATE INDEX approvals_session ON approvals(session_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DatabaseSync {
  const existed = file === ':memory:' || existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) throw new Error(`Database schema v${row.user_version} is newer than this server (v${MIGRATIONS.length}).`);
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (!existed && file !== ':memory:') {
    try { chmodSync(file, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  }
  return db;
}
