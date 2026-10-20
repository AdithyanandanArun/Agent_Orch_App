import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';

const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
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
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE messages ADD COLUMN run_id TEXT;
   CREATE TABLE session_runs (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_message_id TEXT NOT NULL REFERENCES messages(id),
     provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER
   );
   CREATE INDEX runs_session ON session_runs(session_id, started_at);
   CREATE TABLE tool_calls (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES session_runs(id), session_id TEXT NOT NULL REFERENCES sessions(id),
     provider_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
     UNIQUE(run_id, provider_id)
   );
   CREATE INDEX tools_run ON tool_calls(run_id);
  `,
  `ALTER TABLE sessions ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'standard';`,
  `ALTER TABLE session_runs ADD COLUMN changes_summary TEXT;
   ALTER TABLE session_runs ADD COLUMN changes_diff TEXT;
   ALTER TABLE session_runs ADD COLUMN changes_diff_truncated INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE task_sources (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
     source_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, source_key)
   );
   CREATE TABLE project_context (project_id TEXT PRIMARY KEY REFERENCES projects(id), data TEXT NOT NULL);`,
  // Group conversations: a shared coordination layer above independent provider sessions. Purely additive.
  `CREATE TABLE conversation_groups (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
     anchor_session_id TEXT NOT NULL REFERENCES sessions(id),
     mode TEXT NOT NULL CHECK (mode IN ('cowork', 'orchestrated', 'current-leads')),
     orchestrator_member_id TEXT, paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
     max_parallel INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_hops INTEGER NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX conversation_groups_project ON conversation_groups(project_id);
   CREATE TABLE group_members (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), session_id TEXT NOT NULL REFERENCES sessions(id),
     handle TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('peer', 'orchestrator', 'worker')),
     held INTEGER NOT NULL DEFAULT 0, last_read_seq INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, removed_at TEXT,
     UNIQUE(group_id, handle)
   );
   CREATE UNIQUE INDEX group_members_active_session ON group_members(session_id) WHERE removed_at IS NULL;
   CREATE INDEX group_members_group ON group_members(group_id);
   CREATE TABLE group_messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES conversation_groups(id),
     sender_member_id TEXT, recipient_member_ids TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'assignment', 'status', 'artifact')), content TEXT NOT NULL,
     request_id TEXT, reply_to_id TEXT, source_message_id TEXT, source_run_id TEXT, client_message_id TEXT, created_at TEXT NOT NULL,
     UNIQUE(group_id, client_message_id)
   );
   CREATE INDEX group_messages_group ON group_messages(group_id, seq);
   CREATE INDEX group_messages_request ON group_messages(request_id);
   CREATE TABLE group_requests (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), message_id TEXT NOT NULL REFERENCES group_messages(id),
     planner_member_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'paused')),
     turns_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX group_requests_group ON group_requests(group_id, created_at);
   CREATE TABLE group_deliveries (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id),
     request_id TEXT NOT NULL REFERENCES group_requests(id), message_id TEXT NOT NULL REFERENCES group_messages(id),
     member_id TEXT NOT NULL REFERENCES group_members(id), kind TEXT NOT NULL CHECK (kind IN ('request', 'assignment', 'message', 'result')),
     status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
     run_id TEXT, hop INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retryable INTEGER NOT NULL DEFAULT 0,
     error TEXT, assignment_id TEXT, started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX group_deliveries_state ON group_deliveries(group_id, status);
   CREATE INDEX group_deliveries_member ON group_deliveries(member_id, status);
   CREATE INDEX group_deliveries_request ON group_deliveries(request_id);
   CREATE UNIQUE INDEX group_deliveries_run ON group_deliveries(run_id) WHERE run_id IS NOT NULL;
   CREATE TABLE group_assignments (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
     from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
     task_id TEXT NOT NULL REFERENCES tasks(id), delivery_id TEXT NOT NULL, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
     notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
   );
   CREATE INDEX group_assignments_group ON group_assignments(group_id, request_id);
   CREATE INDEX group_assignments_task ON group_assignments(task_id);
   CREATE TABLE group_artifacts (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
     from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
     task_id TEXT REFERENCES tasks(id), path TEXT NOT NULL, commit_id TEXT NOT NULL, blob TEXT NOT NULL, reference TEXT NOT NULL,
     handoff_event_id INTEGER, handoff_message_id TEXT, message_id TEXT NOT NULL REFERENCES group_messages(id), created_at TEXT NOT NULL,
     UNIQUE(group_id, from_member_id, to_member_id, path, commit_id)
   );
   CREATE INDEX group_artifacts_target ON group_artifacts(group_id, to_member_id, task_id, path);
   CREATE TABLE group_assignment_inputs (
     assignment_id TEXT NOT NULL REFERENCES group_assignments(id), task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL,
     artifact_id TEXT REFERENCES group_artifacts(id), PRIMARY KEY (assignment_id, task_id, path)
   );`,
  // A source watcher may already have opened migration 7 while group implementation was being integrated.
  // Accept both early v7 shapes; preserve every artifact and consumer link while broadening its identity.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(group_deliveries)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'task_id')) db.exec('ALTER TABLE group_deliveries ADD COLUMN task_id TEXT REFERENCES tasks(id)');
    const links = db.prepare('SELECT assignment_id, task_id, path, artifact_id FROM group_assignment_inputs WHERE artifact_id IS NOT NULL').all() as { assignment_id: string; task_id: string; path: string; artifact_id: string }[];
    db.exec(`CREATE TABLE group_artifacts_v8 (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
      from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
      task_id TEXT REFERENCES tasks(id), path TEXT NOT NULL, commit_id TEXT NOT NULL, blob TEXT NOT NULL, reference TEXT NOT NULL,
      handoff_event_id INTEGER, handoff_message_id TEXT, message_id TEXT NOT NULL REFERENCES group_messages(id), created_at TEXT NOT NULL
    );
    INSERT INTO group_artifacts_v8 SELECT id, group_id, request_id, from_member_id, to_member_id, task_id, path, commit_id, blob, reference, handoff_event_id, handoff_message_id, message_id, created_at FROM group_artifacts;
    UPDATE group_assignment_inputs SET artifact_id = NULL;
    DROP TABLE group_artifacts;
    ALTER TABLE group_artifacts_v8 RENAME TO group_artifacts;
    CREATE UNIQUE INDEX group_artifacts_identity ON group_artifacts(group_id, from_member_id, to_member_id, path, commit_id, COALESCE(task_id, ''));
    CREATE INDEX group_artifacts_target ON group_artifacts(group_id, to_member_id, task_id, path);`);
    const restore = db.prepare('UPDATE group_assignment_inputs SET artifact_id = ? WHERE assignment_id = ? AND task_id = ? AND path = ?');
    for (const link of links) restore.run(link.artifact_id, link.assignment_id, link.task_id, link.path);
  },
  `ALTER TABLE projects ADD COLUMN archived_at TEXT;
   CREATE INDEX projects_visible ON projects(archived_at);`,
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
      const migration = MIGRATIONS[version]!;
      if (typeof migration === 'string') db.exec(migration);
      else migration(db);
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
