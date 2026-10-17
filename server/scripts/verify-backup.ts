// Test de restauration (à faire chaque mois) : npm run backup:verify [fichier.db]
// Ouvre la sauvegarde la plus récente en lecture seule, vérifie son intégrité et compte les données.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(import.meta.dirname, '../data');
const backups = path.join(dir, 'backups');
const file = process.argv[2] ?? fs.readdirSync(backups).filter((f) => /^linklink-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().at(-1);
if (!file) {
  console.error('Aucune sauvegarde trouvée.');
  process.exit(1);
}
const full = path.isAbsolute(file) ? file : path.join(backups, file);
const db = new DatabaseSync(full, { readOnly: true });
const check = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
console.log(`Sauvegarde : ${full}`);
console.log(`Intégrité  : ${check}`);
console.log(['users', 'projects', 'tasks', 'messages', 'files', 'meetings'].map((t) => `${t}=${count(t)}`).join('  '));
process.exit(check === 'ok' ? 0 : 1);
