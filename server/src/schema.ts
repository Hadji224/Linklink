/** Schéma PostgreSQL (migration 1). Les migrations suivantes s'ajoutent à la liste dans db.ts. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','guest')),
  token_version INTEGER NOT NULL DEFAULT 0,
  email_notif   INTEGER NOT NULL DEFAULT 1,
  consented_at  TEXT,
  suspended_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#135FEA',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  lead_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  done_at     TEXT,
  archive_motive TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','project','dm')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  admin_only  INTEGER NOT NULL DEFAULT 0,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  dm_a        TEXT REFERENCES users(id) ON DELETE CASCADE,
  dm_b        TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_name ON channels(name) WHERE kind = 'channel';
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm ON channels(dm_a, dm_b) WHERE kind = 'dm';
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id) WHERE kind = 'project';

CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  system     TEXT CHECK (system IN ('general','messages','project')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  channel_id  TEXT REFERENCES channels(id) ON DELETE CASCADE,
  task_id     TEXT,
  level       TEXT NOT NULL DEFAULT 'internal' CHECK (level IN ('public','internal','confidential','strict')),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  file_id    TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done')),
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent','high','medium','low')),
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT,
  archived_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, due_date);

CREATE TABLE IF NOT EXISTS subtasks (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  starts_at   TEXT NOT NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_starts ON meetings(starts_at);

CREATE TABLE IF NOT EXISTS rsvps (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('yes','maybe','no')),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  category   TEXT NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id, created_at);

CREATE TABLE IF NOT EXISTS task_history (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT NOT NULL DEFAULT '',
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);


CREATE TABLE IF NOT EXISTS user_functions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fn          TEXT NOT NULL CHECK (fn IN ('pdg','coordinator','project_lead','infra_lead','treasurer','comms')),
  assigned_by TEXT,
  note        TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_active ON user_functions(user_id, fn) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_functions_fn ON user_functions(fn) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS mandates (
  id              TEXT PRIMARY KEY,
  grantor_id      TEXT,
  grantee_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('technical_ops','spokesperson','validator_replacement','interim')),
  fn              TEXT,
  validation_type TEXT,
  for_user_id     TEXT,
  reason          TEXT NOT NULL DEFAULT '',
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_grantee ON mandates(grantee_id);

CREATE TABLE IF NOT EXISTS absences (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on   TEXT NOT NULL,
  ends_on     TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  declared_by TEXT,
  ended_at    TEXT,
  warned_at   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL CHECK (category IN ('business','security','emergency')),
  user_id    TEXT,
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  mandate_id TEXT,
  result     TEXT NOT NULL DEFAULT 'ok' CHECK (result IN ('ok','denied')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_cat ON audit_log(category, created_at);

CREATE TABLE IF NOT EXISTS validation_rules (
  type             TEXT PRIMARY KEY,
  first_reminder_h INTEGER NOT NULL,
  interval_h       INTEGER NOT NULL,
  escalation_h     INTEGER NOT NULL,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_proposals (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('add_member','remove_member','set_lead')),
  target_user_id TEXT NOT NULL,
  proposed_by    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','refused')),
  decided_by     TEXT,
  motive         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE TABLE IF NOT EXISTS project_done_notes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('postponed','cancelled')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS expenses (
  id                   TEXT PRIMARY KEY,
  requester_id         TEXT,
  requester_name       TEXT NOT NULL DEFAULT '',
  beneficiary          TEXT NOT NULL,
  beneficiary_user_id  TEXT,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  currency             TEXT NOT NULL DEFAULT 'GNF',
  reason               TEXT NOT NULL,
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','blocked','refused','awaiting_payment','paid','discrepancy','closed','cancelled')),
  version              INTEGER NOT NULL DEFAULT 1,
  approvals_required   INTEGER NOT NULL DEFAULT 1,
  approved_minor       INTEGER,
  approved_currency    TEXT,
  approved_beneficiary TEXT,
  justificatif         TEXT NOT NULL DEFAULT '',
  declarative_by       TEXT,
  cosigned_by          TEXT,
  decision_motive      TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  submitted_at         TEXT,
  closed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE TABLE IF NOT EXISTS expense_versions (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (expense_id, version)
);
CREATE TABLE IF NOT EXISTS expense_approvals (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id          TEXT PRIMARY KEY,
  expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  approver_id TEXT,
  approver_name TEXT NOT NULL DEFAULT '',
  decision    TEXT NOT NULL CHECK (decision IN ('approve','refuse')),
  motive      TEXT NOT NULL DEFAULT '',
  mandate_id  TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expense_payments (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id           TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  cashier_id   TEXT,
  cashier_name TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency     TEXT NOT NULL,
  beneficiary  TEXT NOT NULL,
  proof        TEXT NOT NULL,
  discrepancy  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','cancelled')),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS communications (
  id            TEXT PRIMARY KEY,
  author_id     TEXT,
  author_name   TEXT NOT NULL DEFAULT '',
  family        TEXT NOT NULL CHECK (family IN ('internal','official')),
  kind          TEXT NOT NULL CHECK (kind IN ('announcement','service','current','project','official','technical','paid_ad','crisis')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_validation','validated','published','refused','withdrawn')),
  version       INTEGER NOT NULL DEFAULT 1,
  crisis        INTEGER NOT NULL DEFAULT 0,
  review_due_at TEXT,
  reviewed_at   TEXT,
  review_note   TEXT NOT NULL DEFAULT '',
  decision_motive TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  published_by  TEXT,
  submitted_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communication_versions (
  comm_id    TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comm_id, version)
);
CREATE TABLE IF NOT EXISTS communication_validations (
  rowid      BIGINT GENERATED ALWAYS AS IDENTITY,
  id          TEXT PRIMARY KEY,
  comm_id     TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  slot        TEXT NOT NULL,
  validator_id TEXT,
  validator_name TEXT NOT NULL DEFAULT '',
  decision    TEXT NOT NULL CHECK (decision IN ('approve','refuse')),
  motive      TEXT NOT NULL DEFAULT '',
  mandate_id  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emergency_holders (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash     TEXT,
  designated_by TEXT,
  designated_at TEXT NOT NULL,
  code_set_at   TEXT
);
CREATE TABLE IF NOT EXISTS emergency_sessions (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('pending','active','closed','expired')),
  first_holder  TEXT NOT NULL,
  second_holder TEXT,
  created_at    TEXT NOT NULL,
  activated_at  TEXT,
  expires_at    TEXT NOT NULL,
  closed_at     TEXT,
  note          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admin_transfers (
  id            TEXT PRIMARY KEY,
  from_user     TEXT NOT NULL,
  to_user       TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','verifying','done','refused')),
  decided_by    TEXT,
  motive        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_actions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  user_name    TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL CHECK (action IN ('suspend','reactivate')),
  reason       TEXT NOT NULL DEFAULT '',
  requested_by TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','refused')),
  decided_by   TEXT,
  motive       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);

-- Règles du cahier : l'historique, les commentaires et les journaux ne sont jamais modifiés.
CREATE OR REPLACE FUNCTION ll_refuse() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'P0001'; END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER task_history_immutable BEFORE UPDATE OF task_id, field, old_value, new_value, created_at ON task_history
  FOR EACH ROW EXECUTE FUNCTION ll_refuse('Historique immuable');
CREATE OR REPLACE TRIGGER task_comments_immutable BEFORE UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION ll_refuse('Un commentaire ne peut pas être modifié');
CREATE OR REPLACE TRIGGER audit_immutable BEFORE UPDATE OF category, action, entity, entity_id, summary, details, mandate_id, result, created_at ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ll_refuse('Journal immuable');
CREATE OR REPLACE TRIGGER audit_nodelete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ll_refuse('Journal immuable');
`;
