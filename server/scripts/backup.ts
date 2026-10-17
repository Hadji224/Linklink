// Sauvegarde manuelle : npm run backup  (la sauvegarde quotidienne automatique est déjà gérée par le serveur).
import { BACKUP_DIR } from '../src/db.js';
import { runBackup } from '../src/jobs.js';

runBackup();
console.log(`Sauvegarde de la base écrite dans ${BACKUP_DIR} (30 jours conservés).`);
console.log('Pensez aussi à copier le dossier « uploads » (fichiers déposés) vers un second emplacement.');
