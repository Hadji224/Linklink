import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(import.meta.dirname, '../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
for (const d of [UPLOAD_DIR, BACKUP_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'linklink.db');
export const db = new DatabaseSync(DB_FILE);

export type Role = 'admin' | 'member' | 'guest';
export type Level = 'public' | 'internal' | 'confidential' | 'strict';

export const uid = (): string => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','guest')),
  token_version INTEGER NOT NULL DEFAULT 0,
  email_notif   INTEGER NOT NULL DEFAULT 1,
  consented_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#135FEA',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE channels (
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
CREATE UNIQUE INDEX idx_channels_name ON channels(name) WHERE kind = 'channel';
CREATE UNIQUE INDEX idx_channels_dm ON channels(dm_a, dm_b) WHERE kind = 'dm';
CREATE UNIQUE INDEX idx_channels_project ON channels(project_id) WHERE kind = 'project';

CREATE TABLE channel_reads (
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  system     TEXT CHECK (system IN ('general','messages','project')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE files (
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
CREATE INDEX idx_files_user ON files(user_id);
CREATE INDEX idx_files_folder ON files(folder_id);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  file_id    TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE tasks (
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
  completed_at TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, due_date);

CREATE TABLE subtasks (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE meetings (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  starts_at   TEXT NOT NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_meetings_starts ON meetings(starts_at);

CREATE TABLE rsvps (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('yes','maybe','no')),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE activity_log (
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
CREATE INDEX idx_activity_created ON activity_log(created_at);
CREATE INDEX idx_activity_project ON activity_log(project_id, created_at);
`;

type Row = Record<string, any>;
const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
const tableExists = (n: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = OFF;');

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (version < 2) {
  const legacy = tableExists('users');
  let old: Record<string, Row[]> | null = null;
  if (legacy) {
    // Copie de sécurité de la base v1 avant migration.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `linklink-v1-avant-migration-${Date.now()}.db`));
    old = {
      users: all('SELECT * FROM users'),
      channels: all('SELECT * FROM channels'),
      files: all('SELECT * FROM files'),
      messages: all('SELECT * FROM messages'),
      meetings: all('SELECT * FROM meetings'),
      rsvps: all('SELECT * FROM rsvps'),
    };
  }
  db.exec('BEGIN');
  try {
    for (const t of ['rsvps', 'meetings', 'messages', 'files', 'channels', 'users']) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    db.exec(SCHEMA_V2);
    if (old) importV1(old);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
// v3 — amendement v1.1 (droits d'écriture sur les tâches) : archivage, historique immuable, index.
if (version < 3) {
  db.exec('BEGIN');
  try {
    const cols = all('PRAGMA table_info(tasks)').map((c) => c['name']);
    if (!cols.includes('archived_at')) db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');
    db.exec(`
CREATE TABLE IF NOT EXISTS task_history (
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
-- Règles du cahier : l'historique et les commentaires ne sont jamais modifiés (seulement ajoutés ou supprimés).
CREATE TRIGGER IF NOT EXISTS task_history_immutable BEFORE UPDATE OF task_id, field, old_value, new_value, created_at ON task_history
BEGIN SELECT RAISE(ABORT, 'Historique immuable'); END;
CREATE TRIGGER IF NOT EXISTS task_comments_immutable BEFORE UPDATE ON task_comments
BEGIN SELECT RAISE(ABORT, 'Un commentaire ne peut pas être modifié'); END;
`);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
db.exec('PRAGMA foreign_keys = ON;');

function importV1(old: Record<string, Row[]>) {
  const t = now();
  const general = uid();
  const messagesFolder = uid();
  db.prepare('INSERT INTO folders (id,name,system,created_at) VALUES (?,?,?,?)').run(general, 'Général', 'general', t);
  db.prepare('INSERT INTO folders (id,name,system,created_at) VALUES (?,?,?,?)').run(messagesFolder, 'Messages', 'messages', t);
  for (const u of (old['users'] ?? [])) {
    db.prepare(
      'INSERT INTO users (id,name,email,password_hash,role,consented_at,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(u.id, u.name, u.email, u.password_hash, u.role, u.created_at, u.created_at);
  }
  for (const c of (old['channels'] ?? [])) {
    db.prepare('INSERT INTO channels (id,kind,name,description,admin_only,created_at) VALUES (?,?,?,?,?,?)').run(
      c.id, 'channel', c.name, c.description, c.admin_only, c.created_at,
    );
  }
  const chatFile = new Map<string, string>();
  for (const m of (old['messages'] ?? [])) if (m.file_id) chatFile.set(m.file_id, m.channel_id);
  const folderIds = new Map<string, string>([['Général', general]]);
  for (const f of (old['files'] ?? [])) {
    const channelId = chatFile.get(f.id) ?? null;
    let folderId = messagesFolder;
    if (!channelId) {
      const name = String(f.folder || 'Général');
      if (!folderIds.has(name)) {
        const id = uid();
        db.prepare('INSERT INTO folders (id,name,created_at) VALUES (?,?,?)').run(id, name, t);
        folderIds.set(name, id);
      }
      folderId = folderIds.get(name) as string;
    }
    db.prepare(
      'INSERT INTO files (id,name,stored_name,mime,size,folder_id,channel_id,level,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(f.id, f.name, f.stored_name, f.mime, f.size, folderId, channelId, 'internal', f.user_id, f.created_at);
  }
  for (const m of (old['messages'] ?? [])) {
    db.prepare('INSERT INTO messages (id,channel_id,user_id,body,file_id,created_at) VALUES (?,?,?,?,?,?)').run(
      m.id, m.channel_id, m.user_id, m.body, m.file_id, m.created_at,
    );
  }
  for (const m of (old['meetings'] ?? [])) {
    db.prepare(
      'INSERT INTO meetings (id,title,description,location,starts_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(m.id, m.title, m.description, m.location, m.starts_at, m.created_by, m.created_at);
  }
  for (const r of (old['rsvps'] ?? [])) {
    db.prepare('INSERT INTO rsvps (meeting_id,user_id,status) VALUES (?,?,?)').run(r.meeting_id, r.user_id, r.status);
  }
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function newInviteCode() {
  // Format XXXX-XXXX, alphabet sans caractères ambigus.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

// Valeurs initiales : secret JWT (JWT_SECRET prioritaire), codes d'invitation, salons et dossiers par défaut.
if (!getSetting('jwt_secret')) setSetting('jwt_secret', crypto.randomBytes(48).toString('hex'));
if (!getSetting('invite_code')) setSetting('invite_code', newInviteCode());
if (!getSetting('guest_invite_code')) setSetting('guest_invite_code', newInviteCode());
export const jwtSecret = () => process.env.JWT_SECRET || (getSetting('jwt_secret') as string);

if ((db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind='channel'").get() as { n: number }).n === 0) {
  const ins = db.prepare('INSERT INTO channels (id,kind,name,description,admin_only,created_at) VALUES (?,?,?,?,?,?)');
  ins.run(uid(), 'channel', 'général', "Discussions de toute l'équipe", 0, now());
  ins.run(uid(), 'channel', 'annonces', 'Annonces officielles (publiées par le Super Admin)', 1, now());
}
for (const [name, system] of [['Général', 'general'], ['Messages', 'messages']] as const) {
  if (!db.prepare('SELECT 1 FROM folders WHERE system = ?').get(system)) {
    db.prepare('INSERT INTO folders (id,name,system,created_at) VALUES (?,?,?,?)').run(uid(), name, system, now());
  }
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  token_version: number;
  email_notif: number;
  consented_at: string | null;
  created_at: string;
}
