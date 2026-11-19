// Importe une ancienne base SQLite LinkLink (v1.2) dans PostgreSQL.
//
//   DATABASE_URL=postgresql://... npm run import:sqlite -w server -- chemin/vers/linklink.db [--uploads chemin/vers/uploads]
//
// - La base PostgreSQL cible doit être vide (aucun compte) : le script refuse sinon.
// - Les lignes sont copiées telles quelles (identifiants, dates, journaux immuables compris).
// - --uploads : si Google Drive est configuré, les fichiers déposés sont envoyés sur Drive et leur clé mise à jour.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { SCHEMA } from '../src/schema.js';

pg.types.setTypeParser(20, (v) => Number(v));
const args = process.argv.slice(2);
const uploadsIdx = args.indexOf('--uploads');
const uploadsDir = uploadsIdx >= 0 ? args.splice(uploadsIdx, 2)[1] : undefined;
const sqliteFile = args[0];
const url = process.env.DATABASE_URL;
if (!sqliteFile || !fs.existsSync(sqliteFile) || !url) {
  console.error('Usage : DATABASE_URL=... npm run import:sqlite -w server -- <linklink.db> [--uploads <dossier>]');
  process.exit(1);
}

// Parents d'abord (clés étrangères).
const ORDER = [
  'settings', 'users', 'projects', 'project_members', 'channels', 'channel_reads', 'folders', 'files', 'messages', 'tasks', 'subtasks',
  'task_comments', 'meetings', 'rsvps', 'notifications', 'activity_log', 'task_history', 'user_functions', 'mandates', 'absences', 'audit_log',
  'validation_rules', 'project_proposals', 'project_done_notes', 'task_dependencies', 'expenses', 'expense_versions', 'expense_approvals',
  'expense_payments', 'communications', 'communication_versions', 'communication_validations', 'emergency_holders', 'emergency_sessions',
  'admin_transfers', 'account_actions',
];

const src = new DatabaseSync(sqliteFile, { readOnly: true });
const version = (src.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (version < 4) {
  console.error(`Cette base est en version ${version} : lancez d'abord l'ancienne application (v1.2) pour la migrer, puis réessayez.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(724001)');
  const hasMigr = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
  if (!hasMigr) {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    await client.query(SCHEMA);
    await client.query("INSERT INTO schema_migrations (id,name,applied_at) VALUES (1,'schéma initial (spécification v1.2)',$1)", [new Date().toISOString()]);
  }
  const users = (await client.query('SELECT COUNT(*) AS n FROM users')).rows[0].n;
  if (users > 0) throw new Error(`La base PostgreSQL contient déjà ${users} compte(s) : import refusé pour ne rien écraser.`);
  // Les données initiales créées par un premier démarrage seraient en conflit avec celles importées.
  for (const t of ['channels', 'folders', 'settings', 'validation_rules']) await client.query(`DELETE FROM ${t}`);

  const report: string[] = [];
  for (const table of ORDER) {
    const cols = (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) continue;
    const target = new Set(
      (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_identity='NO'", [table])).rows.map((r) => r.column_name as string),
    );
    const use = cols.filter((c) => target.has(c));
    let rows = src.prepare(`SELECT ${use.map((c) => `"${c}"`).join(',')} FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    if (table === 'folders') {
      // dossiers imbriqués : un parent avant ses enfants
      const done = new Set<string>();
      const ordered: typeof rows = [];
      let pending = rows;
      while (pending.length) {
        const next = pending.filter((r) => r['parent_id'] == null || done.has(r['parent_id'] as string));
        if (!next.length) { ordered.push(...pending); break; }
        for (const r of next) done.add(r['id'] as string);
        ordered.push(...next);
        pending = pending.filter((r) => !next.includes(r));
      }
      rows = ordered;
    }
    const sql = `INSERT INTO ${table} (${use.map((c) => `"${c}"`).join(',')}) VALUES (${use.map((_, i) => `$${i + 1}`).join(',')})`;
    let ok = 0;
    let skipped = 0;
    for (const r of rows) {
      await client.query('SAVEPOINT row');
      try {
        await client.query(sql, use.map((c) => r[c] ?? null));
        await client.query('RELEASE SAVEPOINT row');
        ok++;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT row');
        skipped++;
        console.error(`  ligne ignorée dans ${table} (${(e as Error).message})`);
      }
    }
    if (rows.length) report.push(`${table.padEnd(26)} ${String(ok).padStart(6)} lignes${skipped ? `  (${skipped} ignorées)` : ''}`);
  }
  await client.query('COMMIT');
  console.log('Import terminé :\n' + report.join('\n'));
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Import annulé, la base PostgreSQL est intacte :', (e as Error).message);
  await client.end();
  process.exit(1);
}

// Fichiers déposés : vers Google Drive si configuré.
if (uploadsDir) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.log(`\nGoogle Drive n'est pas configuré : copiez le dossier « ${uploadsDir} » dans <DATA_DIR>/uploads du serveur pour garder les fichiers sur disque.`);
  } else {
    const { storage, TMP_DIR } = await import('../src/storage.js');
    const files = (await client.query("SELECT id, name, mime, stored_name FROM files WHERE stored_name NOT LIKE 'drive:%'")).rows as { id: string; name: string; mime: string; stored_name: string }[];
    let moved = 0;
    for (const f of files) {
      const p = path.join(uploadsDir, f.stored_name);
      if (!fs.existsSync(p)) { console.error(`  fichier absent : ${f.name} (${f.stored_name})`); continue; }
      const tmp = path.join(TMP_DIR, `import-${f.stored_name}`);
      fs.copyFileSync(p, tmp);
      const key = await storage.put(tmp, { name: f.name, mime: f.mime });
      await client.query('UPDATE files SET stored_name = $1 WHERE id = $2', [key, f.id]);
      moved++;
    }
    console.log(`\n${moved}/${files.length} fichiers envoyés sur Google Drive.`);
  }
}
await client.end();
process.exit(0);
