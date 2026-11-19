// Sauvegarde logique de la base PostgreSQL : npm run backup -w server
// (Neon garde aussi un historique permettant de restaurer à un instant donné ; ceci est une copie à vous.)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquante.');
  process.exit(1);
}
const dir = path.resolve(process.env.BACKUP_DIR ?? path.join(import.meta.dirname, '../data/backups'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `linklink-${new Date().toISOString().slice(0, 10)}.dump`);

const dump = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, url], { stdio: 'inherit' });
if (dump.error) {
  console.error('pg_dump est introuvable : installez le client PostgreSQL (Termux : pkg install postgresql ; Debian/Ubuntu : apt install postgresql-client).');
  process.exit(1);
}
if (dump.status !== 0) process.exit(dump.status ?? 1);

const check = spawnSync('pg_restore', ['--list', file], { encoding: 'utf8' });
if (check.status !== 0 || !check.stdout.includes('TABLE DATA')) {
  console.error('Sauvegarde écrite mais illisible : ne comptez pas dessus.');
  process.exit(1);
}
console.log(`Sauvegarde vérifiée : ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} Ko)`);
console.log('Pour restaurer : pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" ' + file);
