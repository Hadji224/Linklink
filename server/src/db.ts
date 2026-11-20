import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { SCHEMA } from './schema.js';
import { translate } from './sqltranslate.js';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(import.meta.dirname, '../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
for (const d of [UPLOAD_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

export type Role = 'admin' | 'member' | 'guest';
export type Level = 'public' | 'internal' | 'confidential' | 'strict';

export const uid = (): string => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

// ─── Connexion PostgreSQL ───────────────────────────────────────────────────────────────────────
// COUNT(*) (int8) et SUM() (numeric) reviennent en texte par défaut : on veut des nombres, comme avec SQLite.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL manquante : indiquez l'adresse PostgreSQL (ex. postgresql://utilisateur:motdepasse@hote/base?sslmode=require).",
  );
  // Aide au diagnostic : uniquement les NOMS des variables qui y ressemblent (jamais leurs valeurs).
  const near = Object.keys(process.env).filter((k) => /(DATA|POSTGRES|PG|NEON|DB|SQL)/i.test(k));
  console.error(near.length ? `Variables au nom voisin trouvées : ${near.join(', ')} (le nom attendu est exactement DATABASE_URL).` : 'Aucune variable au nom voisin trouvée.');
  if (process.env.DATABASE_URL === '') console.error('DATABASE_URL existe mais sa valeur est vide.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000, // laisse le temps à une base Neon en veille de se réveiller
});
// Une connexion inactive coupée côté serveur (veille Neon) ne doit jamais faire tomber le processus.
pool.on('error', (e) => console.error('Connexion PostgreSQL inactive fermée :', e.message));

export type Row = Record<string, any>;
type Param = string | number | bigint | Buffer | string[] | null | undefined;

const txStore = new AsyncLocalStorage<pg.PoolClient>();
const runner = (): pg.Pool | pg.PoolClient => txStore.getStore() ?? pool;

async function query(sql: string, params: Param[]) {
  return runner().query(translate(sql), params as unknown[]);
}

/**
 * Accès aux données. `db.prepare(sql).get/all/run(...)` garde la forme de l'ancienne API SQLite, mais chaque appel
 * est asynchrone (à attendre avec `await`). Dans un `tx(...)`, tous les appels partagent automatiquement la même connexion.
 */
export const db = {
  async get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
    return (await query(sql, params)).rows[0] as T | undefined;
  },
  async all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await query(sql, params)).rows as T[];
  },
  async run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
    return { changes: (await query(sql, params)).rowCount ?? 0 };
  },
  /** Plusieurs instructions sans paramètres (schéma, migrations). */
  async exec(sql: string): Promise<void> {
    await runner().query(sql);
  },
  prepare(sql: string) {
    return {
      get: (...p: Param[]) => db.get(sql, ...p),
      all: (...p: Param[]) => db.all(sql, ...p),
      run: (...p: Param[]) => db.run(sql, ...p),
    };
  },
};

/** Verrou global des transactions : conserve la sérialisation des écritures que SQLite apportait naturellement. */
const TX_LOCK = 724_001;

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn(); // déjà dans une transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [TX_LOCK]);
    const out = await txStore.run(client, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const closeDb = () => pool.end();

// ─── Migrations ─────────────────────────────────────────────────────────────────────────────────
// Chaque migration n'est exécutée qu'une fois (table schema_migrations). Pour faire évoluer la base : ajouter une entrée.
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  { id: 1, name: 'schéma initial (spécification v1.2)', sql: SCHEMA },
  {
    id: 2,
    name: 'pièces jointes des salons : stockage temporaire en base (file_blobs) et expiration',
    sql: `
      CREATE TABLE IF NOT EXISTS file_blobs (
        key        TEXT PRIMARY KEY,
        data       BYTEA NOT NULL,
        size       INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      ALTER TABLE files ADD COLUMN IF NOT EXISTS expires_at TEXT;
      ALTER TABLE files ADD COLUMN IF NOT EXISTS purged_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expires_at) WHERE purged_at IS NULL AND expires_at IS NOT NULL;
    `,
  },
];

async function migrate() {
  await tx(async () => {
    await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set((await db.all<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await db.exec(m.sql);
      await db.run('INSERT INTO schema_migrations (id,name,applied_at) VALUES (?,?,?)', m.id, m.name, now());
    }
  });
}
await migrate();

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key))?.value;
}

export async function setSetting(key: string, value: string) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function newInviteCode() {
  // Format XXXX-XXXX, alphabet sans caractères ambigus.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

// Valeurs initiales : secret JWT (JWT_SECRET prioritaire), codes d'invitation, salons et dossiers par défaut.
// Créées sous verrou : plusieurs instances qui démarrent en même temps ne produisent pas de doublons.
let storedJwtSecret = '';
await tx(async () => {
  if (!(await getSetting('jwt_secret'))) await setSetting('jwt_secret', crypto.randomBytes(48).toString('hex'));
  if (!(await getSetting('invite_code'))) await setSetting('invite_code', newInviteCode());
  if (!(await getSetting('guest_invite_code'))) await setSetting('guest_invite_code', newInviteCode());
  storedJwtSecret = (await getSetting('jwt_secret')) as string;

  if (((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE kind='channel'")) as { n: number }).n === 0) {
    const sql = 'INSERT INTO channels (id,kind,name,description,admin_only,created_at) VALUES (?,?,?,?,?,?)';
    await db.run(sql, uid(), 'channel', 'général', "Discussions de toute l'équipe", 0, now());
    await db.run(sql, uid(), 'channel', 'annonces', 'Annonces internes (publiées par le PDG ou le Chargé de communication)', 1, now());
  }
  for (const [name, system] of [['Général', 'general'], ['Messages', 'messages']] as const) {
    if (!(await db.get('SELECT 1 FROM folders WHERE system = ?', system))) {
      await db.run('INSERT INTO folders (id,name,system,created_at) VALUES (?,?,?,?)', uid(), name, system, now());
    }
  }

  // Règles de relance par défaut (§10) : 1re relance 24 h, intervalle 48 h, escalade 120 h.
  for (const type of ['expense', 'archive', 'communication', 'account']) {
    await db.run('INSERT OR IGNORE INTO validation_rules (type,first_reminder_h,interval_h,escalation_h,updated_at) VALUES (?,?,?,?,?)', type, 24, 48, 120, now());
  }

  // Dossier « Infrastructure » : refuse les fichiers dont le nom évoque un secret (§11). Identifié par un réglage.
  const infra = await getSetting('infra_folder_id');
  if (!infra || !(await db.get('SELECT 1 FROM folders WHERE id = ?', infra))) {
    const id = uid();
    await db.run('INSERT INTO folders (id,name,created_at) VALUES (?,?,?)', id, 'Infrastructure', now());
    await setSetting('infra_folder_id', id);
  }
});

export const jwtSecret = () => process.env.JWT_SECRET || storedJwtSecret;

/** Si aucun PDG n'existe encore, l'administrateur technique (créateur de l'instance) reçoit la fonction PDG, de façon journalisée. */
export async function ensureBootstrapPdg() {
  const hasPdg = await db.get("SELECT 1 FROM user_functions f JOIN users u ON u.id = f.user_id WHERE f.fn = 'pdg' AND f.ended_at IS NULL AND u.suspended_at IS NULL");
  if (hasPdg) return;
  const admin = await db.get<{ id: string; name: string }>("SELECT id, name FROM users WHERE role = 'admin' AND suspended_at IS NULL ORDER BY created_at LIMIT 1");
  if (!admin) return;
  await db.run('INSERT INTO user_functions (id,user_id,fn,assigned_by,note,started_at) VALUES (?,?,?,?,?,?)', uid(), admin.id, 'pdg', null, "Amorçage : aucun PDG n'existait, l'administrateur technique tient la fonction par défaut", now());
  await db.run("INSERT INTO audit_log (id,category,user_id,user_name,action,entity,entity_id,summary,details,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    uid(), 'business', admin.id, admin.name, 'function', 'user', admin.id,
    `Fonction PDG attribuée à ${admin.name} par défaut (aucun PDG n'existait) ; à transférer dès qu'un fondateur est désigné.`, "Décision de cumul : amorçage de l'instance", now(),
  );
}
await ensureBootstrapPdg();

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  token_version: number;
  email_notif: number;
  suspended_at: string | null;
  consented_at: string | null;
  created_at: string;
}
