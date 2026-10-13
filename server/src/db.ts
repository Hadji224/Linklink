import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(import.meta.dirname, '../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'linklink.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  admin_only  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  folder      TEXT NOT NULL DEFAULT 'Général',
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL DEFAULT '',
  file_id    TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS meetings (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  starts_at   TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rsvps (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('yes', 'maybe', 'no')),
  PRIMARY KEY (meeting_id, user_id)
);
`);

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function newInviteCode() {
  // Code court et lisible, ex. "K7M2-9QXA"
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

// Valeurs initiales : secret JWT, code d'invitation, salons par défaut.
if (!getSetting('jwt_secret')) setSetting('jwt_secret', crypto.randomBytes(48).toString('hex'));
if (!getSetting('invite_code')) setSetting('invite_code', newInviteCode());

const channelCount = db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number };
if (channelCount.n === 0) {
  const insert = db.prepare(
    'INSERT INTO channels (id, name, description, admin_only, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(uid(), 'général', "Discussions de toute l'équipe", 0, now());
  insert.run(uid(), 'annonces', "Annonces officielles (publiées par les admins)", 1, now());
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'member';
  created_at: string;
}
